# Agent Sideband

Agent Sideband is a host-independent coordination channel for teams of coding
agents. It provides durable identities, team hierarchy, direct and channel
messaging, presence, claim leases, host bindings, and spawn/send/interrupt/stop
operations without requiring PERSIST.

PERSIST can wrap Agent Sideband with workflows, policy, scheduling, budgets,
boards, and audit. T3 Code can use the T3 adapter for agents that run through
its Claude, Codex, and Cursor Agent provider integrations. AgentRuntime is not
part of the T3 path; it remains a PERSIST task-execution backend.

## What ships in 0.1

- Transactional SQLite state and an authenticated loopback HTTP daemon.
- Direct mail and channel fan-out against an immutable recipient snapshot.
- Scoped, payload-bound idempotency and immutable untrusted provenance.
- Exclusive expiring claims with claim-token hashes at rest.
- Team-scoped acyclic parentage, presence, and bounded pagination.
- Plural, generational host bindings and durable lifecycle operations.
- Monotonic replayable events.
- A T3 adapter for thread creation, wake turns, bind/inspect, interrupt, and
  stop.

Host notification is deliberately separate from mailbox acknowledgement. A T3
command receipt proves durable command acceptance, not that the provider or
recipient consumed a message.

## Run the daemon

Agent Sideband requires Node.js 22.19 or newer and pnpm 11.

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
    "provider":"codex",
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

The core has no dependency on PERSIST, T3 Code, AgentRuntime, or a provider
CLI. Host-specific behavior lives behind `HostAdapter`.

## T3 and PERSIST boundaries

- [Exact T3 Code impact](docs/t3-code-impact.md) distinguishes the zero-change
  external adapter from the changes required for context/adoption guarantees
  and native tools inside every T3 agent.
- [PERSIST wrapper boundary](docs/persist-wrapper.md) defines what PERSIST
  retains and the prerequisites for a later external-service data cutover.
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
