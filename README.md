# pi-agent-handoff

Agent handoff and subagent delegation extension for [pi](https://pi.dev).

## Install / test locally

```bash
cd ~/Dev/pi-extensions/pi-agent-handoff
npm install
pi -e ./extensions/agent-handoff.ts
```

Or install as a pi package from git once published:

```bash
pi install git:github.com/<you>/pi-agent-handoff
```

## Configure agents

Copy the example config into a project:

```bash
mkdir -p .pi
cp ~/Dev/pi-extensions/pi-agent-handoff/examples/agents.json .pi/agents.json
```

## Commands

```text
/agents
/agent new <agent-id> <task>
/agent ask <agent-id> <task>
/agent draft <agent-id> <task>
/agent switch [handoff-id|agent-id|latest|parent]
/agent tmux [handoff-id|agent-id|latest|parent]
```

`/agents` opens a read-only dashboard overlay with configured agents and recent handoffs. Subagent runs are persisted as normal pi sessions and recorded in `.pi/handoffs.json`.
`/agent switch` switches the active pi TUI to a persisted child handoff session; `/agent switch parent` switches back when the current session has parent metadata.
`/agent tmux` opens a persisted handoff session in a new tmux window.

`/agent ask` starts the subagent in the background and sends the completed result back to the master conversation.
`/agent draft` starts the subagent in the background and leaves the completed result in the editor for review/editing.

## Tools exposed to the model

- `list_agents`: list available specialist agents.
- `handoff_to_agent`: delegate to an agent in `fire_and_forget` or `subagent` mode.

See `docs/design.md` for details.
