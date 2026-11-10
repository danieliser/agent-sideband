# T3 Code integration boundaries

The public standalone release uses existing T3 orchestration APIs. It requires
no T3 source modifications and no PERSIST installation.

## External adapter

`T3HostAdapter` discovers the environment and configured provider instances. It
can create a thread, start a visible turn, bind an existing thread, interrupt,
stop and inspect. The default daemon records a successful spawn receipt as a
binding, so later wakes do not depend on native host enrollment.

T3's `{ sequence }` response proves durable command acceptance only. It does
not prove provider adoption, mid-turn steering or message consumption. Configure
MCP tools and scoped agent credentials separately. A standalone MCP client is
pull-only; unattended scheduled wakes require a host binding.

## Optional host protocol

For custom hosts, Sideband exposes connector provisioning and a filtered MCP
bridge. A host can enroll its sessions, heartbeat/rotate their credentials and
forward agent tools without letting models choose their identity. These are
available protocol building blocks, not automatic features of stock T3.

Managed spawn identity is an explicit library opt-in:
`createSidebandDaemon({ ..., managedSpawnIdentity: true })`. Use it only with a
host integration that enrolls the planned tuple. The CLI does not enable it.
Without enrollment, managed spawns remain unbound. Never enable this option as
a workaround for stock T3. Reservation and raw-bind guards remain enforced.

## Deferred T3 features

- Automatic per-thread credential provisioning and tools inside T3's MCP server.
- Authenticated native wake cards and recipient-scoped full-message reads.
- Context-only injection; it requires a provider and current thread credential
  that explicitly support it. Stock T3 wake delivery is visible.
- Automatic re-enrollment/rebinding after a T3 server restart. Explicitly resume
  or rebind as needed; inspect pending occurrences before retrying unknown work.
- Provider-adoption receipts, crash-safe provider replay and non-Codex context.
- Mobile verification and native Sideband UI.

Draft T3 work is separate and unmerged. No T3 migration, deployment or upstream
adoption is part of this release. Restart limitation:
[issue #1](https://github.com/danieliser/agent-sideband/issues/1).
