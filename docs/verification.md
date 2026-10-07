# Standalone verification

## Live two-agent check: passed

On 2026-10-07, the built source at commit
`56af97a4f31c8d139f4591fc51977b5ab48c86b4` was exercised with two real model
sessions, each using the standalone stdio MCP server. This was not a mock
host or a replay of another application's tests.

The test ran a loopback HTTP service with a fresh disk-backed SQLite database,
no host adapters, and a custom authenticator mapping two independent bearer
credentials to `builder` and `reviewer`. Each credential had only
`agents:read`, `messages:read`, and `messages:write` grants. Built-in agent
tools were disabled; messages went through Sideband MCP and HTTP.

### Observed sequence

| Step                                              | Actual result                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| Builder sends reviewer a request                  | Stored as sender `builder`, with an unpredictable test nonce        |
| Reviewer reads, claims, acknowledges, and replies | Reply contains the same nonce and sender `reviewer`                 |
| Builder resumes and acknowledges the reply        | Delivery recorded; builder queues `DELAYED CHECK`                   |
| External timer waits 15 seconds                   | Reviewer session is resumed at the due time                         |
| Reviewer reads, claims, acknowledges, and replies | `AWAKE` message reaches builder                                     |
| Builder resumes and acknowledges                  | All four deliveries are `delivered`; both pending inboxes are empty |

The run began at `02:41:03Z` and finished at `02:42:07Z`. The timer was armed
at `02:41:32.303Z` and launched the reviewer resume at `02:41:47.303Z`.
Verification checked database message bodies, sender identities, recipient
identities, and delivery states, not just the agents' final text. The database
also retained 14 coordination events. The test server and agent processes
exited when the check finished.

The runtime was Node.js 26.5.0. An initial attempt with a different installed
Node runtime failed to load the native SQLite module; using the runtime that
matched the dependency build resolved that local setup problem.

## What this does not prove

- **Built-in scheduling:** there is no scheduler in Sideband. The test harness
  owned the timer and resumed the host session. It did not invoke a Sideband
  host-wake operation or test a durable schedule surviving a restart.
- **Automatic identity provisioning:** the test supplied a custom library
  authenticator. The packaged daemon still exposes one `operator` identity;
  sharing that token between agents does not create distinct identities.
- **A complete T3 team workflow:** this run did not use T3, spawn agents through
  the T3 adapter, or exercise T3-managed MCP credential provisioning. See
  [the exact T3 integration boundary](t3-code-impact.md).
- **Cross-provider interoperability:** the two sessions used the same agent
  host. A mixed-host team was not exercised in this run.
- **Crash recovery or overnight reliability:** this was a short happy-path
  live check, not a restart, outage, concurrency, or long-duration soak test.
- **Fresh installation:** this run used built source and installed local
  dependencies, not a fresh installation of a release tarball.

## Repeating the live check

1. Build Sideband using the same Node runtime used to install its dependencies.
2. Open a fresh `SqliteSidebandStore`, register two agents, and start
   `buildAgentSidebandServer` with a separate credential-to-principal mapping
   for each agent. Bind it only to loopback.
3. Configure two real agent sessions to launch `dist/mcp/cli.js`, each with
   the server URL and its own credential. Disable unrelated tools.
4. Have one session send a random challenge through MCP. Instruct the other
   to read, claim, acknowledge, and reply with that challenge. Resume the
   first session to acknowledge the reply.
5. Queue another message, stop issuing turns, and use an external timer to
   resume the recipient. Require an MCP reply and acknowledge that reply.
6. Independently inspect the stored messages and delivery states. A successful
   host turn or a model claiming success is not sufficient evidence.

For sharing today, describe Sideband as an early integration toolkit with
live-tested messaging, not as a turnkey scheduled agent team.
