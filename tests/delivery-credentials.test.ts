import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { T3_DELIVERY_CREDENTIAL_SCHEME, T3HostAdapter } from "../src/adapters/t3.js";
import {
  createSidebandDaemon,
  type HostAdapterFactory,
  type SidebandDaemon,
} from "../src/api/daemon.js";

const START = "2026-10-08T12:00:00.000Z";
const OPERATOR = "operator-token-that-is-long-enough-for-the-daemon";
const SCHEME = "t3-thread-mcp-v1";
const DELIVERY = "t3-delivery-secret-0123456789abcdef";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function boot(
  directory = mkdtempSync(join(tmpdir(), "sideband-delivery-")),
  adapters: readonly HostAdapterFactory[] = [],
) {
  const clock = { current: new Date(START) };
  const daemon = createSidebandDaemon({
    database: join(directory, "sideband.sqlite"),
    operatorToken: OPERATOR,
    adapters,
    now: () => new Date(clock.current),
    scheduler: { autoStart: false },
  });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => daemon.close());
  return {
    daemon,
    directory,
    clock,
    advance(seconds: number) {
      clock.current = new Date(clock.current.getTime() + seconds * 1000);
    },
  };
}

function bearer(token: string, key?: string) {
  return {
    authorization: `Bearer ${token}`,
    ...(key === undefined ? {} : { "idempotency-key": key }),
  };
}

async function enroll(daemon: SidebandDaemon, adapter = "t3", hostInstanceId = "env-1") {
  const response = await daemon.app.inject({
    method: "POST",
    url: "/v1/connectors",
    headers: bearer(OPERATOR),
    payload: { adapter, hostInstanceId },
  });
  expect(response.statusCode).toBe(201);
  return response.json().token as string;
}

interface Issued {
  readonly agentId: string;
  readonly hostSessionId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly token: string;
}

async function provision(
  daemon: SidebandDaemon,
  connector: string,
  providerSessionId = "mcp-gen-1",
  hostEpoch = "t3-epoch-1",
): Promise<Issued> {
  const response = await daemon.app.inject({
    method: "POST",
    url: "/v1/host-sessions",
    headers: bearer(connector, `t3-provision:${hostEpoch}:${providerSessionId}`),
    payload: {
      adapter: "t3",
      hostInstanceId: "env-1",
      externalId: "thread-1",
      providerSessionId,
      hostEpoch,
      leaseSeconds: 60,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Issued;
}

function credentialBody(issued: Issued, overrides: Record<string, unknown> = {}) {
  return {
    scheme: SCHEME,
    hostEpoch: "t3-epoch-1",
    generation: issued.generation,
    providerSessionId: "mcp-gen-1",
    capabilities: ["context-injection"],
    token: DELIVERY,
    expiresAt: "2026-10-08T20:00:00.000Z",
    ...overrides,
  };
}

async function push(
  daemon: SidebandDaemon,
  token: string,
  issued: Issued,
  overrides: Record<string, unknown> = {},
) {
  return daemon.app.inject({
    method: "PUT",
    url: `/v1/host-sessions/${encodeURIComponent(issued.hostSessionId)}/delivery-credential`,
    headers: bearer(token),
    payload: credentialBody(issued, overrides),
  });
}

function resolve(daemon: SidebandDaemon, issued: Issued) {
  return daemon.deliveryCredentials.resolve(daemon.store.getBinding(issued.bindingId), SCHEME);
}

async function setup() {
  const booted = boot();
  const connector = await enroll(booted.daemon);
  const issued = await provision(booted.daemon, connector);
  return { ...booted, connector, issued };
}

describe("delivery credential upload", () => {
  it("accepts the exact live session's credential from its own connector and never echoes it", async () => {
    const { daemon, connector, issued } = await setup();
    const response = await push(daemon, connector, issued);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      hostSessionId: issued.hostSessionId,
      generation: issued.generation,
      expiresAt: "2026-10-08T20:00:00.000Z",
    });
    expect(response.body).not.toContain(DELIVERY);
    expect(resolve(daemon, issued)).toEqual({
      scheme: SCHEME,
      token: DELIVERY,
      providerSessionId: "mcp-gen-1",
      generation: issued.generation,
      expiresAt: "2026-10-08T20:00:00.000Z",
    });
    expect(JSON.stringify(daemon.deliveryCredentials)).not.toContain(DELIVERY);
  });

  it("refuses agents, operators and a connector for another host", async () => {
    const { daemon, connector, issued } = await setup();
    const otherHost = await enroll(daemon, "t3", "env-2");
    for (const token of [issued.token, OPERATOR, otherHost]) {
      const response = await push(daemon, token, issued);
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(DELIVERY);
    }
    expect(resolve(daemon, issued)).toBeNull();
    // The rightful connector still can.
    expect((await push(daemon, connector, issued)).statusCode).toBe(200);
  });

  it("refuses a T3 scheme from a connector of another adapter", async () => {
    const { daemon } = boot();
    const foreign = await enroll(daemon, "other-host", "env-1");
    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/host-sessions",
      headers: bearer(foreign, "foreign-1"),
      payload: { externalId: "thread-1", providerSessionId: "mcp-gen-1", hostEpoch: "t3-epoch-1" },
    });
    const issued = response.json() as Issued;
    const refused = await push(daemon, foreign, issued);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.details.reason).toBe("ADAPTER_SCHEME_MISMATCH");
  });

  it.each([
    ["stale generation", { generation: 99 }, 409, "STALE_GENERATION"],
    ["another provider session", { providerSessionId: "mcp-gen-9" }, 409, "HOST_SESSION_MISMATCH"],
    ["another host epoch", { hostEpoch: "t3-epoch-0" }, 403, "FORBIDDEN"],
    ["an unknown scheme", { scheme: "bearer-v0" }, 422, "INVALID_ARGUMENT"],
    [
      "extra capabilities",
      { capabilities: ["context-injection", "sideband"] },
      422,
      "INVALID_ARGUMENT",
    ],
    ["an expired credential", { expiresAt: "2026-10-08T11:00:00.000Z" }, 422, "INVALID_ARGUMENT"],
    ["an over-long lifetime", { expiresAt: "2026-10-10T12:00:00.000Z" }, 422, "INVALID_ARGUMENT"],
    ["a Sideband credential", { token: "sbat_looks-like-an-agent-token" }, 422, "INVALID_ARGUMENT"],
    ["an extra field", { endpoint: "http://attacker.example" }, 422, "INVALID_ARGUMENT"],
  ])("refuses %s and discards the token", async (_name, overrides, status, code) => {
    const { daemon, connector, issued } = await setup();
    const response = await push(daemon, connector, issued, overrides);
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.body).not.toContain(DELIVERY);
    expect(resolve(daemon, issued)).toBeNull();
  });
});

describe("delivery credential lifetime", () => {
  it("drops on offline, and the heartbeat reports whether one is held", async () => {
    const { daemon, connector, issued } = await setup();
    const heartbeat = async () =>
      daemon.app.inject({
        method: "POST",
        url: `/v1/host-sessions/${issued.hostSessionId}/heartbeat`,
        headers: bearer(connector),
        payload: { hostEpoch: "t3-epoch-1", leaseSeconds: 60 },
      });
    expect((await heartbeat()).json().deliveryCredential).toBe("missing");
    await push(daemon, connector, issued);
    expect((await heartbeat()).json().deliveryCredential).toBe("held");
    await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${issued.hostSessionId}/offline`,
      headers: bearer(connector, "offline-1"),
      payload: { reason: "stopped" },
    });
    expect(resolve(daemon, issued)).toBeNull();
    expect(daemon.deliveryCredentials.size).toBe(0);
  });

  it("refuses after the lease lapses", async () => {
    const { daemon, connector, issued, advance } = await setup();
    await push(daemon, connector, issued);
    advance(61);
    expect(resolve(daemon, issued)).toBeNull();
  });

  it("refuses at the credential's own expiry", async () => {
    const { daemon, connector, issued, advance } = await setup();
    await push(daemon, connector, issued, { expiresAt: "2026-10-08T12:00:30.000Z" });
    advance(31);
    expect(resolve(daemon, issued)).toBeNull();
  });

  it("drops on generation replacement and accepts the new generation's push", async () => {
    const { daemon, connector, issued } = await setup();
    await push(daemon, connector, issued);
    const next = await provision(daemon, connector, "mcp-gen-2");
    expect(next.hostSessionId).toBe(issued.hostSessionId);
    expect(next.generation).not.toBe(issued.generation);
    expect(resolve(daemon, next)).toBeNull();
    // A push that names the old generation is stale.
    expect((await push(daemon, connector, issued)).statusCode).toBe(409);
    const fresh = await push(daemon, connector, next, { providerSessionId: "mcp-gen-2" });
    expect(fresh.statusCode).toBe(200);
    expect(resolve(daemon, next)?.providerSessionId).toBe("mcp-gen-2");
    // The superseded binding never resolves the new credential.
    expect(
      daemon.deliveryCredentials.resolve(
        { ...daemon.store.getBinding(next.bindingId), generation: issued.generation },
        SCHEME,
      ),
    ).toBeNull();
  });

  it("drops on connector revoke and connector rotation", async () => {
    for (const action of ["revoke", "rotate"] as const) {
      const { daemon, connector, issued } = await setup();
      await push(daemon, connector, issued);
      const response = await daemon.app.inject({
        method: "POST",
        url: `/v1/connectors/${action}`,
        headers: bearer(OPERATOR),
        payload: { adapter: "t3", hostInstanceId: "env-1", rotationId: "rotation-1" },
      });
      expect(response.statusCode).toBeLessThan(300);
      expect(resolve(daemon, issued)).toBeNull();
    }
  });

  it("drops when the agent's access is revoked", async () => {
    const { daemon, connector, issued } = await setup();
    await push(daemon, connector, issued);
    await daemon.app.inject({
      method: "POST",
      url: `/v1/agents/${issued.agentId}/access/revoke`,
      headers: bearer(OPERATOR),
      payload: { reason: "test" },
    });
    expect(resolve(daemon, issued)).toBeNull();
  });

  it("is dropped when the T3 adapter reports a rejection for that provider session", async () => {
    const { daemon, connector, issued } = await setup();
    await push(daemon, connector, issued);
    const binding = daemon.store.getBinding(issued.bindingId);
    daemon.deliveryCredentials.reject(binding, "mcp-gen-other");
    expect(resolve(daemon, issued)).not.toBeNull();
    daemon.deliveryCredentials.reject(binding, "mcp-gen-1");
    expect(resolve(daemon, issued)).toBeNull();
  });

  it("is never persisted and a restarted daemon must await redelivery", async () => {
    const first = await setup();
    await push(first.daemon, first.connector, first.issued);
    await first.daemon.app.inject({
      method: "GET",
      url: "/v1/events?limit=1000",
      headers: bearer(OPERATOR),
    });
    const events = await first.daemon.app.inject({
      method: "GET",
      url: "/v1/events?limit=1000",
      headers: bearer(OPERATOR),
    });
    expect(events.body).not.toContain(DELIVERY);
    await first.daemon.close();
    expect(first.daemon.deliveryCredentials.size).toBe(0);
    for (const file of readdirSync(first.directory)) {
      expect(readFileSync(join(first.directory, file)).includes(DELIVERY)).toBe(false);
    }

    const restarted = boot(first.directory);
    expect(resolve(restarted.daemon, first.issued)).toBeNull();
    const heartbeat = await restarted.daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${first.issued.hostSessionId}/heartbeat`,
      headers: bearer(first.connector),
      payload: { hostEpoch: "t3-epoch-1", leaseSeconds: 60 },
    });
    expect(heartbeat.json().deliveryCredential).toBe("missing");
    expect((await push(restarted.daemon, first.connector, first.issued)).statusCode).toBe(200);
    expect(resolve(restarted.daemon, first.issued)?.token).toBe(DELIVERY);
  });
});

describe("per-target context readiness through the API", () => {
  it("reports context ready only while this binding's credential is held, and still accepts context schedules", async () => {
    const t3: HostAdapterFactory = {
      name: "t3",
      create: ({ deliveryCredentials }) =>
        new T3HostAdapter({
          baseUrl: "http://127.0.0.1:3773",
          token: "t3-environment-token",
          // Readiness reporting must not touch the host.
          fetch: () => Promise.reject(new Error("no host I/O expected")),
          now: () => START,
          resolveDeliveryCredential: (binding) =>
            deliveryCredentials.resolve(binding, T3_DELIVERY_CREDENTIAL_SCHEME),
          rejectDeliveryCredential: (binding, providerSessionId) =>
            deliveryCredentials.reject(binding, providerSessionId),
        }),
    };
    const { daemon } = boot(undefined, [t3]);
    const connector = await enroll(daemon);
    const issued = await provision(daemon, connector);
    const delivery = async () =>
      (
        await daemon.app.inject({
          method: "GET",
          url: "/v1/capabilities",
          headers: bearer(issued.token),
        })
      ).json().delivery;

    expect(await delivery()).toMatchObject({
      adapter: "t3",
      wake: true,
      context: false,
      contextSupported: true,
      both: false,
    });
    // Supported but not ready: the schedule is accepted; dispatch waits for readiness.
    const scheduled = await daemon.app.inject({
      method: "POST",
      url: "/v1/schedules",
      headers: bearer(issued.token, "context-schedule-1"),
      payload: {
        body: "Background note.",
        trigger: { type: "after", delaySeconds: 600 },
        deliveryMode: "context",
      },
    });
    expect(scheduled.statusCode).toBeLessThan(300);

    await push(daemon, connector, issued);
    expect(await delivery()).toMatchObject({ context: true, contextSupported: true, both: true });

    await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${issued.hostSessionId}/offline`,
      headers: bearer(connector, "offline-ready-1"),
      payload: { reason: "stopped" },
    });
    expect(resolve(daemon, issued)).toBeNull();
  });
});
