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
```

`/agent ask` sends the completed subagent result back to the master conversation.
`/agent draft` leaves the completed subagent result in the editor for review/editing.

## Tools exposed to the model

- `list_agents`: list available specialist agents.
- `handoff_to_agent`: delegate to an agent in `fire_and_forget` or `subagent` mode.

See `docs/design.md` for details.
