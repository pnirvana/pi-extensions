import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, DynamicBorder, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type HandoffMode = "fire_and_forget" | "subagent";

type AgentProfile = {
	id: string;
	label?: string;
	description: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	ephemeral?: boolean;
};

type AgentsConfig = { agents?: AgentProfile[] };

type HandoffRecord = {
	id: string;
	agentId: string;
	mode: HandoffMode;
	status: "running" | "done" | "error";
	task: string;
	cwd: string;
	parentSession?: string;
	childSession?: string;
	createdAt: string;
	updatedAt: string;
	error?: string;
};

type HandoffStore = { handoffs: HandoffRecord[] };

type HandoffCardDetails = {
	id: string;
	agentId: string;
	mode: HandoffMode;
	task: string;
	prompt: string;
	tools?: string[];
	ephemeral?: boolean;
	status: "started" | "completed" | "error" | "fire_and_forget";
	sessionFile?: string;
	error?: string;
};

type ActiveJob = {
	id: string;
	agentId: string;
	status: string;
	action: string;
	task: string;
	startedAt: number;
	updatedAt: number;
	childSession?: string;
};

const activeJobs = new Map<string, ActiveJob>();
const activeSessions = new Map<string, any>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();

const execFileAsync = promisify(execFile);

const DEFAULT_SYSTEM_PROMPT = `You are a focused specialist subagent. Complete only the delegated task. Be concise, concrete, and return findings or completed work clearly.`;
const DEFAULT_EPHEMERAL_TOOLS = ["read", "grep", "find", "ls"];
const ALLOWED_EPHEMERAL_TOOLS = new Set(["read", "grep", "find", "ls"]);

function configPaths(cwd: string): string[] {
	return [join(cwd, ".pi", "agents.json"), join(cwd, "agents.json"), join(homedir(), ".pi", "agent", "agents.json")];
}

function handoffStorePath(cwd: string): string {
	return join(cwd, ".pi", "handoffs.json");
}

function loadHandoffs(cwd: string): HandoffRecord[] {
	const path = handoffStorePath(cwd);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as HandoffStore;
		return parsed.handoffs ?? [];
	} catch {
		return [];
	}
}

function saveHandoff(cwd: string, record: HandoffRecord): void {
	const path = handoffStorePath(cwd);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const handoffs = loadHandoffs(cwd).filter((item) => item.id !== record.id);
	handoffs.unshift(record);
	writeFileSync(path, `${JSON.stringify({ handoffs: handoffs.slice(0, 100) }, null, 2)}\n`);
}

function loadAgents(cwd: string): AgentProfile[] {
	for (const path of configPaths(cwd)) {
		if (!existsSync(path)) continue;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentsConfig;
		return (parsed.agents ?? []).filter((agent) => agent.id && agent.description);
	}
	return [];
}

function agentSummary(agent: AgentProfile) {
	return {
		id: agent.id,
		label: agent.label ?? agent.id,
		description: agent.description,
		model: agent.model,
		tools: agent.tools ?? [],
		handoffModes: ["fire_and_forget", "subagent"] as HandoffMode[],
	};
}

function sanitizeAgentId(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "ephemeral-agent";
}

function sanitizeEphemeralTools(tools?: string[]): string[] {
	const requested = tools && tools.length > 0 ? tools : DEFAULT_EPHEMERAL_TOOLS;
	return requested.filter((tool) => ALLOWED_EPHEMERAL_TOOLS.has(tool));
}

function findAgent(cwd: string, id: string): AgentProfile | undefined {
	return loadAgents(cwd).find((agent) => agent.id === id);
}

function resolveAgent(cwd: string, agentId: string | undefined, definition?: Partial<AgentProfile>): AgentProfile | undefined {
	if (agentId) {
		const configured = findAgent(cwd, agentId);
		if (configured) return configured;
	}
	if (!definition?.description && !definition?.systemPrompt) return undefined;
	const id = sanitizeAgentId(definition.id ?? agentId ?? definition.label ?? "ephemeral-agent");
	return {
		id,
		label: definition.label ?? id,
		description: definition.description ?? `Ephemeral agent ${id}`,
		model: definition.model,
		tools: sanitizeEphemeralTools(definition.tools),
		systemPrompt:
			definition.systemPrompt ??
			`You are an ephemeral codebase exploration subagent. Explore the delegated aspect using read-only tools. Return a concise synthesis and do not include raw file contents unless essential.`,
		ephemeral: true,
	};
}

function buildHandoffPrompt(agent: AgentProfile, task: string, context?: string, files?: string[], expectedOutput?: string): string {
	return [
		`# Handoff to ${agent.label ?? agent.id}`,
		"",
		"## Agent role",
		agent.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
		"",
		"## Task",
		task,
		context ? `\n## Context\n${context}` : undefined,
		files && files.length > 0 ? `\n## Relevant files\n${files.map((file) => `- ${file}`).join("\n")}` : undefined,
		expectedOutput ? `\n## Expected output\n${expectedOutput}` : undefined,
		"",
		"When finished, summarize what you did or found, list changed files if any, and mention any follow-up work.",
	]
		.filter(Boolean)
		.join("\n");
}

function extractAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.filter((part: any) => part?.type === "text" && typeof part.text === "string")
				.map((part: any) => part.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "Subagent completed without a final text response.";
}

function renderActiveJobs(): string[] {
	const jobs = [...activeJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
	if (jobs.length === 0) return [];
	const visible = jobs.slice(0, 5).map((job) => {
		const ageSeconds = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
		return `● ${job.agentId} ${job.status}: ${truncateToWidth(job.action, 70)} (${ageSeconds}s)`;
	});
	if (jobs.length > visible.length) visible.push(`… +${jobs.length - visible.length} more subagents`);
	return [`Subagents (${jobs.length})`, ...visible];
}

function tryUi(ctx: any, fn: () => void) {
	try {
		fn();
	} catch {
		// The command ctx can become stale after session switch/reload while a
		// background subagent is still running. Ignore UI updates in that case;
		// persisted handoff records still get updated.
	}
}

function refreshActiveJobsWidget(ctx: any) {
	const lines = renderActiveJobs();
	tryUi(ctx, () => {
		ctx.ui.setWidget("agent-handoff-active", lines.length ? lines : undefined, { placement: "belowEditor" });
		ctx.ui.setStatus("agent-handoff-active", lines.length ? `subagents: ${activeJobs.size}` : undefined);
	});
}

function updateJob(ctx: any, jobId: string, status: string, action: string) {
	const job = activeJobs.get(jobId);
	if (!job) return;
	job.status = status;
	job.action = action;
	job.updatedAt = Date.now();
	refreshActiveJobsWidget(ctx);
}

function findActiveJob(selector?: string): ActiveJob | undefined {
	const jobs = [...activeJobs.values()];
	if (!selector || selector === "latest") return jobs.at(-1);
	return jobs.find((job) => job.id === selector || job.id.startsWith(selector) || job.agentId === selector);
}

async function cancelActiveJob(ctx: any, selector?: string): Promise<boolean> {
	const job = findActiveJob(selector);
	if (!job) return false;
	const session = activeSessions.get(job.id);
	finishJob(ctx, job.id, "error", "cancel requested");
	if (session) await session.abort();
	return true;
}

function finishJob(ctx: any, jobId: string, status: "done" | "error", action: string) {
	updateJob(ctx, jobId, status, action);
	const existing = cleanupTimers.get(jobId);
	if (existing) clearTimeout(existing);
	cleanupTimers.set(
		jobId,
		setTimeout(() => {
			activeJobs.delete(jobId);
			cleanupTimers.delete(jobId);
			refreshActiveJobsWidget(ctx);
		}, 15_000),
	);
}

function appendProgress(ctx: any, jobId: string, _agentId: string, status: string, events: string[], event: string) {
	events.push(event);
	updateJob(ctx, jobId, status, event);
}

function renderHandoffCard(details: HandoffCardDetails, theme: any, expanded = false) {
	const modeText = details.mode === "subagent" ? "subagent · master waits for result" : "fire-and-forget · user continues separately";
	const statusColor = details.status === "completed" ? "success" : details.status === "error" ? "error" : details.status === "fire_and_forget" ? "warning" : "accent";
	const lines = [
		theme.fg("accent", "╭─ Agent handoff ─────────────────"),
		`${theme.fg(statusColor, details.status.toUpperCase())}  ${modeText}`,
		`to: ${details.agentId}${details.ephemeral ? " (ephemeral)" : ""}`,
		`tools: ${(details.tools ?? []).join(", ") || "default"}`,
		`task: ${details.task}`,
		details.sessionFile ? `session: ${details.sessionFile}` : undefined,
		details.error ? theme.fg("error", `error: ${details.error}`) : undefined,
		theme.fg("accent", "╰─────────────────────────────────"),
	]
		.filter(Boolean)
		.join("\n");
	const prompt = expanded ? `\n\nPrompt sent to subagent:\n\n${details.prompt}` : "";
	return new Text(`${lines}${prompt}`, 0, 0);
}

function sendHandoffCard(pi: ExtensionAPI, details: HandoffCardDetails) {
	void pi.sendMessage({
		customType: "agent-handoff-card",
		content: `${details.mode} handoff to ${details.agentId}: ${details.task}`,
		display: true,
		details,
	});
}

function compactJson(value: unknown, maxLength = 160): string {
	if (value === undefined || value === null) return "";
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function runSubagent(pi: ExtensionAPI, ctx: any, agent: AgentProfile, prompt: string, task: string, emitChatCards = false): Promise<{ result: string; sessionFile?: string }> {
	if (!ctx.model) throw new Error("No model selected");
	const progressEvents: string[] = [];
	const now = new Date().toISOString();
	const record: HandoffRecord = {
		id: `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		agentId: agent.id,
		mode: "subagent",
		status: "running",
		task,
		cwd: ctx.cwd,
		parentSession: ctx.sessionManager.getSessionFile(),
		createdAt: now,
		updatedAt: now,
	};
	saveHandoff(ctx.cwd, record);
	activeJobs.set(record.id, {
		id: record.id,
		agentId: agent.id,
		status: "starting",
		action: "starting child session",
		task,
		startedAt: Date.now(),
		updatedAt: Date.now(),
	});
	refreshActiveJobsWidget(ctx);
	appendProgress(ctx, record.id, agent.id, "starting", progressEvents, "starting child session");

	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		systemPromptOverride: () => agent.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
	});
	await loader.reload();

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	});

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		tools: agent.tools,
		resourceLoader: loader,
		sessionManager: SessionManager.create(ctx.cwd),
		settingsManager,
		authStorage: ctx.authStorage,
		modelRegistry: ctx.modelRegistry,
	});
	if (emitChatCards) {
		sendHandoffCard(pi, {
			id: record.id,
			agentId: agent.id,
			mode: "subagent",
			task,
			prompt,
			tools: agent.tools,
			ephemeral: agent.ephemeral,
			status: "started",
			sessionFile: session.sessionFile,
		});
	}
	record.childSession = session.sessionFile;
	activeSessions.set(record.id, session);
	const activeJob = activeJobs.get(record.id);
	if (activeJob) activeJob.childSession = session.sessionFile;
	record.updatedAt = new Date().toISOString();
	saveHandoff(ctx.cwd, record);

	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "agent_start") {
			appendProgress(ctx, record.id, agent.id, "running", progressEvents, "agent started");
		} else if (event.type === "turn_start") {
			appendProgress(ctx, record.id, agent.id, "thinking", progressEvents, "thinking / planning next step");
		} else if (event.type === "tool_execution_start") {
			const args = compactJson(event.args);
			appendProgress(ctx, record.id, agent.id, "tool", progressEvents, `tool started: ${event.toolName ?? "unknown"}${args ? ` ${args}` : ""}`);
		} else if (event.type === "tool_execution_update") {
			const partial = compactJson(event.partialResult, 120);
			if (partial) appendProgress(ctx, record.id, agent.id, "tool", progressEvents, `tool update: ${event.toolName ?? "unknown"} ${partial}`);
		} else if (event.type === "tool_execution_end") {
			const result = compactJson(event.result, 160);
			appendProgress(ctx, record.id, agent.id, "running", progressEvents, `tool finished: ${event.toolName ?? "unknown"}${event.isError ? " (error)" : ""}${result ? ` ${result}` : ""}`);
		} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
			const delta = String(event.assistantMessageEvent.delta ?? "").replace(/\s+/g, " ").trim();
			if (delta) appendProgress(ctx, record.id, agent.id, "thinking", progressEvents, `thinking: ${delta.slice(0, 100)}`);
		} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			const delta = String(event.assistantMessageEvent.delta ?? "").replace(/\s+/g, " ").trim();
			if (delta) appendProgress(ctx, record.id, agent.id, "responding", progressEvents, `assistant: ${delta.slice(0, 100)}`);
		} else if (event.type === "agent_end") {
			appendProgress(ctx, record.id, agent.id, "finishing", progressEvents, "agent finished");
		}
	});

	try {
		await session.prompt(prompt);
		appendProgress(ctx, record.id, agent.id, "completed", progressEvents, "result ready");
		finishJob(ctx, record.id, "done", "result ready");
		if (emitChatCards) {
			sendHandoffCard(pi, {
				id: record.id,
				agentId: agent.id,
				mode: "subagent",
				task,
				prompt,
				tools: agent.tools,
				ephemeral: agent.ephemeral,
				status: "completed",
				sessionFile: session.sessionFile,
			});
		}
		record.status = "done";
		record.updatedAt = new Date().toISOString();
		saveHandoff(ctx.cwd, record);
		return { result: extractAssistantText(session.messages as any[]), sessionFile: session.sessionFile };
	} catch (error) {
		record.status = "error";
		record.error = error instanceof Error ? error.message : String(error);
		finishJob(ctx, record.id, "error", record.error);
		if (emitChatCards) {
			sendHandoffCard(pi, {
				id: record.id,
				agentId: agent.id,
				mode: "subagent",
				task,
				prompt,
				tools: agent.tools,
				ephemeral: agent.ephemeral,
				status: "error",
				sessionFile: session.sessionFile,
				error: record.error,
			});
		}
		record.updatedAt = new Date().toISOString();
		saveHandoff(ctx.cwd, record);
		throw error;
	} finally {
		unsubscribe();
		activeSessions.delete(record.id);
		session.dispose();
		tryUi(ctx, () => ctx.ui.setWidget("agent-handoff-detail", undefined));
	}
}

function findHandoff(cwd: string, selector?: string): HandoffRecord | undefined {
	const handoffs = loadHandoffs(cwd);
	if (!selector || selector === "latest") return handoffs.find((handoff) => handoff.childSession);
	return handoffs.find((handoff) => handoff.id === selector || handoff.id.startsWith(selector) || handoff.agentId === selector);
}

function buildAgentsReport(cwd: string): string {
	const agents = loadAgents(cwd);
	const handoffs = loadHandoffs(cwd).slice(0, 20);
	const agentText = agents
		.map((agent) => `${agent.id}: ${agent.label ?? agent.id}\n${agent.description}\nTools: ${(agent.tools ?? []).join(", ") || "default"}`)
		.join("\n\n");
	const handoffText = handoffs.length
		? handoffs
				.map((handoff) => `${handoff.status.toUpperCase()} ${handoff.agentId} ${handoff.mode}\nID: ${handoff.id}\nTask: ${handoff.task}\nSession: ${handoff.childSession ?? "pending"}\nUpdated: ${handoff.updatedAt}${handoff.error ? `\nError: ${handoff.error}` : ""}`)
				.join("\n\n")
		: "No handoffs recorded yet.";
	return `Configured agents\n=================\n\n${agentText || "No agents configured."}\n\nRecent handoffs\n===============\n\n${handoffText}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function openSessionInTmux(cwd: string, sessionFile: string, name: string): Promise<void> {
	const safeName = `pi:${name.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 40) || "agent"}`;
	const command = `cd ${shellQuote(cwd)} && pi --session ${shellQuote(sessionFile)}`;
	await execFileAsync("tmux", ["new-window", "-n", safeName, command]);
}

function getParentSession(ctx: any): string | undefined {
	const headerParent = (ctx.sessionManager.getHeader() as any).parentSession as string | undefined;
	if (headerParent) return headerParent;
	const currentSession = ctx.sessionManager.getSessionFile();
	if (!currentSession) return undefined;
	return loadHandoffs(ctx.cwd).find((handoff) => handoff.childSession === currentSession)?.parentSession;
}

type DashboardAction = { action: "switch" | "tmux" | "cancel"; session?: string; label: string; jobId?: string };

type DashboardItem = SelectItem & { jobId?: string; active?: boolean };

function dashboardItems(cwd: string, parentSession?: string): DashboardItem[] {
	const items: DashboardItem[] = [];
	if (parentSession) {
		items.push({
			value: parentSession,
			label: "← Parent/master session",
			description: parentSession,
		});
	}

	const active = [...activeJobs.values()].filter((job) => job.childSession).sort((a, b) => a.startedAt - b.startedAt);
	items.push(
		...active.map((job) => ({
			value: job.childSession!,
			label: `● ACTIVE ${job.agentId}: ${truncateToWidth(job.task, 80)}`,
			description: `${job.status}: ${truncateToWidth(job.action, 100)}`,
			jobId: job.id,
			active: true,
		})),
	);

	const activeSessions = new Set(active.map((job) => job.childSession));
	const handoffs = loadHandoffs(cwd)
		.filter((handoff) => handoff.childSession && !activeSessions.has(handoff.childSession))
		.slice(0, 20);
	items.push(
		...handoffs.map((handoff) => ({
			value: handoff.childSession!,
			label: `${handoff.status.toUpperCase()} ${handoff.agentId}: ${truncateToWidth(handoff.task, 80)}`,
			description: `${handoff.updatedAt} · ${handoff.id}`,
		})),
	);
	return items;
}

function parseAgentCommand(args: string): { agentId?: string; task?: string } {
	const trimmed = args.trim();
	const firstSpace = trimmed.indexOf(" ");
	if (!trimmed) return {};
	if (firstSpace < 0) return { agentId: trimmed };
	return { agentId: trimmed.slice(0, firstSpace), task: trimmed.slice(firstSpace + 1).trim() };
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer("agent-handoff-card", (message: any, options: any, theme: any) => {
		const details = message.details as HandoffCardDetails | undefined;
		if (!details) return new Text(message.content ?? "Agent handoff", 0, 0);
		return renderHandoffCard(details, theme, options.expanded);
	});

	pi.registerCommand("agents", {
		description: "Show configured handoff agents and recent handoffs",
		handler: async (_args, ctx) => {
			const agents = loadAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify("No agents configured. Create .pi/agents.json", "warning");
			}
			if (!ctx.hasUI) {
				ctx.ui.setEditorText(buildAgentsReport(ctx.cwd));
				return;
			}

			const selectedAction = await ctx.ui.custom<DashboardAction | undefined>((tui, theme, _kb, done) => {
				const container = new Container();
				const agents = loadAgents(ctx.cwd);
				const parentSession = getParentSession(ctx);
				const items = dashboardItems(ctx.cwd, parentSession);

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				const activeCount = [...activeJobs.values()].filter((job) => job.childSession).length;
				container.addChild(new Text(theme.fg("accent", theme.bold("Agent handoff dashboard")), 1, 0));
				container.addChild(new Text(theme.fg("dim", `${agents.length} configured agents · ${activeCount} active · ${items.length} selectable sessions`), 1, 0));

				if (items.length === 0) {
					container.addChild(new Text("No handoff sessions yet. Run /agent ask <agent-id> <task> first.", 1, 1));
				} else {
					let selectedItem = items[0];
					const currentSession = ctx.sessionManager.getSessionFile();
					const initialIndex = currentSession ? items.findIndex((item) => item.value === currentSession) : -1;
					const selectList = new SelectList(items, Math.min(items.length, 12), {
						selectedPrefix: (text: string) => theme.fg("accent", text),
						selectedText: (text: string) => theme.fg("accent", text),
						description: (text: string) => theme.fg("muted", text),
						scrollInfo: (text: string) => theme.fg("dim", text),
						noMatch: (text: string) => theme.fg("warning", text),
					});
					if (initialIndex >= 0) {
						selectList.setSelectedIndex(initialIndex);
						selectedItem = items[initialIndex];
					}
					selectList.onSelect = (item) => done({ action: "switch", session: item.value, label: item.label });
					selectList.onCancel = () => done(undefined);
					selectList.onSelectionChange = (item) => {
						selectedItem = item;
					};
					container.addChild(selectList);
					container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter switch • t tmux • c cancel active • esc close"), 1, 0));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							const dashboardItem = selectedItem as DashboardItem;
							if (data === "t" && selectedItem) {
								done({ action: "tmux", session: selectedItem.value, label: selectedItem.label });
								return;
							}
							if (data === "c" && dashboardItem.active && dashboardItem.jobId) {
								done({ action: "cancel", label: dashboardItem.label, jobId: dashboardItem.jobId });
								return;
							}
							selectList.handleInput?.(data);
							tui.requestRender();
						},
					};
				}

				container.addChild(new Text(theme.fg("dim", "esc close"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: () => done(undefined),
				};
			});

			if (selectedAction) {
				if (selectedAction.action === "cancel") {
					const cancelled = await cancelActiveJob(ctx, selectedAction.jobId);
					ctx.ui.notify(cancelled ? `Cancel requested: ${selectedAction.label}` : `No active subagent found: ${selectedAction.label}`, cancelled ? "info" : "warning");
					return;
				}
				if (selectedAction.session && activeJobs.size > 0 && [...activeJobs.values()].some((job) => job.childSession === selectedAction.session)) {
					ctx.ui.notify("That subagent is still running. Wait until it finishes before switching/opening to avoid concurrent session access.", "warning");
					return;
				}
				if (selectedAction.action === "tmux") {
					try {
						if (!selectedAction.session) return;
						await openSessionInTmux(ctx.cwd, selectedAction.session, selectedAction.label);
						ctx.ui.notify("Opened handoff session in tmux", "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to open tmux window: ${message}`, "error");
					}
				} else {
					if (!selectedAction.session) return;
					const result = await ctx.switchSession(selectedAction.session, {
						withSession: async (replacementCtx) => replacementCtx.ui.notify("Switched to handoff session", "info"),
					});
					if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
				}
			}
		},
	});

	pi.registerCommand("agent", {
		description: "Agent handoff commands: /agent new|ask|draft <agent-id> <task>, /agent cancel [job-id|agent-id|latest], /agent switch [handoff-id|agent-id|latest|parent], /agent tmux [handoff-id|agent-id|latest|parent]",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);
			if (subcommand === "cancel") {
				const selector = rest.join(" ").trim() || "latest";
				try {
					const cancelled = await cancelActiveJob(ctx, selector);
					ctx.ui.notify(cancelled ? `Cancel requested for ${selector}` : `No active subagent found for: ${selector}`, cancelled ? "info" : "warning");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to cancel subagent: ${message}`, "error");
				}
				return;
			}
			if (subcommand === "switch" || subcommand === "tmux") {
				const selector = rest.join(" ").trim() || "latest";
				let targetSession: string | undefined;
				let label = "handoff";
				if (selector === "parent") {
					targetSession = getParentSession(ctx);
					label = "parent";
				} else {
					const handoff = findHandoff(ctx.cwd, selector);
					targetSession = handoff?.childSession;
					label = handoff?.agentId ?? selector;
				}
				if (!targetSession) {
					ctx.ui.notify(`No session found for: ${selector}`, "error");
					return;
				}
				if (subcommand === "tmux") {
					try {
						await openSessionInTmux(ctx.cwd, targetSession, label);
						ctx.ui.notify(`Opened ${label} session in tmux`, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to open tmux window: ${message}`, "error");
					}
					return;
				}
				const result = await ctx.switchSession(targetSession, {
					withSession: async (replacementCtx) => {
						replacementCtx.ui.notify(`Switched to ${label} session`, "info");
					},
				});
				if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
				return;
			}

			const parsed = parseAgentCommand(rest.join(" "));
			if (!subcommand || !["new", "ask", "draft"].includes(subcommand) || !parsed.agentId || !parsed.task) {
				ctx.ui.notify("Usage: /agent new <agent-id> <task>, /agent ask <agent-id> <task>, /agent draft <agent-id> <task>, /agent cancel [job-id|agent-id|latest], /agent switch [handoff-id|agent-id|latest|parent], or /agent tmux [handoff-id|agent-id|latest|parent]", "error");
				return;
			}
			const agent = findAgent(ctx.cwd, parsed.agentId);
			if (!agent) {
				ctx.ui.notify(`Unknown agent: ${parsed.agentId}`, "error");
				return;
			}
			const task = parsed.task;
			const prompt = buildHandoffPrompt(agent, task);
			if (subcommand === "new") {
				const parentSession = ctx.sessionManager.getSessionFile();
				const result = await ctx.newSession({
					parentSession,
					withSession: async (replacementCtx) => {
						replacementCtx.ui.setEditorText(prompt);
						replacementCtx.ui.notify(`Handoff draft ready for ${agent.id}`, "info");
					},
				});
				if (result.cancelled) ctx.ui.notify("Handoff cancelled", "info");
				return;
			}
			ctx.ui.notify(`Started subagent ${agent.id} in background`, "info");
			void (async () => {
				try {
					const { result, sessionFile } = await runSubagent(pi, ctx, agent, prompt, task);
					const resultMessage = `Subagent ${agent.id} result${sessionFile ? ` (session: ${sessionFile})` : ""}:\n\n${result}`;
					if (subcommand === "draft") {
						tryUi(ctx, () => {
							ctx.ui.setEditorText(resultMessage);
							ctx.ui.notify(`Subagent ${agent.id} completed; result inserted into editor`, "info");
						});
					} else {
						await pi.sendUserMessage(resultMessage);
						tryUi(ctx, () => ctx.ui.notify(`Subagent ${agent.id} result sent to master`, "info"));
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					tryUi(ctx, () => ctx.ui.notify(`Subagent ${agent.id} failed: ${message}`, "error"));
				}
			})();
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List available specialist agents that can receive handoffs. The handoff_to_agent tool may also create ephemeral read-only agents with agentDefinition.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const agents = loadAgents(ctx.cwd).map(agentSummary);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								configuredAgents: agents,
								ephemeralAgents: {
									supported: true,
									defaultTools: DEFAULT_EPHEMERAL_TOOLS,
									allowedTools: [...ALLOWED_EPHEMERAL_TOOLS],
									note: "Use handoff_to_agent.agentDefinition for task-specific read-only exploration agents.",
								},
							},
							null,
							2,
						),
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "handoff_to_agent",
		label: "Agent Handoff",
		description: "Delegate work to a specialist agent. Use fire_and_forget for user-continuable sessions, subagent to wait for a result.",
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Configured agent id from list_agents, or an id for an ephemeral agent when agentDefinition is provided" })),
			agentDefinition: Type.Optional(
				Type.Object({
					id: Type.Optional(Type.String({ description: "Ephemeral agent id" })),
					label: Type.Optional(Type.String()),
					description: Type.String({ description: "What this ephemeral agent specializes in" }),
					tools: Type.Optional(Type.Array(Type.String({ description: "Read-only tools only: read, grep, find, ls" }))),
					systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for the ephemeral agent" })),
				}),
			),
			mode: Type.Union([Type.Literal("fire_and_forget"), Type.Literal("subagent")]),
			task: Type.String({ description: "Delegated task" }),
			context: Type.Optional(Type.String()),
			files: Type.Optional(Type.Array(Type.String())),
			expectedOutput: Type.Optional(Type.String()),
		}),
		renderCall(params, theme) {
			const agentId = params.agentId ?? params.agentDefinition?.id ?? params.agentDefinition?.label ?? "ephemeral-agent";
			return renderHandoffCard(
				{
					id: "pending",
					agentId,
					mode: params.mode,
					task: params.task,
					prompt: "Prompt will be generated when the handoff executes.",
					tools: params.agentDefinition?.tools,
					ephemeral: Boolean(params.agentDefinition),
					status: params.mode === "fire_and_forget" ? "fire_and_forget" : "started",
				},
				theme,
				false,
			);
		},
		renderResult(result, options, theme) {
			const details = (result as any).details;
			if (details?.handoffCard) return renderHandoffCard(details.handoffCard, theme, options.expanded);
			return new Text((result as any).content?.[0]?.text ?? "Handoff complete", 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = resolveAgent(ctx.cwd, params.agentId, params.agentDefinition);
			if (!agent) return { content: [{ type: "text", text: `Unknown agent: ${params.agentId ?? "<none>"}. Provide a configured agentId or an agentDefinition for an ephemeral read-only agent.` }], isError: true, details: {} };
			const prompt = buildHandoffPrompt(agent, params.task, params.context, params.files, params.expectedOutput);
			if (params.mode === "fire_and_forget") {
				const handoffCard: HandoffCardDetails = {
					id: `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					agentId: agent.id,
					mode: "fire_and_forget",
					task: params.task,
					prompt,
					tools: agent.tools,
					ephemeral: agent.ephemeral,
					status: "fire_and_forget",
				};
				sendHandoffCard(pi, handoffCard);
				return {
					content: [{ type: "text", text: `Fire-and-forget handoff prompt generated for ${agent.id}. Ask the user to run /agent new ${agent.id} <task> or start a new session with this prompt:\n\n${prompt}` }],
					details: { prompt, agentId: agent.id, mode: params.mode, handoffCard },
				};
			}
			const { result, sessionFile } = await runSubagent(pi, ctx, agent, prompt, params.task);
			const handoffCard: HandoffCardDetails = {
				id: `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				agentId: agent.id,
				mode: "subagent",
				task: params.task,
				prompt,
				tools: agent.tools,
				ephemeral: agent.ephemeral,
				status: "completed",
				sessionFile,
			};
			return { content: [{ type: "text", text: result }], details: { agentId: agent.id, mode: params.mode, sessionFile, handoffCard } };
		},
	});
}
