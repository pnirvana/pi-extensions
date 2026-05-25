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

const DEFAULT_SYSTEM_PROMPT = `You are a focused specialist subagent. Complete only the delegated task. Be concise, concrete, and return findings or completed work clearly.`;

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

function findAgent(cwd: string, id: string): AgentProfile | undefined {
	return loadAgents(cwd).find((agent) => agent.id === id);
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

function renderSubagentWidget(agentId: string, status: string, events: string[]): string[] {
	const recent = events.slice(-8);
	return [`Subagent ${agentId}: ${status}`, ...recent.map((event) => `  ${event}`)];
}

function appendProgress(ctx: any, agentId: string, status: string, events: string[], event: string) {
	events.push(event);
	ctx.ui.setStatus("agent-handoff", `subagent ${agentId}: ${status}`);
	ctx.ui.setWidget("agent-handoff", renderSubagentWidget(agentId, status, events), { placement: "belowEditor" });
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

async function runSubagent(ctx: any, agent: AgentProfile, prompt: string, task: string): Promise<{ result: string; sessionFile?: string }> {
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
	appendProgress(ctx, agent.id, "starting", progressEvents, "starting child session");

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
	record.childSession = session.sessionFile;
	record.updatedAt = new Date().toISOString();
	saveHandoff(ctx.cwd, record);

	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "agent_start") {
			appendProgress(ctx, agent.id, "running", progressEvents, "agent started");
		} else if (event.type === "turn_start") {
			appendProgress(ctx, agent.id, "thinking", progressEvents, "thinking / planning next step");
		} else if (event.type === "tool_execution_start") {
			const args = compactJson(event.args);
			appendProgress(ctx, agent.id, "tool", progressEvents, `tool started: ${event.toolName ?? "unknown"}${args ? ` ${args}` : ""}`);
		} else if (event.type === "tool_execution_update") {
			const partial = compactJson(event.partialResult, 120);
			if (partial) appendProgress(ctx, agent.id, "tool", progressEvents, `tool update: ${event.toolName ?? "unknown"} ${partial}`);
		} else if (event.type === "tool_execution_end") {
			const result = compactJson(event.result, 160);
			appendProgress(ctx, agent.id, "running", progressEvents, `tool finished: ${event.toolName ?? "unknown"}${event.isError ? " (error)" : ""}${result ? ` ${result}` : ""}`);
		} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
			const delta = String(event.assistantMessageEvent.delta ?? "").replace(/\s+/g, " ").trim();
			if (delta) appendProgress(ctx, agent.id, "thinking", progressEvents, `thinking: ${delta.slice(0, 100)}`);
		} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			const delta = String(event.assistantMessageEvent.delta ?? "").replace(/\s+/g, " ").trim();
			if (delta) appendProgress(ctx, agent.id, "responding", progressEvents, `assistant: ${delta.slice(0, 100)}`);
		} else if (event.type === "agent_end") {
			appendProgress(ctx, agent.id, "finishing", progressEvents, "agent finished");
		}
	});

	try {
		await session.prompt(prompt);
		appendProgress(ctx, agent.id, "completed", progressEvents, "result ready");
		record.status = "done";
		record.updatedAt = new Date().toISOString();
		saveHandoff(ctx.cwd, record);
		return { result: extractAssistantText(session.messages as any[]), sessionFile: session.sessionFile };
	} catch (error) {
		record.status = "error";
		record.error = error instanceof Error ? error.message : String(error);
		record.updatedAt = new Date().toISOString();
		saveHandoff(ctx.cwd, record);
		throw error;
	} finally {
		unsubscribe();
		session.dispose();
		ctx.ui.setStatus("agent-handoff", undefined);
		ctx.ui.setWidget("agent-handoff", undefined);
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

function getParentSession(ctx: any): string | undefined {
	const headerParent = (ctx.sessionManager.getHeader() as any).parentSession as string | undefined;
	if (headerParent) return headerParent;
	const currentSession = ctx.sessionManager.getSessionFile();
	if (!currentSession) return undefined;
	return loadHandoffs(ctx.cwd).find((handoff) => handoff.childSession === currentSession)?.parentSession;
}

function dashboardItems(cwd: string, parentSession?: string): SelectItem[] {
	const items: SelectItem[] = [];
	if (parentSession) {
		items.push({
			value: parentSession,
			label: "← Parent/master session",
			description: parentSession,
		});
	}
	const handoffs = loadHandoffs(cwd).filter((handoff) => handoff.childSession).slice(0, 20);
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

			const selectedSession = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
				const container = new Container();
				const agents = loadAgents(ctx.cwd);
				const parentSession = getParentSession(ctx);
				const items = dashboardItems(ctx.cwd, parentSession);

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Agent handoff dashboard")), 1, 0));
				container.addChild(new Text(theme.fg("dim", `${agents.length} configured agents · ${items.length} persisted handoff sessions`), 1, 0));

				if (items.length === 0) {
					container.addChild(new Text("No persisted handoff sessions yet. Run /agent ask <agent-id> <task> first.", 1, 1));
				} else {
					const selectList = new SelectList(items, Math.min(items.length, 12), {
						selectedPrefix: (text: string) => theme.fg("accent", text),
						selectedText: (text: string) => theme.fg("accent", text),
						description: (text: string) => theme.fg("muted", text),
						scrollInfo: (text: string) => theme.fg("dim", text),
						noMatch: (text: string) => theme.fg("warning", text),
					});
					selectList.onSelect = (item) => done(item.value);
					selectList.onCancel = () => done(undefined);
					container.addChild(selectList);
					container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter switch to session • esc close"), 1, 0));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
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
			}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } });

			if (selectedSession) {
				const result = await ctx.switchSession(selectedSession, {
					withSession: async (replacementCtx) => replacementCtx.ui.notify("Switched to handoff session", "info"),
				});
				if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
			}
		},
	});

	pi.registerCommand("agent", {
		description: "Agent handoff commands: /agent new|ask|draft <agent-id> <task>, /agent switch [handoff-id|agent-id|latest]",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);
			if (subcommand === "switch") {
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
				ctx.ui.notify("Usage: /agent new <agent-id> <task>, /agent ask <agent-id> <task>, /agent draft <agent-id> <task>, or /agent switch [handoff-id|agent-id|latest]", "error");
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
					const { result, sessionFile } = await runSubagent(ctx, agent, prompt, task);
					const resultMessage = `Subagent ${agent.id} result${sessionFile ? ` (session: ${sessionFile})` : ""}:\n\n${result}`;
					if (subcommand === "draft") {
						ctx.ui.setEditorText(resultMessage);
						ctx.ui.notify(`Subagent ${agent.id} completed; result inserted into editor`, "info");
					} else {
						await pi.sendUserMessage(resultMessage);
						ctx.ui.notify(`Subagent ${agent.id} result sent to master`, "info");
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Subagent ${agent.id} failed: ${message}`, "error");
				}
			})();
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List available specialist agents that can receive handoffs.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: JSON.stringify(loadAgents(ctx.cwd).map(agentSummary), null, 2) }], details: {} };
		},
	});

	pi.registerTool({
		name: "handoff_to_agent",
		label: "Handoff to Agent",
		description: "Delegate work to a specialist agent. Use fire_and_forget for user-continuable sessions, subagent to wait for a result.",
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id from list_agents" }),
			mode: Type.Union([Type.Literal("fire_and_forget"), Type.Literal("subagent")]),
			task: Type.String({ description: "Delegated task" }),
			context: Type.Optional(Type.String()),
			files: Type.Optional(Type.Array(Type.String())),
			expectedOutput: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = findAgent(ctx.cwd, params.agentId);
			if (!agent) return { content: [{ type: "text", text: `Unknown agent: ${params.agentId}` }], isError: true, details: {} };
			const prompt = buildHandoffPrompt(agent, params.task, params.context, params.files, params.expectedOutput);
			if (params.mode === "fire_and_forget") {
				return {
					content: [{ type: "text", text: `Fire-and-forget handoff prompt generated for ${agent.id}. Ask the user to run /agent new ${agent.id} <task> or start a new session with this prompt:\n\n${prompt}` }],
					details: { prompt, agentId: agent.id, mode: params.mode },
				};
			}
			const { result, sessionFile } = await runSubagent(ctx, agent, prompt, params.task);
			return { content: [{ type: "text", text: result }], details: { agentId: agent.id, mode: params.mode, sessionFile } };
		},
	});
}
