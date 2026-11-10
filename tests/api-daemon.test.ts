import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSidebandDaemon, type SidebandDaemon } from "../src/api/daemon.js";
import { T3HostAdapter } from "../src/adapters/t3.js";
import type {
  HostAdapter,
  HostOperationReceipt,
  HostSendRequest,
} from "../src/core/host-adapter.js";

const START = "2026-10-08T12:00:00.000Z";
const OPERATOR_TOKEN = "operator-token-that-is-long-enough-for-the-daemon";

let directory: string | undefined;
const daemons: SidebandDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function testHost(sends: HostSendRequest[]): HostAdapter {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    name: "test-host",
    capabilities: async () => ({
      spawn: false,
      bind: false,
      wake: true,
      context: false,
      interrupt: false,
      stop: false,
      adoptionReceipts: false,
    }),
    spawn: unused,
    bind: unused,
    send: async (request): Promise<HostOperationReceipt> => {
      sends.push(request);
      return { stage: "accepted", receiptId: `receipt-${request.operationId}` };
    },
    interrupt: unused,
    stop: unused,
    inspect: unused,
  };
}

function boot(clock: { current: Date }, sends: HostSendRequest[]): SidebandDaemon {
  directory ??= mkdtempSync(join(tmpdir(), "sideband-daemon-"));
  const daemon = createSidebandDaemon({
    database: join(directory, "sideband.sqlite"),
    operatorToken: OPERATOR_TOKEN,
    now: () => new Date(clock.current),
    scheduler: { autoStart: false },
    adapters: [
      { name: "test-host", create: () => testHost(sends) },
      {
        name: "broken",
        create: () => {
          throw Object.assign(new Error("connection refused with secret sbct_abc"), {
            code: "BROKEN_ADAPTER",
          });
        },
      },
    ],
  });
  daemons.push(daemon);
  return daemon;
}

const operator = { authorization: `Bearer ${OPERATOR_TOKEN}` };

describe("Sideband daemon", () => {
  it.each([false, true])(
    "requires explicit opt-in for enrollment-based spawning (%s)",
    async (managed) => {
      const daemon = createSidebandDaemon({
        database: ":memory:",
        operatorToken: OPERATOR_TOKEN,
        managedSpawnIdentity: managed,
        scheduler: { autoStart: false },
        adapters: [
          {
            name: "t3",
            create: () =>
              new T3HostAdapter({
                baseUrl: "http://127.0.0.1:3773",
                token: "test-t3-token",
                fetch: async (_url, init) =>
                  new Response(
                    JSON.stringify(
                      init?.method === "POST"
                        ? { sequence: 1 }
                        : {
                            environmentId: "host-1",
                            label: "Test",
                            platform: { os: "macos", arch: "arm64" },
                            serverVersion: "test",
                            capabilities: {},
                          },
                    ),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
              }),
          },
        ],
      });
      daemons.push(daemon);
      daemon.store.registerAgent({ agentId: "worker-1" });
      const spawned = await daemon.app.inject({
        method: "POST",
        url: "/v1/agents/worker-1/spawn",
        headers: { ...operator, "idempotency-key": "stock-t3-spawn" },
        payload: {
          adapter: "t3",
          provider: "provider-1",
          prompt: "Review",
          metadata: { projectId: "project-1", model: "model-1" },
        },
      });
      expect(spawned.statusCode).toBe(202);
      expect(spawned.json().operation.stage).toBe("accepted");
      if (managed) {
        expect(spawned.json().binding).toBeNull();
      } else {
        expect(daemon.store.getActiveBinding("worker-1")).toMatchObject({
          adapter: "t3",
          hostInstanceId: "host-1",
          active: true,
        });
        expect(spawned.json().binding).not.toBeNull();
      }
    },
  );

  it("applies versioned migrations and starts despite a broken optional adapter", async () => {
    const clock = { current: new Date(START) };
    const daemon = boot(clock, []);
    expect(daemon.store.appliedMigrations().map((migration) => migration.version)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(daemon.degradedAdapters).toEqual([{ name: "broken", reason: "BROKEN_ADAPTER" }]);
    const health = await daemon.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      degradedAdapters: ["broken"],
      scheduler: { state: "stopped" },
    });
    expect(health.body).not.toContain("sbct_");
  });

  it("provisions a host session, fires a durable reminder, and survives restart", async () => {
    const clock = { current: new Date(START) };
    const sends: HostSendRequest[] = [];
    let daemon = boot(clock, sends);

    const connector = await daemon.app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: operator,
      payload: { adapter: "test-host", hostInstanceId: "host-a" },
    });
    const connectorToken = connector.json().token as string;
    const access = (
      await daemon.app.inject({
        method: "POST",
        url: "/v1/host-sessions",
        headers: { authorization: `Bearer ${connectorToken}`, "idempotency-key": "provision-1" },
        payload: {
          externalId: "thread-1",
          providerSessionId: "provider-1",
          hostEpoch: "epoch-1",
          leaseSeconds: 300,
        },
      })
    ).json();
    const agent = { authorization: `Bearer ${access.token}` };

    const created = await daemon.app.inject({
      method: "POST",
      url: "/v1/schedules",
      headers: { ...agent, "idempotency-key": "remind-2m" },
      payload: { body: "Check the build.", trigger: { type: "after", delaySeconds: 120 } },
    });
    expect(created.statusCode).toBe(201);
    const scheduleId = created.json().schedule.scheduleId as string;

    // Restart on the same database: schedules, identities and credentials are durable.
    await daemon.close();
    daemons.splice(daemons.indexOf(daemon), 1);
    daemon = boot(clock, sends);
    expect(daemon.store.appliedMigrations()).toHaveLength(4);
    const still = await daemon.app.inject({
      method: "GET",
      url: `/v1/schedules/${scheduleId}`,
      headers: agent,
    });
    expect(still.statusCode).toBe(200);
    expect(still.json().status).toBe("active");

    clock.current = new Date(Date.parse(START) + 120_000);
    await daemon.loop.runOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ mode: "wake", fromAgentId: access.agentId });
    expect(daemon.loop.status()).toMatchObject({ lastErrorCode: null, consecutiveFailures: 0 });

    const replay = await daemon.app.inject({
      method: "POST",
      url: "/v1/schedules",
      headers: { ...agent, "idempotency-key": "remind-2m" },
      payload: { body: "Check the build.", trigger: { type: "after", delaySeconds: 120 } },
    });
    expect(replay.statusCode).toBe(200);
    await daemon.loop.runOnce();
    expect(sends).toHaveLength(1);
  });

  it("fires a self reminder after the tool token expires, and stops on revocation", async () => {
    const clock = { current: new Date(START) };
    const sends: HostSendRequest[] = [];
    const daemon = boot(clock, sends);
    const advance = (seconds: number) => {
      clock.current = new Date(clock.current.getTime() + seconds * 1000);
    };
    const connectorToken = (
      await daemon.app.inject({
        method: "POST",
        url: "/v1/connectors",
        headers: operator,
        payload: { adapter: "test-host", hostInstanceId: "host-a" },
      })
    ).json().token as string;
    const connector = { authorization: `Bearer ${connectorToken}` };
    const register = async (externalId: string) =>
      (
        await daemon.app.inject({
          method: "POST",
          url: "/v1/host-sessions",
          headers: { ...connector, "idempotency-key": `register-${externalId}` },
          payload: {
            externalId,
            providerSessionId: `${externalId}-p`,
            hostEpoch: "epoch-1",
            leaseSeconds: 300,
          },
        })
      ).json();
    const keeper = await register("thread-keeper");
    const revoked = await register("thread-revoked");
    const schedule = async (access: { token: string }, key: string) =>
      daemon.app.inject({
        method: "POST",
        url: "/v1/schedules",
        headers: { authorization: `Bearer ${access.token}`, "idempotency-key": key },
        payload: {
          body: "Resume the long task.",
          trigger: { type: "after", delaySeconds: 9 * 3600 },
        },
      });
    expect((await schedule(keeper, "nine-hours")).statusCode).toBe(201);
    const blockedId = (await schedule(revoked, "nine-hours")).json().schedule.scheduleId as string;

    const revoke = await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${revoked.hostSessionId}/revoke`,
      headers: { ...connector, "idempotency-key": "revoke-1" },
      payload: { reason: "operator request" },
    });
    expect(revoke.statusCode).toBe(200);

    // The host keeps the session alive; the 8-hour tool token still expires.
    for (let elapsed = 0; elapsed < 9 * 3600; elapsed += 240) {
      advance(240);
      const beat = await daemon.app.inject({
        method: "POST",
        url: `/v1/host-sessions/${keeper.hostSessionId}/heartbeat`,
        headers: connector,
        payload: { hostEpoch: "epoch-1", leaseSeconds: 300 },
      });
      expect(beat.statusCode).toBe(200);
    }
    const expired = await daemon.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${keeper.token}` },
    });
    expect(expired.statusCode).toBe(401);

    await daemon.loop.runOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ fromAgentId: keeper.agentId, mode: "wake" });

    const blocked = await daemon.app.inject({
      method: "GET",
      url: `/v1/schedules/${blockedId}/occurrences`,
      headers: operator,
    });
    expect(blocked.json().items.map((item: { state: string }) => item.state)).not.toContain(
      "host_accepted",
    );
  });

  it("schedules another agent only through an explicit operator grant", async () => {
    const clock = { current: new Date(START) };
    const sends: HostSendRequest[] = [];
    const daemon = boot(clock, sends);
    const connectorToken = (
      await daemon.app.inject({
        method: "POST",
        url: "/v1/connectors",
        headers: operator,
        payload: { adapter: "test-host", hostInstanceId: "host-a" },
      })
    ).json().token as string;
    const register = async (externalId: string) =>
      (
        await daemon.app.inject({
          method: "POST",
          url: "/v1/host-sessions",
          headers: { authorization: `Bearer ${connectorToken}`, "idempotency-key": externalId },
          payload: {
            externalId,
            providerSessionId: `${externalId}-p`,
            hostEpoch: "e1",
            leaseSeconds: 300,
          },
        })
      ).json();
    const lead = await register("thread-lead");
    const child = await register("thread-child");
    const wakeChild = (key: string) =>
      daemon.app.inject({
        method: "POST",
        url: "/v1/schedules",
        headers: { authorization: `Bearer ${lead.token}`, "idempotency-key": key },
        payload: {
          targetAgentId: child.agentId,
          body: "Check in with the lead.",
          trigger: { type: "after", delaySeconds: 60 },
        },
      });

    const refused = await wakeChild("wake-child-1");
    expect(refused.statusCode).toBe(403);

    const selfGrant = await daemon.app.inject({
      method: "POST",
      url: "/v1/schedule-grants",
      headers: { authorization: `Bearer ${lead.token}` },
      payload: { ownerAgentId: lead.agentId, targetAgentId: child.agentId },
    });
    expect(selfGrant.statusCode).toBe(403);

    const granted = await daemon.app.inject({
      method: "POST",
      url: "/v1/schedule-grants",
      headers: operator,
      payload: { ownerAgentId: lead.agentId, targetAgentId: child.agentId },
    });
    expect(granted.statusCode).toBe(200);
    const accepted = await wakeChild("wake-child-2");
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().schedule).toMatchObject({
      ownerAgentId: lead.agentId,
      targetAgentId: child.agentId,
    });

    clock.current = new Date(Date.parse(START) + 60_000);
    await daemon.loop.runOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ fromAgentId: lead.agentId });
    expect(sends[0]?.binding.agentId).toBe(child.agentId);
  });

  it("lets a trusted host publish named events but not agents", async () => {
    const clock = { current: new Date(START) };
    const daemon = boot(clock, []);
    const connectorToken = (
      await daemon.app.inject({
        method: "POST",
        url: "/v1/connectors",
        headers: operator,
        payload: { adapter: "test-host", hostInstanceId: "host-a" },
      })
    ).json().token as string;
    const published = await daemon.app.inject({
      method: "POST",
      url: "/v1/schedule-events",
      headers: { authorization: `Bearer ${connectorToken}`, "idempotency-key": "build-42" },
      payload: { eventName: "build-finished", occurredAt: START, payload: { ok: true } },
    });
    expect(published.statusCode).toBe(202);
    const capabilities = await daemon.app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { authorization: `Bearer ${connectorToken}` },
    });
    expect(capabilities.json().identity).toEqual({ automaticProvisioning: true });
    expect(capabilities.json().adapters).toEqual([
      expect.objectContaining({ name: "test-host", available: true, wake: true, context: false }),
    ]);
  });

  it("keeps the operator credential management-only for hosted agents", async () => {
    const clock = { current: new Date(START) };
    const daemon = boot(clock, []);
    const me = await daemon.app.inject({ method: "GET", url: "/v1/me", headers: operator });
    expect(me.json()).toMatchObject({ kind: "operator", principalId: "operator" });
    // The operator cannot impersonate a host connector to mint agent credentials.
    const provision = await daemon.app.inject({
      method: "POST",
      url: "/v1/host-sessions",
      headers: { ...operator, "idempotency-key": "op-provision" },
      payload: { externalId: "t", providerSessionId: "p", hostEpoch: "e" },
    });
    expect(provision.statusCode).toBe(403);
  });

  it("closes once, stopping the timer before the store", async () => {
    const clock = { current: new Date(START) };
    const daemon = boot(clock, []);
    const address = await daemon.listen({ host: "127.0.0.1", port: 0 });
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(daemon.loop.status().state).toBe("stopped");
    daemon.loop.start();
    expect(daemon.loop.status().state).toBe("running");
    await Promise.all([daemon.close(), daemon.close()]);
    expect(daemon.loop.status().state).toBe("stopped");
    daemons.splice(daemons.indexOf(daemon), 1);
  });
});
