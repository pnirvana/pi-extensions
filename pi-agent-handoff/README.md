# pi-agent-handoff

Agent handoff and subagent delegation extension for [pi](https://pi.dev).

This extension lets the current agent discover specialist agents, delegate work to them, run tool-enabled subagents, and keep subagent work visible and manageable from the TUI.

## Install

From this repository:

```bash
pi install git:github.com/pnirvana/pi-extensions
```

Update an installed copy:

```bash
pi update git:github.com/pnirvana/pi-extensions
```

Then in a running pi session:

```text
/reload
```

## Local development

```bash
cd ~/Dev/pi-extensions/pi-agent-handoff
npm install
pi -e ./extensions/agent-handoff.ts
```

## Configure agents

Copy the example config into a project:

```bash
mkdir -p .pi
cp ~/Dev/pi-extensions/pi-agent-handoff/examples/agents.json .pi/agents.json
```

The extension searches for agents in:

1. `<cwd>/.pi/agents.json`
2. `<cwd>/agents.json`
3. `~/.pi/agent/agents.json`

## Commands

```text
/agents
/agent help
/agent new <agent-id> <task>
/agent ask <agent-id> <task>
/agent draft <agent-id> <task>
/agent cancel [job-id|agent-id|latest]
/agent switch [handoff-id|agent-id|latest|parent]
/agent tmux [handoff-id|agent-id|latest|parent]
```

### `/agents`

Opens an inline dashboard, similar to pi's built-in interactive views. It lists:

- parent/master session when available,
- active running subagents first,
- recent persisted handoff sessions.

Actions:

- `↑↓` navigate,
- `Enter` switch to a completed/persisted session,
- `t` open selected session in tmux,
- `c` cancel an active subagent,
- `Esc` close.

The dashboard currently shows up to 20 persisted handoffs. `.pi/handoffs.json` stores up to 100 recent handoffs.

### `/agent ask`

Starts a background subagent and stores its result in the persisted child session. It does **not** inject the result into the master conversation.

### `/agent draft`

Starts a background subagent and puts the final result in the editor for review/editing.

### `/agent new`

Creates a new fire-and-forget handoff session draft for the user to continue manually.

### `/agent cancel`

Cancels a running subagent by job id, agent id, or `latest`.

### `/agent switch` and `/agent tmux`

Switch to or open a persisted handoff session. Use `parent` from a child session to go back to the parent/master session when available.

## Model tools

The extension exposes two tools to the master agent:

- `list_agents`: list configured agents and explain ephemeral-agent support.
- `handoff_to_agent`: delegate to a configured agent or create an ephemeral task-specific read-only agent.

`handoff_to_agent` modes:

- `subagent`: the master waits for the subagent result and incorporates the tool result.
- `fire_and_forget`: generates a handoff prompt/session path for separate continuation.

### Ephemeral agents

The master can create task-specific read-only agents with `agentDefinition`. This is useful for codebase exploration without polluting the master context with raw file contents.

Ephemeral agents are restricted to read-only tools:

```text
read, grep, find, ls
```

## TUI behavior

- Running subagents are shown in a compact status widget below the editor.
- Tool-triggered handoffs render as distinct handoff cards instead of generic tool output.
- Subagent sessions are persisted as normal pi sessions and recorded in `.pi/handoffs.json`.

See `docs/design.md` for implementation details.
