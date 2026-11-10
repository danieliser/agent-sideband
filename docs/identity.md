# Automatic identity

Each agent session gets its own Sideband credential and a stable identity,
without anyone copying tokens around. You configure the host once; after that,
provisioning is automatic.

Concretely: a reviewer agent always shows up as the same reviewer, whether its
session restarted, its provider changed, or the host rebooted. It can read its
own inbox and send as itself, and nothing it says can make it someone else.
Reminders survive restart; delivery waits until an eligible host binding exists.

Automatic provisioning needs a host integration that calls the connector API.
The native T3 integration is deferred (see the last section). Any other
host can still use Sideband with a credential you provision by hand.

1. **Start the daemon.** It writes a local operator token to
   `.agent-sideband/sideband.token`. The operator token manages the daemon.
   Never give it to an agent.
2. **Enroll the host connector** (one per host instance):

   ```sh
   agent-sideband connector enroll --adapter t3 --host-instance my-laptop \
     --out ~/.config/my-host/sideband-connector.token
   ```

   The connector token is written to a `0600` file and never printed. It can
   only manage sessions on that one host instance.

3. **The host provisions each session.** When a session starts, the host's
   integration calls `POST /v1/host-sessions` with its connector token and the
   session's thread and provider-session identifiers. Sideband returns a
   per-session agent credential exactly once, and the host hands it only to
   that session's tools.

What this gives you:

- **Stable identity.** The same host thread always maps to the same agent,
  across restarts and new provider sessions. Only the per-session credential
  changes.
- **Least privilege.** An agent credential can read its own inbox, send
  messages as itself, and manage its own schedules. It cannot provision peers,
  spawn or stop agents, read the global event log, or claim to be someone
  else. Fields like `fromAgentId` or `ownerAgentId` in a request are rejected
  with `422 IDENTITY_FIELD_REJECTED` rather than ignored.
- **Short-lived credentials, durable reminders.** Agent credentials expire
  (8 hours at most) and stop working when the host stops heartbeating, rotates
  them, or revokes them. A reminder you already created keeps its authority
  anyway: a 30-minute self reminder still fires after your token rotates or
  expires. It stops only if your access or schedule grant is explicitly
  revoked, or your identity is retired.
- **Lost responses are safe.** If the host retries provisioning after losing
  the response, Sideband returns `409 CREDENTIAL_ALREADY_ISSUED` with the
  non-secret ids instead of minting a duplicate. The host then rotates with a
  new `rotationId`.

Host-session lifecycle routes, all connector-only:

| Route                                  | Purpose                                         |
| -------------------------------------- | ----------------------------------------------- |
| `POST /v1/host-sessions`               | Register a session; returns its credential once |
| `POST /v1/host-sessions/:id/heartbeat` | Renew the session lease (exact host epoch)      |
| `POST /v1/host-sessions/:id/rotate`    | Replace the credential, once per `rotationId`   |
| `POST /v1/host-sessions/:id/offline`   | Session ended; identity and reminders stay      |
| `POST /v1/host-sessions/:id/revoke`    | Revoke access; future effects stop              |

Operator management: `agent-sideband connector rotate|revoke`,
`agent-sideband access revoke|restore --agent ID`, and
`agent-sideband grant schedule|revoke-schedule --owner A --target B`.

Hosts without an integration can still use Sideband: have the launcher write a
provisioned credential to a protected file and point the bundled MCP server at
it with `AGENT_SIDEBAND_TOKEN_FILE`. There is no automatic identity discovery
for arbitrary stdio clients.

## Set up a standalone MCP agent

This explicit host setup does not require T3 patches. A trusted launcher owns
registration and heartbeat; the model receives only the agent token file.
Use a distinct `externalId` per agent and keep `hostEpoch` stable for this
launcher run. Use a fresh epoch when the launcher restarts.

```sh
# Run alongside the daemon, as its operator.
node dist/cli.js connector enroll --adapter local --host-instance my-laptop \
  --out .agent-sideband/local-connector.token

# Protect both the response and the extracted credential. Do not print either.
umask 077
curl --fail --silent --show-error \
  -X POST http://127.0.0.1:7341/v1/host-sessions \
  -H "Authorization: Bearer $(<.agent-sideband/local-connector.token)" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: reviewer-session-1' \
  -d '{"externalId":"reviewer","providerSessionId":"reviewer-session-1","hostEpoch":"launcher-run-1","leaseSeconds":300}' \
  --output .agent-sideband/reviewer-session.json
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const session = JSON.parse(readFileSync(".agent-sideband/reviewer-session.json", "utf8"));
if (typeof session.token !== "string") throw new Error("No credential issued");
writeFileSync(".agent-sideband/reviewer.token", session.token + "\n", { mode: 0o600 });
'
```

Point the MCP configuration in the README at the absolute path of
`.agent-sideband/reviewer.token`. Repeat registration with another external ID
and idempotency key for each peer. The response also contains `agentId`, which
peers use as their message target, and `hostSessionId`, which the launcher uses
for lifecycle calls. Treat the response file as a secret too.

The launcher must heartbeat before the five-minute lease expires:

```sh
HOST_SESSION_ID=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(".agent-sideband/reviewer-session.json", "utf8")).hostSessionId)')
curl --fail --silent --show-error \
  -X POST "http://127.0.0.1:7341/v1/host-sessions/$HOST_SESSION_ID/heartbeat" \
  -H "Authorization: Bearer $(<.agent-sideband/local-connector.token)" \
  -H 'Content-Type: application/json' \
  -d '{"hostEpoch":"launcher-run-1","leaseSeconds":300}'
```

This example establishes pull-only MCP access, not unattended host wake. Rotate
credentials before their eight-hour maximum lifetime, take the host session
offline when the agent exits, and rotate after a lost provisioning response.
The lifecycle routes below are the launcher contract; Sideband does not run your
launcher for you. Do not re-enroll the connector on every agent start.

## Three kinds of credential

| Credential     | Held by                                     | Can do                                                                                                                   |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Operator       | You, on the daemon's machine                | Manage connectors, restore access, inspect everything. Never given to agents.                                            |
| Host connector | One host integration, for one host instance | Register, heartbeat, rotate, take offline and revoke its own sessions; publish named events. Cannot message as an agent. |
| Agent          | One agent session                           | Read and acknowledge its own inbox, send as itself, report presence, manage its own schedules.                           |

Tokens are returned only by the call that creates them. Sideband stores a
SHA-256 digest, never the token, and never writes tokens to events, logs,
schedules or error details.

## Session lifecycle

- **Heartbeat.** The host renews each session lease (default 60 seconds) with
  the exact `hostEpoch` it registered. A lapsed lease makes the tool credential
  unusable until the next heartbeat; it does not delete anything.
- **Host restart.** A host that boots again uses a new `hostEpoch`. Registering
  the same thread under the new epoch keeps the agent identity, bumps the
  binding generation and invalidates the old credential. The old epoch can no
  longer heartbeat.
- **Session ended.** `offline` revokes the credential and deactivates the
  binding. Mail and schedules stay; due reminders wait (as `blocked`) until the
  thread is registered again.
- **Access revoked.** `revoke` stops the credential and future schedule
  effects for that identity. Only the operator can restore it.

## Mapping a thread to a named agent

By default the agent id is derived from the adapter, host instance and thread
id, so it is stable and collision-free. To map a thread to a friendly id such
as `reviewer`, enroll the connector with that alias allowed:

```sh
agent-sideband connector enroll --adapter t3 --host-instance my-laptop --allow-agent reviewer
```

The connector can then pass `requestedAgentId: "reviewer"` when registering.
Agent aliases are limited to 122 characters so their derived principal IDs fit
the shared 128-character identifier limit. Oversized aliases are refused before
identity persistence or managed host dispatch. An alias can belong to only one host thread, and agents can never pick their
own identity.

## Spawns Sideband starts

A thread that Sideband itself spawns gets exactly one identity: the agent id the
spawner asked for, not a second derived one. This is managed spawn identity. It
applies to a spawn only when two things are true: the daemon (or library user)
opted in, and the host adapter implements `planSpawn`. Every other spawn keeps
receipt-based binding behavior. The default daemon and CLI use that stock-host
path. Managed identity is reserved for hosts that implement enrollment.

- **Opt in explicitly.** `createSidebandDaemon({ ..., managedSpawnIdentity: true })`
  passes the identity coordinator to the core. The daemon applies all four
  migrations in either mode. Lower-level library consumers can use
  `IdentityService.create(store, { spawnIntents: true })` and pass
  `identity.spawnIdentity` to `AgentSideband`.
- **Reserve before mutation.** The adapter's `planSpawn` chooses the host tuple.
  Sideband claims dispatch and reserves the authorized intent transactionally
  before calling the host. Reserved metadata such as T3's `threadId` cannot be
  overridden by callers. The T3 adapter implements this protocol, but using it
  needs a host enrollment integration; stock T3 does not supply one.
- **Authority comes from the authenticated principal.** The spawner is the
  operator, or a live agent credential. `principalId` and `parentAgentId` in the
  request are only checked against it, never believed. The parent of the new
  agent is the verified spawning agent, or none for an operator. Exact replays
  are re-authorized.
- **Agents do not spawn by default.** Default agent credentials carry no
  lifecycle authority. An operator can opt a daemon in to the `agents:spawn`
  grant (`IdentityService.create(store, { grants: [...DEFAULT_AGENT_GRANTS, "agents:spawn"] })`).
  Even then an agent can only mint brand-new identities; naming an existing
  agent needs the operator. The HTTP spawn route still requires the operator
  `lifecycle:control` grant.
- **Enrollment adopts the intent.** When the connector registers the reserved
  tuple, `provision` adopts the intent in the same transaction, so the thread
  enrolls as the intended agent with the intent's verified parent. A connector
  for another host, or one asking for a different agent or parent, is refused
  and the intent stays pending.
- **No raw bind.** A managed spawn records the host receipt without binding;
  the binding comes from enrollment. A raw `bindAgent` can no longer take over a
  tuple that enrollment manages or an intent reserves.
- **Failures.** Only a definite host failure abandons a pending intent; the
  tuple then stays burned. An unknown outcome (timeout, partial spawn, a host
  that reports a different tuple than planned) keeps the intent pending, so the
  thread can still enroll as the intended agent. An intent that enrollment
  already adopted is never abandoned.

## What the host integration must do

The daemon side is implemented and covered by automated tests. A host
integration needs to:

1. Store its connector token where only the host process can read it.
2. Register each session (`POST /v1/host-sessions` with an `Idempotency-Key`)
   and give the returned token only to that session's Sideband tools.
3. Heartbeat while the session lives, and call `offline` when it ends.
4. Rotate on credential expiry or after losing a registration response.

Hosts that also want silent context delivery additionally push a narrow
delivery credential with `PUT /v1/host-sessions/:id/delivery-credential`. The
daemon keeps it in memory only and re-checks the live session on every use, so
it is gone after a daemon restart until the host pushes it again (the heartbeat
reports `deliveryCredential: "missing"` so the host knows).

## T3 Code status

T3 Code's integration is implemented as uncommitted work in an isolated T3
worktree, not in a T3 release. It follows the four steps above, plus the
delivery-credential push, and adds a background retry when the daemon was down at
session start. The exact files, behavior, test evidence, and the parts that are
not implemented are in [Exact T3 Code impact](t3-code-impact.md). Sideband does
not claim T3 has adopted it.
