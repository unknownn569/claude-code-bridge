# Claude Code Bridge

An MCP server that lets a remote agent (for example an ML AI Code session) start, follow, steer and interrupt **Claude Code** sessions running on this machine.

```
ML AI Code (you type here)
   │  MCP over HTTP, Authorization: Bearer BRIDGE_TOKEN
   ▼
bridge server (this project, src/server.ts)
   │  Claude Agent SDK (streaming-input query)
   ▼
Claude Code sessions on this machine (uses your Claude Code login, or ANTHROPIC_API_KEY if set)
```

## Tools exposed

| Tool | What it does |
| --- | --- |
| `start_task` | Starts a Claude Code session, returns its bridge session id immediately. |
| `get_output` | New messages since a cursor, plus status, spend and pending approvals. |
| `send_message` | Follow-up: queued into the open session, or resumes it. |
| `interrupt` | Stops the current turn; the session stays open. |
| `list_sessions` | Everything the bridge knows, with status and cost. |
| `list_pending_approvals` | Tool calls waiting for permission. |
| `resolve_approval` | Allow or deny a pending tool call. |

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in:
   - `BRIDGE_TOKEN` — a long random string the MCP client must send.
   - `ANTHROPIC_API_KEY` — **optional**. Leave it empty to use the Claude Code
     login on this machine: run `claude` once and sign in with your Claude
     subscription (Pro/Max/Team). Set it only if you prefer API-key billing.
   - Optional: `BRIDGE_WORKDIR`, `BRIDGE_MODEL`, `BRIDGE_MAX_TURNS`, `BRIDGE_MAX_BUDGET_USD`, `PORT`.
3. `npm start` — refuses to start without the token.

## Connecting from an MCP client

Add a streamable-HTTP MCP server at `http://<this-host>:8080/mcp` with header `Authorization: Bearer <BRIDGE_TOKEN>`, then verify with `BASE=http://<host>:8080 BRIDGE_TOKEN=... npm run smoke`.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

Tests use a scripted fake of the Agent SDK query, so they run without an API key.
