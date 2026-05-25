import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
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

const DEFAULT_SYSTEM_PROMPT = `You are a focused specialist subagent. Complete only the delegated task. Be concise, concrete, and return findings or completed work clearly.`;

function configPaths(cwd: string): string[] {
	return [join(cwd, ".pi", "agents.json"), join(cwd, "agents.json"), join(homedir(), ".pi", "agent", "agents.json")];
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

async function runSubagent(ctx: any, agent: AgentProfile, prompt: string): Promise<string> {
	if (!ctx.model) throw new Error("No model selected");

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
		sessionManager: SessionManager.inMemory(ctx.cwd),
		settingsManager,
		authStorage: ctx.authStorage,
		modelRegistry: ctx.modelRegistry,
	});

	try {
		await session.prompt(prompt);
		return extractAssistantText(session.messages as any[]);
	} finally {
		session.dispose();
	}
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
		description: "List configured handoff agents",
		handler: async (_args, ctx) => {
			const agents = loadAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify("No agents configured. Create .pi/agents.json", "warning");
				return;
			}
			ctx.ui.setEditorText(
				agents
					.map((agent) => `${agent.id}: ${agent.label ?? agent.id}\n${agent.description}\nTools: ${(agent.tools ?? []).join(", ") || "default"}`)
					.join("\n\n"),
			);
		},
	});

	pi.registerCommand("agent", {
		description: "Agent handoff commands: /agent new <agent-id> <task>, /agent ask <agent-id> <task>, /agent draft <agent-id> <task>",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);
			const parsed = parseAgentCommand(rest.join(" "));
			if (!subcommand || !["new", "ask", "draft"].includes(subcommand) || !parsed.agentId || !parsed.task) {
				ctx.ui.notify("Usage: /agent new <agent-id> <task>, /agent ask <agent-id> <task>, or /agent draft <agent-id> <task>", "error");
				return;
			}
			const agent = findAgent(ctx.cwd, parsed.agentId);
			if (!agent) {
				ctx.ui.notify(`Unknown agent: ${parsed.agentId}`, "error");
				return;
			}
			const prompt = buildHandoffPrompt(agent, parsed.task);
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
			try {
				ctx.ui.notify(`Running subagent ${agent.id}...`, "info");
				const result = await runSubagent(ctx, agent, prompt);
				const resultMessage = `Subagent ${agent.id} result:\n\n${result}`;
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
			const result = await runSubagent(ctx, agent, prompt);
			return { content: [{ type: "text", text: result }], details: { agentId: agent.id, mode: params.mode } };
		},
	});
}
