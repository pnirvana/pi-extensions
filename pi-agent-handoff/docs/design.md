# pi-agent-handoff design

`pi-agent-handoff` is an extension-only implementation of agent handoff and subagent delegation for pi.

## Goals

- Let the master agent discover available specialist agents.
- Let the master agent delegate work to configured or ephemeral agents.
- Support user-started background subagents.
- Keep subagent progress visible without polluting the master context.
- Persist child sessions so users can inspect or continue them later.
- Provide dashboard controls for switching, tmux opening, and cancellation.

## Agent profiles

Configured agents are loaded from the first existing file in:

1. `<cwd>/.pi/agents.json`
2. `<cwd>/agents.json`
3. `~/.pi/agent/agents.json`

Agent profile fields:

```ts
type AgentProfile = {
  id: string;
  label?: string;
  description: string;
  model?: string; // provider/model or provider/model:thinking
  tools?: string[];
  systemPrompt?: string;
};
```

If `model` is omitted, the subagent uses the master's current model and thinking level. If present, the extension resolves it through pi's model registry. Supported format is `provider/model` with optional thinking suffix, e.g. `anthropic/claude-sonnet-4-5:low`.

Example config is in `examples/agents.json`.

## Handoff modes

### Fire-and-forget

Creates or returns a self-contained handoff prompt for a separate session. The user can continue that child session manually.

For command usage:

```text
/agent new <agent-id> <task>
```

For model/tool usage:

```json
{
  "mode": "fire_and_forget",
  "agentId": "implementer",
  "task": "..."
}
```

### Subagent

Runs a focused SDK-managed `AgentSession` using the selected agent's prompt and tools.

- Model-triggered subagents return a tool result to the master agent.
- User-command subagents run in the background and do not inject results into the master chat.
- `/agent draft` puts the result in the editor for review.
- `/agent new`, `/agent ask`, and `/agent draft` accept `--model <provider/model[:thinking]>` or `--model=<provider/model[:thinking]>` as a one-off override.

## Ephemeral agents

The master model can define task-specific agents inline using `agentDefinition` on `handoff_to_agent`.

Ephemeral agents are intended for read-only exploration tasks, for example: “explore order cancellation flow and return a concise synthesis”.

They are restricted to:

```text
read, grep, find, ls
```

If no tools are specified, those read-only tools are used by default.

A specific model can be selected per handoff either with top-level `model` or `agentDefinition.model`. Top-level `model` overrides the configured or ephemeral agent model for that single handoff.

## Persistence

Every subagent run creates a normal pi session via `SessionManager.create(ctx.cwd)`.

A handoff record is written to:

```text
<cwd>/.pi/handoffs.json
```

Records include:

- handoff id,
- agent id,
- mode,
- status,
- task,
- parent session,
- child session,
- timestamps,
- error if any.

The store keeps the 100 most recent handoffs. The dashboard shows up to 20 persisted handoffs, plus active jobs and parent row.

## Active job registry

The extension maintains in-memory maps for running subagents:

- `activeJobs`: compact metadata for status/dashboard display.
- `activeSessions`: live `AgentSession` objects used for cancellation.

The compact status widget below the editor displays all active/recent jobs as one line per subagent. Completed/error jobs remain briefly visible, then are removed.

## Dashboard

`/agents` opens an inline dashboard using pi TUI components (`SelectList`, `DynamicBorder`). It is not an overlay.

Rows include:

1. parent/master session when available,
2. active subagents,
3. recent persisted handoffs.

Actions:

- `↑↓`: navigate,
- `Enter`: switch to selected completed/persisted session,
- `t`: open selected session in tmux,
- `c`: cancel selected active subagent,
- `Esc`: close.

Running subagents cannot be switched into as live sessions with the current pi extension API. Switching/opening running persisted sessions is guarded to avoid concurrent access. Cancellation is supported.

## Handoff cards

The `handoff_to_agent` tool has custom `renderCall` and `renderResult` renderers so model-triggered handoffs appear as distinct “Agent handoff” cards instead of generic tool output.

Cards show:

- handoff mode,
- whether the master waits for the result,
- target agent,
- ephemeral marker,
- tools,
- task,
- child session path when available,
- error if any.

Expanded cards include the prompt sent to the subagent.

## Tmux

`/agent tmux [handoff-id|agent-id|latest|parent]` opens a persisted handoff session in a new tmux window:

```bash
cd <cwd> && pi --session <session-file>
```

This is intended for completed/persisted sessions. True live attachment to an in-process running SDK subagent would require pi core support for multi-session TUI attachment or a different process/RPC architecture.

## Cancellation

Running subagents can be cancelled by:

```text
/agent cancel [job-id|agent-id|latest]
```

or from `/agents` with `c` on an active row.

Cancellation calls `session.abort()` on the live child `AgentSession` and updates the active status/dashboard.

## Known limitations

- Live switching into an actively running SDK subagent is not supported safely.
- The dashboard is inline and interactive but not a full multi-session chat UI.
- Command-started subagent results are stored, not automatically sent to master, to avoid confusing the master with user-managed jobs.
- Ephemeral agents are read-only only.
