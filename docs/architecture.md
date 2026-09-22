# Architecture

Agent Sideband is a modular monolith with a durable core and optional host
adapters.

```text
Clients and hosts
  ├── standalone MCP server
  ├── T3 Code adapter
  └── other agent hosts
          │
          ▼
Agent Sideband API
  ├── identities and teams
  ├── direct and channel messaging
  ├── claim leases and acknowledgements
  ├── presence and bindings
  ├── spawn, deliver, interrupt, and stop commands
  └── durable replayable event log (polling in 0.2)
          │
          ▼
        SQLite
```

## Ownership

Agent Sideband owns coordination state. A host continues to own its native
project, thread, provider process, terminal, browser, and workspace state. A
workflow system continues to own tasks, plans, approvals, budgets, schedules,
and business policy.

The core records external host IDs as bindings; it never treats a projection
from another system as local command authority.

## Delivery states

Messages move through `pending -> claimed -> delivered`. A claim has a bounded
lease. An expired claim returns to `pending`. An acknowledgement must name the
exact message and claim token. A host accepting an injection is not equivalent
to a provider adopting the next turn, so those receipts remain separate.

## Trust

Bodies, display names, and claimed provenance inside a message are untrusted.
Authorization comes from transport identity and scoped credentials. Host
adapters must preserve the authenticated source separately from the body.

## Events

Every state mutation appends a monotonically sequenced durable event in the
same SQLite transaction. Version 0.2 exposes bounded cursor-based replay and a
durable head over HTTP polling. A stored-then-live SSE publisher is planned but
is not part of the current release.

Version 0.2 has one idempotent bootstrap migration. Future schema changes must
add a versioned migration ledger rather than mutating that bootstrap in place.
