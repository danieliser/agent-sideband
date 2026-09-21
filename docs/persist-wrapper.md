# PERSIST wrapper boundary

PERSIST is a workflow and policy consumer of Agent Sideband. AgentRuntime is
not a Sideband dependency and is never used to run T3 agents.

```text
PERSIST workflow/task dispatch
  -> SessionManager
  -> selected AgentRuntime backend

PERSIST mailbox/fleet policy
  -> Agent Sideband
  -> T3 host adapter
  -> Claude, Codex, or Cursor Agent CLI managed by T3
```

## First compatibility slice

The first PERSIST integration is embedded and synchronous. It keeps PERSIST's
existing SQLite schema, numeric message IDs, HTTP routes, ability names, error
codes, envelope/page formats, and plugin registry keys while moving generic
coordination behavior behind a Sideband-compatible driver.

This avoids a premature two-database cutover. Today, task-completion messages
and their PERSIST delivery markers share a transaction; moving messages to a
separate daemon first would require an outbox, deterministic completion keys,
a migration ledger, and rollback plan.

PERSIST retains:

- workflow/task dispatch, retries, worktrees, policies, and runtime selection;
- boards, watches, schedules, budgets, escalation, and completion policy;
- authorization, abilities/MCP gateways, grants, and invocation telemetry;
- execution-profile agent configuration; and
- PERSIST-specific projections and cross-domain queries.

Sideband owns the reusable model for:

- agent identity, team-scoped hierarchy, channels, and presence;
- direct/channel messaging and recipient-snapshot fan-out;
- claims, leases, acknowledgements, and idempotency;
- host bindings and spawn/send/interrupt/stop operations; and
- host-neutral event replay and T3 orchestration mapping.

## External-service cutover prerequisites

PERSIST must not dual-write two delivery authorities. A later remote Sideband
cutover requires:

1. service endpoint and scoped credential configuration;
2. a PERSIST task-completion outbox with deterministic idempotency keys;
3. string external-ID migrations for references that are numeric today;
4. import ledger and high-water mark;
5. a bounded write freeze for the final cutover; and
6. read-only legacy tables retained for rollback for at least one release.

The embedded compatibility release intentionally does not perform this data
migration.
