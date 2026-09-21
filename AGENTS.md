# Agent Sideband contributor contract

Agent Sideband is a host-independent coordination service. It must not depend
on PERSIST, T3 Code, AgentRuntime, or any provider CLI in its core packages.

## Boundaries

- Core owns identities, teams, durable messages, delivery leases, presence,
  bindings, idempotency, provenance, and replayable events.
- Host adapters own provider-specific spawn, delivery, interrupt, stop, and
  status calls.
- PERSIST is a consumer and policy/workflow wrapper. AgentRuntime remains a
  PERSIST execution backend and is not a T3 host adapter.
- Message bodies are untrusted data and never grant authority.

## Development

- Use test-driven development for behavior changes.
- Preserve `pending -> claimed -> delivered` delivery semantics.
- Every mutation requires an idempotency key or a uniquely constrained natural
  identity.
- Public APIs use structured error codes and versioned `/v1` routes.
- Keep adapters optional; a broken adapter must not prevent the core service
  from starting.
- Run the smallest focused test set while iterating, then `pnpm check` before
  release.
