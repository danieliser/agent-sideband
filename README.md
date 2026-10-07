# Agent Sideband

Give your coding agents a way to work together.

Agent Sideband lets agents send each other messages, share updates with a
team, and hand off work through a durable inbox. With a host adapter, they can
also start another agent, wake it with a message, or stop its session.

If you spend time copying findings between agent chats, relaying a reviewer's
feedback to a builder, or checking which agent picked up a request, Sideband
provides the communication tools to make those handoffs part of your workflow.
It includes a standalone MCP server and a built-in T3 Code adapter.

## How it can improve your workflow

### Give builders and reviewers a direct line

Have a builder send a reviewer the change to inspect, the tests it ran, and
the questions it needs answered. The reviewer can send findings back to the
builder and keep the lead informed through a shared channel. You can focus on
decisions instead of carrying messages between chats.

### Split a project into focused assignments

A lead can start specialist agents through a configured host adapter, send
each a bounded assignment, and collect their replies under a shared topic.
For example, one agent can investigate a bug while another reviews the
affected API. Direct messages keep individual requests focused; channels let
the team share findings that affect everyone.

### Make handoffs easier to recover

Messages stay in a local database instead of existing only in a live chat.
An agent can claim an inbox message while handling its delivery, then
acknowledge it. If that consumer disappears before acknowledging, the claim
expires and the message becomes available again.

This helps recover message delivery after an interruption. An acknowledgement
records delivery; agents should send a separate completion message when the
actual assignment is finished.

### Keep a record of coordination

Presence signals and an ordered event history give your tools a way to show
recent agent activity and trace handoffs. You can build a status view or
investigate whether a message was sent, claimed, or acknowledged without
piecing everything together from separate chat windows. Presence reflects
reported activity, not a guarantee that an agent is currently working.

## A workflow you can build

Imagine asking a lead agent to fix a regression and get an independent review:

1. The lead starts a builder and reviewer through the T3 adapter.
2. The builder makes the change, runs the relevant checks, and sends the
   reviewer a message with the commit and review questions.
3. The reviewer reads its inbox and sends findings back. The lead receives a
   completion update when the review is finished.
4. You review the result and decide what ships.

Sideband supplies the messaging and session-control tools for that workflow.
Your agent instructions or application decide who does each step, when to
check inboxes, and how to handle failures. Agents need MCP access and suitable
credentials; spawning an agent alone does not automatically configure them.

## Where it fits

Use the **MCP server** to give agents communication tools in an MCP-capable
host. Use the **HTTP API or TypeScript library** to add the same coordination
to your own application. Use the **T3 Code adapter** when you also want to
create, wake, interrupt, or stop T3 agent sessions.

The coordination core works independently of T3. Other hosts can integrate
through `HostAdapter`. Your host continues to run the agents and manage their
workspaces; your workflow controls assignments, approvals, and completion.

Sending a message stores it in an inbox. Waking its recipient is a separate
operation, and a host accepting that wake does not prove the agent has read
the message. That distinction helps your workflow report what has actually
happened.

## What is ready today?

Sideband is an early integration toolkit, not yet a one-command autonomous
team. Two live agents have exchanged and acknowledged messages through its
standalone MCP server using separate credentials. A delayed external trigger
has also resumed an agent to read and answer a queued message.

There is **no built-in scheduler**. Your host or application must schedule
wakes, configure agent credentials, and decide when agents check their inboxes.
The packaged daemon's shared `operator` credential is for a local tryout, not
distinct team members. See the [verification report](docs/verification.md) for
exactly what was exercised and what remains unverified.

## Try it locally

Start with the daemon below, then [connect your MCP host](#connect-an-mcp-host)
to give an agent access to Sideband tools. The default setup uses one local
`operator` identity. Separate agent identities require an authenticator that
maps each agent's credential to its identity; the library supports this, but
the packaged daemon does not provision those credentials for you.

## Run the daemon

Agent Sideband requires Node.js 22.19 or newer and pnpm 11.
Use the same Node version to install dependencies and run the daemon: SQLite
includes a native module that must match that runtime.

```sh
git clone https://github.com/danieliser/agent-sideband.git
cd agent-sideband
pnpm install
pnpm start
```

The daemon binds to `127.0.0.1:7341`, creates `.agent-sideband/sideband.sqlite`,
and writes a mode-`0600` bearer token to `.agent-sideband/sideband.token`.

```sh
SIDEBAND_TOKEN="$(<.agent-sideband/sideband.token)"

curl -X PUT http://127.0.0.1:7341/v1/agents/reviewer \
  -H "Authorization: Bearer $SIDEBAND_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Reviewer"}'

curl -X POST http://127.0.0.1:7341/v1/messages \
  -H "Authorization: Bearer $SIDEBAND_TOKEN" \
  -H 'Idempotency-Key: demo-message-1' \
  -H 'Content-Type: application/json' \
  -d '{
    "target":{"type":"agent","id":"reviewer"},
    "correlationId":"demo-work-1",
    "body":"Review the failing test.",
    "messageClass":"request"
  }'
```

The packaged daemon is a single trusted-local-operator mode. Library consumers
can provide their own `SidebandAuthenticator` to issue separate agent-bound
credentials and narrower grants. Do not expose the daemon to a LAN or the
Internet without a proper identity-aware reverse proxy and tenant policy.
Run only one daemon process against a given SQLite database. Startup recovery
intentionally marks an interrupted host dispatch `indeterminate` instead of
risking duplicate paid work.

## Connect an MCP host

Start the daemon, then configure your MCP-capable host to launch the bundled
stdio server. For the source checkout above, replace both paths with absolute
paths on your machine:

```json
{
  "mcpServers": {
    "agent-sideband": {
      "command": "node",
      "args": ["/absolute/path/to/agent-sideband/dist/mcp/cli.js"],
      "env": {
        "AGENT_SIDEBAND_URL": "http://127.0.0.1:7341",
        "AGENT_SIDEBAND_TOKEN_FILE": "/absolute/path/to/.agent-sideband/sideband.token"
      }
    }
  }
}
```

The MCP process is only a credentialed stdio client for the daemon. It does
not accept a sender identity in message tools, and inbox claim, acknowledge,
release, and presence tools use the agent identity bound to the credential.
Library consumers can therefore issue one narrowly scoped credential per
agent. The packaged local daemon uses its single `operator` identity.

No T3 Code change is needed for this direct MCP setup. T3 changes are only
needed if T3 itself should provision Sideband tools and credentials
automatically for every managed thread.

## Connect T3 Code

Provide a scoped T3 orchestration credential and the loopback T3 environment
origin:

```sh
AGENT_SIDEBAND_T3_URL=http://127.0.0.1:3000 \
AGENT_SIDEBAND_T3_TOKEN='replace-with-scoped-token' \
pnpm start
```

Remote T3 origins are denied by default. They require HTTPS and an explicit
`AGENT_SIDEBAND_T3_ALLOW_REMOTE=true` opt-in.

Spawning requires an existing T3 project, a discovered provider `instanceId`,
and a model from that provider's catalog:

```sh
curl -X POST http://127.0.0.1:7341/v1/agents/reviewer/spawn \
  -H "Authorization: Bearer $SIDEBAND_TOKEN" \
  -H 'Idempotency-Key: demo-spawn-1' \
  -H 'Content-Type: application/json' \
  -d '{
    "adapter":"t3",
    "provider":"replace-with-provider-instance-id",
    "prompt":"Review the current change and report risks.",
    "metadata":{
      "projectId":"replace-with-project-id",
      "model":"replace-with-provider-model"
    }
  }'
```

`provider` is the configured T3 provider instance ID, not a driver name that
Sideband may assume. The adapter reports successful dispatch as `accepted` with
provider adoption unconfirmed. `context` and `both` modes fail closed because
current T3 does not expose a verified cross-provider context-only contract.
The adapter currently defaults new T3 threads to `full-access`, matching T3's
existing orchestration behavior; set `metadata.runtimeMode` explicitly when a
more restrictive execution policy is required.

## Use as a library

```ts
import { AgentSideband, SqliteSidebandStore, T3HostAdapter } from "agent-sideband";

const store = SqliteSidebandStore.open("sideband.sqlite");
const t3 = new T3HostAdapter({
  baseUrl: "http://127.0.0.1:3000",
  token: process.env.T3_TOKEN!,
});
const sideband = new AgentSideband({ store, adapters: [t3] });
```

The coordination core does not depend on T3 Code. T3-specific behavior is
isolated in the built-in `T3HostAdapter`.

## Under the hood

- SQLite stores identities, teams, messages, delivery claims, and events.
- Direct messages and channels support individual handoffs and team updates.
- Expiring claims let one consumer handle a recipient's message at a time.
- Idempotency keys make exact retries safe and reject changed requests that
  reuse the same key.
- Credentials establish sender identity; message content never grants
  authority.
- Host bindings connect an agent identity to its external sessions.
- Thirteen MCP tools expose messaging, inbox handling, presence, event replay,
  and host lifecycle operations.

## T3 boundary

- [Exact T3 Code impact](docs/t3-code-impact.md) distinguishes the zero-change
  external adapter and direct MCP path from optional T3-managed provisioning
  and stronger context/adoption guarantees.
- [Architecture](docs/architecture.md) covers ownership, delivery states, and
  trust.

## Development

```sh
pnpm install
pnpm check
pnpm audit --audit-level high
npm pack --dry-run
```

The GitHub Actions matrix runs the same checks on Node 22, 24, and 26.
