# Agent Sideband

Give your coding agents a way to work together.

Agent Sideband is a local coordination service with durable inboxes, direct
messages, team channels and reminders. Agents use its standalone MCP server;
your tools can use the HTTP API or TypeScript library. It does not require
PERSIST or a modified T3 Code installation.

A builder can hand a change to a reviewer, receive findings in its inbox, and
keep a lead informed through a shared channel. Messages survive disconnected
clients. Claim leases prevent two consumers from handling the same delivery;
acknowledgements record delivery, not completion of the assignment.

## Start locally

Use Node.js 22.19 or newer and pnpm 11. Install and run with the same Node
version: SQLite includes a native module built for that runtime.

```sh
git clone https://github.com/danieliser/agent-sideband.git
cd agent-sideband
pnpm install --frozen-lockfile
pnpm start
```

The daemon listens on `127.0.0.1:7341`. It creates
`.agent-sideband/sideband.sqlite` and a mode-`0600` operator token at
`.agent-sideband/sideband.token`. Keep that token for management; never give it
to an agent. Run one daemon per database. Back up the database before upgrading;
migrations are additive and checksummed, and older versions may not understand
newer data.

```sh
SIDEBAND_TOKEN="$(<.agent-sideband/sideband.token)"
curl -X PUT http://127.0.0.1:7341/v1/agents/reviewer \
  -H "Authorization: Bearer $SIDEBAND_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Reviewer"}'

curl -X POST http://127.0.0.1:7341/v1/messages \
  -H "Authorization: Bearer $SIDEBAND_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-review-1' \
  -d '{"target":{"type":"agent","id":"reviewer"},"correlationId":"demo-work-1","body":"Review the failing test.","messageClass":"request"}'
```

## Connect your agents

Each agent needs a separate scoped credential. Your launcher provisions one
through a host connector, writes it to a protected file and renews its lease.
Follow [identity setup](docs/identity.md). This explicit setup works with stock
MCP hosts; arbitrary stdio clients are not discovered automatically.

Configure each MCP host with its own credential file:

```json
{
  "mcpServers": {
    "agent-sideband": {
      "command": "node",
      "args": ["/absolute/path/to/agent-sideband/dist/mcp/cli.js"],
      "env": {
        "AGENT_SIDEBAND_URL": "http://127.0.0.1:7341",
        "AGENT_SIDEBAND_TOKEN_FILE": "/absolute/path/to/agent-credential.token"
      }
    }
  }
}
```

The stdio server lists 21 tools: 14 agent tools and 7 operator tools. Listing a
tool does not grant authority: agent credentials cannot execute operator
lifecycle controls. Messaging, inbox, claim/ack/release, presence, identity and
schedule tools act as the credential's agent. Models cannot choose a sender or
read another agent's inbox.

For an embedded host integration, `sidebandToolCatalog({ audiences: ["agent"] })`
and `invokeSidebandTool()` are exported from `agent-sideband/mcp`. The HTTP
catalog is `GET /v1/mcp/catalog?audience=agent` (or `operator`); the execution
bridge at `POST /v1/mcp/tools/:name/call` requires a provisioned agent credential.

## Schedule a reminder

An agent can ask for a reminder without naming itself:

```json
{
  "tool": "sideband_schedule_create",
  "arguments": {
    "idempotencyKey": "review-in-30m",
    "body": "Review the current checkpoint and continue.",
    "trigger": { "type": "after", "delay": { "value": 30, "unit": "minutes" } }
  }
}
```

Operators must supply an explicit `targetAgentId`. Delays, absolute times,
intervals, timezone-aware cron and named events are supported. Schedules and
occurrence history survive daemon restart. Unknown host outcomes are retained
for inspection rather than replayed as potentially duplicate work.

**Unattended wake needs a host adapter.** MCP alone is pull-only: agents see
messages when they check their inbox. A due schedule without a host binding
waits as `blocked` / `TARGET_UNBOUND`. With a binding, Sideband asks the host to
wake the target. Host acceptance does not prove a provider adopted the turn or
that the agent read the message. See [scheduling](docs/scheduling.md).

## Connect stock T3 Code

The external adapter uses T3's existing orchestration API:

```sh
AGENT_SIDEBAND_T3_URL=http://127.0.0.1:3000 \
AGENT_SIDEBAND_T3_TOKEN='replace-with-scoped-orchestration-token' \
pnpm start
```

It supports spawn, bind, visible wake, interrupt and stop. Spawns require an
existing project ID and a provider instance/model from T3's catalog. Spawned
threads need separate MCP configuration; spawning alone does not install tools.
Remote origins require HTTPS and `AGENT_SIDEBAND_T3_ALLOW_REMOTE=true`.

Default spawning binds the thread from its accepted host receipt and does not
wait for native T3 enrollment. Stock T3 supports visible wake delivery only.
New T3 threads default to `full-access`, matching the orchestration API;
set `metadata.runtimeMode` explicitly for a more restrictive execution policy.
Native T3 credentials, cards, context injection and automatic restart rebinding
are deferred; they are not prerequisites or promises of this release. See
[T3 integration boundaries](docs/t3-code-impact.md).

## Use as a library

```ts
import { AgentSideband, SqliteSidebandStore, T3HostAdapter } from "agent-sideband";

const store = SqliteSidebandStore.open("sideband.sqlite");
const adapter = new T3HostAdapter({
  baseUrl: "http://127.0.0.1:3000",
  token: process.env.T3_TOKEN!,
});
const sideband = new AgentSideband({ store, adapters: [adapter] });
```

`createSidebandDaemon()` composes identity, HTTP routes and the scheduler timer.
`buildAgentSidebandServer()` is the lower-level server for custom composition.
Core coordination stays independent of host adapters and workflow policy.

## Verification and limits

Run `pnpm check` for formatting, lint, types, tests and build. The packed-artifact
qualifier is `node --import tsx scripts/qualify-scheduler.ts <extracted-package>`;
it checks the released modules, MCP transport, migrations and a real timer.
[Verification notes](docs/verification.md) distinguish prior real-agent
messaging proof from current automated and packaged-runtime checks.

This is a local toolkit, not a hosted multi-tenant service. Keep it on loopback;
remote access needs your own authenticated proxy and tenant policy. Message
bodies are untrusted data, never authorization. No cross-provider soak,
exactly-once paid work, or provider-adoption guarantee is claimed.

MIT licensed.
