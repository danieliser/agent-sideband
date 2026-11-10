# Scheduling wake-ups

Sideband can hold a reminder for an agent and deliver it later, even if the
daemon restarts in between. A schedule is stored in the same SQLite database as
messages. When it comes due, Sideband writes a normal inbox message from the
schedule's sender and asks the host to deliver it. Agent-owned reminders use
their owner agent as the sender. Operator-owned reminders use the reserved
`system-scheduler` agent as the sender; the schedule's `ownerPrincipalId`
continues to identify the operator who authorized it.

Every example below works the same through MCP tools and the HTTP API. MCP
tools take flat arguments; HTTP takes the idempotency key as a header.

## What you can do with it

- **Check back later.** A builder starts a long test run and asks to be woken in
  30 minutes to read the result, without you remembering to prod it.
- **Chase a review.** After handing work to a reviewer, the builder schedules a
  reminder. If the reviewer's reply is already in the inbox, the builder reads
  it; if not, it can nudge the reviewer. Sideband delivers the reminder; the
  agent decides what to do with it.
- **Recurring routine.** A lead checks open review requests every weekday
  morning and reports blockers.
- **Wake without you.** With a connected host adapter, the due reminder both
  lands in the inbox and wakes the agent, so work resumes while you are away.
  Without one, nothing wakes the agent (see below).

## Wake needs a host adapter

Delivering a due reminder needs a host binding for the target: Sideband writes
the inbox message and asks the host to wake the agent. The standalone MCP server
alone provides no binding and no wake. An agent that only talks to Sideband
through MCP is **pull-only**, and a schedule targeting it waits as `blocked`
(`TARGET_UNBOUND`) until a host binding exists. The built-in T3 Code adapter is
the one shipped adapter that can wake.

## Before you start

- Run the daemon (`pnpm start`). It drives due schedules on its own timer.
- The agent needs its own credential with schedule grants. Provisioned agent
  credentials (see [Automatic identity](identity.md)) include them.
- Ask what this agent's host can do first:

  ```text
  sideband_capabilities_get
  ```

  `delivery.wake`, `delivery.context` and `delivery.both` describe the host
  binding behind this credential. Use only what it reports as `true`.

## Remind me in 30 minutes

```json
{
  "tool": "sideband_schedule_create",
  "arguments": {
    "idempotencyKey": "review-in-30m",
    "name": "Review status",
    "body": "Review the current checkpoint and continue the assigned work.",
    "trigger": { "type": "after", "delay": { "value": 30, "unit": "minutes" } }
  }
}
```

Over HTTP the delay is always whole seconds:

```sh
curl -X POST http://127.0.0.1:7341/v1/schedules \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Idempotency-Key: review-in-30m' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Review status","body":"Review the checkpoint.","trigger":{"type":"after","delaySeconds":1800}}'
```

"In 30 minutes" means 30 minutes after Sideband first accepts the request.
Retrying with the same idempotency key returns the original schedule with the
original due time (HTTP `200` instead of `201`); it never starts a second timer.
Reusing the key with a different request returns `IDEMPOTENCY_CONFLICT`.

Automated tests cover this timing with a normalized test clock, including clock
jumps. They do not wait 30 real minutes, so wall-clock accuracy has not been
measured.

The target defaults to the calling agent, and delivery defaults to `wake`.

## Wake at a specific time

```json
{
  "idempotencyKey": "wake-tomorrow-9",
  "body": "Resume the migration review.",
  "trigger": { "type": "at", "at": "2026-10-09T09:00:00-04:00" }
}
```

Times must carry `Z` or an explicit offset. Sideband never guesses a timezone
from phrases such as "tomorrow morning"; resolve those before calling. The
response shows the normalized UTC due time in `schedule.nextDueAt`. A time in
the past is accepted and fires on the next scheduler pass.

## Recurring review

Every weekday at 09:00 in New York:

```json
{
  "idempotencyKey": "weekday-review",
  "name": "Weekday review",
  "body": "Check open review requests and report blockers.",
  "trigger": { "type": "cron", "expression": "0 9 * * MON-FRI", "timezone": "America/New_York" }
}
```

Cron uses five fields (minute, hour, day of month, month, day of week).
Day-of-month and day-of-week must both match. The timezone is an IANA name and
defaults to UTC. Slots missed while the daemon was down are skipped, not
replayed; a DST gap that never happens on the wall clock does not fire.

Every hour from now:

```json
{ "type": "interval", "everySeconds": 3600 }
```

Intervals keep a fixed grid. If several slots were missed, one occurrence fires
and the rest are counted in `skippedSlots`.

## Visible message or silent context?

| `deliveryMode`   | What the agent sees                                                     | Requires       |
| ---------------- | ----------------------------------------------------------------------- | -------------- |
| `wake` (default) | A visible user message that starts a turn.                              | Host `wake`    |
| `context`        | The note is added to the agent's context without starting a turn.       | Host `context` |
| `both`           | Context first, then a wake. If the context step fails, no wake is sent. | Both           |

If the host cannot inject context, Sideband refuses the schedule with
`CONTEXT_INJECTION_UNSUPPORTED` (HTTP `422`). It never quietly downgrades
`context` to a wake. If a binding changes later and loses that capability, the
occurrence is marked `blocked` with the same code instead of waking.

For T3 Code, `wake` works through the external adapter with no T3 changes.
`context` and `both` are available only when all of these hold: the daemon
runs the packaged T3 adapter, the T3 server has the Sideband connector from
[Exact T3 Code impact](t3-code-impact.md), the target is a **Codex** session in
the `ready` state, and the connector has handed Sideband a current delivery
credential for that thread. Otherwise `sideband_capabilities_get` reports
`delivery.context: false` and the request is refused or the occurrence is
`blocked`.

A context delivery is acknowledged by Codex appending the note to its history.
That is not proof that a model read it, and Sideband records it as adopted
rather than consumed. A single end-to-end run of a real scheduler firing into a
real model session is still pending qualification.

## Check what happened

```text
sideband_schedules_list            { "status": "active" }
sideband_schedule_get              { "scheduleId": "…" }
sideband_schedule_occurrences_list { "scheduleId": "…" }
```

Creating a schedule only proves Sideband stored it (`receiptLevel:
"scheduled"`). Each occurrence carries its own outcome:

- `host_accepted` / `host_adopted` / `observed`: the host took the wake.
- `blocked`: something prevents delivery right now, such as the target being
  offline or a capability missing. `error.code` says which. Blocked
  occurrences retry when the cause clears, unless authority was revoked.
- `indeterminate`: the host call ended without a clear answer. Sideband does
  not resend automatically, to avoid duplicate work.
- `failed`: the host refused.

The delivered message lands in the target's inbox like any other message, with
the schedule owner as sender. Claim and acknowledge it as usual.

## Cancel

```json
{
  "tool": "sideband_schedule_cancel",
  "arguments": { "idempotencyKey": "cancel-review", "scheduleId": "…" }
}
```

Only the owner (or the local operator) can cancel. The result lists:

- `suppressedOccurrenceIds`: queued work that will not be delivered.
- `inFlightOccurrenceIds`: occurrences already being handed to the host; these
  may still arrive.
- `alreadyAcceptedOccurrenceIds`: past deliveries, unchanged.

## Who can schedule what

- An agent schedules for itself. To let a lead wake another agent, the
  operator grants that pair once:
  `agent-sideband grant schedule --owner LEAD --target CHILD`. Without the
  grant the request returns `FORBIDDEN`; revoking it
  (`grant revoke-schedule`) blocks future deliveries.
- An operator can create a reminder for an agent by providing `targetAgentId`
  explicitly. Operator schedules have no owner agent; their due messages are
  sent by `system-scheduler`, while `ownerPrincipalId` preserves operator
  ownership for authorization and audit.
- Ownership is derived from the credential and its authorization decision;
  callers cannot select the sender. Fields such as `ownerAgentId` or
  `fromAgentId` in a request are rejected with `IDENTITY_FIELD_REJECTED`.
- Schedules you neither own nor receive are reported as not found.
- A schedule keeps its authority after the agent's short-lived tool credential
  expires or rotates. It stops only when access is revoked, the agent is
  retired, the grant is withdrawn, or you cancel it.

## Named events

Trusted publishers (the local operator or an enrolled host connector) can post
named events to `POST /v1/schedule-events`. Agents cannot publish events, and
agent credentials cannot yet subscribe to them: event matching is currently
scoped to the publishing principal. `sideband_capabilities_get` reports
`triggers.event: false` for agent credentials until that changes.

## Errors

HTTP and MCP return the same shape:

```json
{
  "error": {
    "code": "CONTEXT_INJECTION_UNSUPPORTED",
    "message": "…",
    "details": {},
    "retryable": false
  }
}
```

| Status | Typical codes                                                                  |
| ------ | ------------------------------------------------------------------------------ |
| 401    | `UNAUTHORIZED`: missing, expired, rotated or revoked credential                |
| 403    | `FORBIDDEN`: missing grant or target not allowed                               |
| 404    | `SCHEDULE_NOT_FOUND` (also for schedules outside your scope)                   |
| 409    | `IDEMPOTENCY_CONFLICT`, `CREDENTIAL_ALREADY_ISSUED`                            |
| 422    | `INVALID_ARGUMENT`, `IDENTITY_FIELD_REJECTED`, `CONTEXT_INJECTION_UNSUPPORTED` |
| 503    | Temporary unavailability; `retryable: true`                                    |
