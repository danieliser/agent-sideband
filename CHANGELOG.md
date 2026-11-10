# Changelog

## 0.3.0 — 2026-11-10

- Add durable reminders: delays, absolute times, intervals, timezone-aware cron
  and named events, with occurrence history, cancellation and restart recovery.
- Start the scheduler automatically in the composed local daemon.
- Add host-scoped connector enrollment and separate agent credentials, with
  lease renewal, rotation, revocation and stable host-session identities.
- Expose shared MCP catalogs and an HTTP execution bridge for embedded hosts.
- Keep stock T3 spawning independent of native enrollment; managed spawn
  identity requires explicit library opt-in and an enrolling host.
- Avoid multi-second cron searches for impossible calendar dates while
  retaining exact timezone evaluation on matching days.
- Qualify installed tarballs, stdio MCP and the daemon's automatic timer in CI.

The standalone MCP server is pull-only. Unattended wake needs a bound host
adapter, and host acceptance is not provider adoption or work completion.
Native T3 tools, cards, context injection and restart rebinding remain deferred.

## 0.2.1

Standalone coordination, credential-bound MCP, durable messaging, channels,
claim leases, event replay and an external T3 host adapter.
