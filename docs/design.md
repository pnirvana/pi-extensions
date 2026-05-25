# pi-agent-handoff design

Phase 1 provides an extension-only implementation of agent handoff.

## Features

- Discover agent profiles from `agents.json`.
- `/agents` command to list configured agents and recent handoffs.
- `/agent new <agent-id> <task>` creates a fire-and-forget session draft.
- `/agent ask <agent-id> <task>` runs a subagent-style single-shot call and inserts the result into the editor.
- `list_agents` tool for the active model.
- `handoff_to_agent` tool for the active model.

## Agent config lookup

The extension searches:

1. `<cwd>/.pi/agents.json`
2. `<cwd>/agents.json`
3. `~/.pi/agent/agents.json`

Example config is in `examples/agents.json`.

## Modes

### Fire and forget

Creates a new session with a self-contained handoff prompt in the editor. The user can review/edit/submit it.

### Subagent

Phase 1 runs a focused SDK-managed `AgentSession` using the selected profile's system prompt, tools, and task. The child session is persisted as a normal pi session and recorded in `.pi/handoffs.json`. Progress is mirrored into the master TUI as a compact widget.
