# Exact T3 Code impact

This document separates three different meanings of "works with T3 Code." They
have different implementation requirements and must not be conflated.

## 1. External Sideband adapter: no T3 Code changes required

Agent Sideband can control current T3 Code through its existing authenticated
orchestration API. The adapter can:

- create a thread with `thread.create` and start it with `thread.turn.start`;
- wake or send another user turn with `thread.turn.start`;
- interrupt the active provider session with `thread.turn.interrupt`;
- stop the provider session with `thread.session.stop`; and
- inspect snapshots and thread projections and reconnect to ordered events.

This baseline works for T3's Claude, Codex, and Cursor Agent drivers. Sideband
must discover the configured provider `instanceId`; it must not assume the
built-in IDs are unchanged.

The baseline deliberately does **not** claim context-only injection,
deterministic mid-turn steering, or proof that a provider adopted an accepted
command. T3's dispatch response `{ sequence }` proves durable command
acceptance only.

## 2. Correct end-to-end adoption semantics: five T3 Code changes

These changes are required before Sideband can promise more than the baseline:

1. **Context-only injection.** Add a durable `thread.context.inject` command and
   `/api/orchestration/threads/:threadId/context-injections` route, with a stable
   `injectionId`, explicit inactive-session behavior, provider capability
   checks, and provider adoption results. Without this, `context` must remain
   unsupported; it cannot silently become a visible wake turn.
2. **Durable provider-adoption receipts.** Record an operation keyed to the
   originating Sideband command/message/injection with `accepted`,
   `provider_adopted`, or `provider_failed`, provider instance/turn evidence,
   timestamps, and errors. Expose both lookup and ordered receipt events.
3. **Crash-safe provider-intent replay.** Replace the live-only provider command
   reaction with a durable pending/adopted/failed outbox and startup
   reconciliation. A restart after orchestration acceptance must not strand a
   provider intent.
4. **Payload-bound command idempotency.** Store a canonical request hash with
   each command receipt. An exact retry returns the original result; reusing a
   `commandId` with a different payload returns a conflict.
5. **Versioned capability negotiation.** Advertise a Sideband-facing protocol
   version and feature flags for context injection, adoption receipts, receipt
   lookup, and each provider's new-turn, active-steer, queue, and context modes.

One conditional sixth change is required only if T3 itself must attest or
render trusted Sideband provenance: store server-stamped external actor and
operation fields in T3's command, event, and message projections. Sideband can
otherwise remain the provenance authority and send T3 a visibly untrusted text
envelope.

## 3. Native tools inside every T3 agent: seven T3 Code changes

An external adapter can operate T3, but Claude, Codex, and Cursor agents do not
automatically receive Sideband tools. A seamless provider-neutral toolset
inside each T3-hosted agent requires this exact integration slice:

1. Add optional Sideband URL, credential reference, timeout, health, and
   negotiated-capability configuration plus a loopback-safe client service.
2. Extend T3's MCP capability set with `sideband`, issued only while Sideband
   is configured and healthy.
3. Register one provider-neutral toolkit beside T3's existing toolkit:
   `sideband_message_send`, `sideband_inbox_list`, `sideband_message_claim`,
   `sideband_message_ack`, `sideband_agents_list`, `sideband_agent_spawn`,
   `sideband_agent_interrupt`, and `sideband_agent_stop`.
4. Derive caller identity from `McpInvocationContext` (environment, thread,
   provider session, and provider instance). Ignore or reject caller/from
   identity supplied by the model.
5. Lazily create or refresh the matching Sideband binding on first use, and
   mark it offline or revoke it when T3 revokes that thread/provider session.
6. Treat Sideband as optional and degraded: a stopped/unhealthy Sideband daemon
   must not prevent T3 or provider sessions from starting.
7. Add cross-provider focused tests proving identical tool registration,
   thread-scoped credentials, spoof rejection, revocation, and clean degraded
   behavior.

No provider-specific Claude/Codex/Cursor CLI patch is needed because each
driver already receives T3's MCP server.

## Optional native-quality improvements

- Add HTTP parity for T3's WebSocket-only bootstrap flow so spawn plus project,
  worktree, and first turn can be one operation.
- Add read-scoped HTTP provider discovery and capability endpoints.
- Add repeatable scoped-token flags to the T3 auth CLI.
- Add native Sideband timelines, presence, hierarchy, and trust badges to the
  T3 UI.

Those are not required for the external v0.1 adapter.
