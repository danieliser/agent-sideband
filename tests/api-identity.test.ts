import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSidebandDaemon, type SidebandDaemon } from "../src/api/daemon.js";

const START = "2026-10-08T12:00:00.000Z";
const OPERATOR = "operator-token-that-is-long-enough-for-the-daemon";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function boot() {
  const directory = mkdtempSync(join(tmpdir(), "sideband-identity-api-"));
  const clock = { current: new Date(START) };
  const daemon = createSidebandDaemon({
    database: join(directory, "sideband.sqlite"),
    operatorToken: OPERATOR,
    publicUrl: "http://127.0.0.1:7341",
    now: () => new Date(clock.current),
    scheduler: { autoStart: false },
  });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => daemon.close());
  return {
    daemon,
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

async function enroll(daemon: SidebandDaemon, hostInstanceId = "host-a") {
  const response = await daemon.app.inject({
    method: "POST",
    url: "/v1/connectors",
    headers: bearer(OPERATOR),
    payload: { adapter: "test-host", hostInstanceId },
  });
  expect(response.statusCode).toBe(201);
  return response.json().token as string;
}

async function register(
  daemon: SidebandDaemon,
  connectorToken: string,
  externalId: string,
  key = `register-${externalId}`,
  extra: Record<string, unknown> = {},
) {
  return daemon.app.inject({
    method: "POST",
    url: "/v1/host-sessions",
    headers: bearer(connectorToken, key),
    payload: { externalId, providerSessionId: `${externalId}-p1`, hostEpoch: "epoch-1", ...extra },
  });
}

describe("operator and connector provisioning API", () => {
  it("issues a host-scoped connector once and keeps it out of agent and operator paths", async () => {
    const { daemon } = boot();
    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: bearer(OPERATOR),
      payload: { adapter: "test-host", hostInstanceId: "host-a" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const connector = response.json().token as string;
    expect(connector).toMatch(/^sbct_/);

    const again = await daemon.app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: bearer(OPERATOR),
      payload: { adapter: "test-host", hostInstanceId: "host-a" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("CREDENTIAL_ALREADY_ISSUED");
    expect(again.body).not.toContain("sbct_");

    // The connector cannot manage connectors, and the operator cannot pose as a host.
    const connectorManage = await daemon.app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: bearer(connector),
      payload: { adapter: "test-host", hostInstanceId: "host-z" },
    });
    expect(connectorManage.statusCode).toBe(403);
    const operatorRegister = await register(daemon, OPERATOR, "thread-1");
    expect(operatorRegister.statusCode).toBe(403);
  });

  it("provisions a stable agent identity with its own narrow credential", async () => {
    const { daemon } = boot();
    const connector = await enroll(daemon);
    const missingKey = await daemon.app.inject({
      method: "POST",
      url: "/v1/host-sessions",
      headers: bearer(connector),
      payload: { externalId: "thread-1", providerSessionId: "p1", hostEpoch: "epoch-1" },
    });
    expect(missingKey.statusCode).toBe(422);

    const issued = await register(daemon, connector, "thread-1");
    expect(issued.statusCode).toBe(201);
    expect(issued.headers["cache-control"]).toBe("no-store");
    const access = issued.json();
    expect(access).toMatchObject({
      token: expect.stringMatching(/^sbat_/),
      generation: 1,
      apiUrl: "http://127.0.0.1:7341",
    });

    const replay = await register(daemon, connector, "thread-1");
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toMatchObject({
      code: "CREDENTIAL_ALREADY_ISSUED",
      details: { agentId: access.agentId, hostSessionId: access.hostSessionId },
    });
    expect(replay.body).not.toContain("sbat_");

    const me = await daemon.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(access.token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      kind: "agent",
      agentId: access.agentId,
      principalId: access.principalId,
      session: { hostSessionId: access.hostSessionId, externalId: "thread-1", generation: 1 },
      binding: { bindingId: access.bindingId, adapter: "test-host", active: true },
    });
    expect(me.body).not.toContain(access.token);
    expect(me.json().grants).not.toContain("admin");

    for (const [method, url] of [
      ["GET", "/v1/events"],
      ["POST", "/v1/connectors"],
      ["POST", "/v1/host-sessions"],
      ["POST", `/v1/agents/${access.agentId}/stop`],
      ["PUT", "/v1/agents/somebody"],
      ["POST", "/v1/schedule-events"],
    ] as const) {
      const response = await daemon.app.inject({
        method,
        url,
        headers: bearer(access.token, "forbidden-probe"),
        payload: {},
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("refuses spoofed host tuples and caller-chosen identities", async () => {
    const { daemon } = boot();
    const connector = await enroll(daemon);
    const otherHost = await register(daemon, connector, "thread-1", "spoof-host", {
      hostInstanceId: "host-b",
    });
    expect(otherHost.statusCode).toBe(403);
    const alias = await register(daemon, connector, "thread-1", "spoof-alias", {
      requestedAgentId: "lead",
    });
    expect(alias.statusCode).toBe(403);
    const named = await register(daemon, connector, "thread-1", "spoof-agent", { agentId: "lead" });
    expect(named.statusCode).toBe(422);
    expect(named.json().error.code).toBe("IDENTITY_FIELD_REJECTED");
  });

  it("isolates inboxes and stamps the sender from the credential", async () => {
    const { daemon } = boot();
    const connector = await enroll(daemon);
    const alice = (await register(daemon, connector, "thread-alice")).json();
    const bob = (await register(daemon, connector, "thread-bob")).json();

    const spoof = await daemon.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: bearer(alice.token, "spoof-1"),
      payload: {
        fromAgentId: bob.agentId,
        target: { type: "agent", id: bob.agentId },
        correlationId: "c-1",
        body: "Hello",
        messageClass: "request",
      },
    });
    expect(spoof.statusCode).toBe(422);

    const sent = await daemon.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: bearer(alice.token, "send-1"),
      payload: {
        target: { type: "agent", id: bob.agentId },
        correlationId: "c-1",
        body: "Hello",
        messageClass: "request",
      },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      fromAgentId: alice.agentId,
      provenance: { authenticatedPrincipalId: alice.principalId },
    });

    const bobInbox = await daemon.app.inject({
      method: "GET",
      url: "/v1/inbox",
      headers: bearer(bob.token),
    });
    expect(bobInbox.json().items).toHaveLength(1);
    const aliceInbox = await daemon.app.inject({
      method: "GET",
      url: "/v1/inbox",
      headers: bearer(alice.token),
    });
    expect(aliceInbox.json().items).toHaveLength(0);
    const peek = await daemon.app.inject({
      method: "GET",
      url: `/v1/agents/${bob.agentId}/inbox`,
      headers: bearer(alice.token),
    });
    expect(peek.statusCode).toBe(403);
    const steal = await daemon.app.inject({
      method: "POST",
      url: `/v1/inbox/${sent.json().messageId}/claim`,
      headers: bearer(alice.token),
      payload: { consumerId: "alice", leaseSeconds: 30 },
    });
    expect(steal.statusCode).not.toBe(200);
    const legacySteal = await daemon.app.inject({
      method: "POST",
      url: `/v1/messages/${sent.json().messageId}/claim`,
      headers: bearer(alice.token),
      payload: { recipientAgentId: bob.agentId, consumerId: "alice", leaseSeconds: 30 },
    });
    expect(legacySteal.statusCode).toBe(403);
  });

  it("rejects expired, rotated, revoked and offline credentials", async () => {
    const { daemon, advance } = boot();
    const connector = await enroll(daemon);
    const first = (await register(daemon, connector, "thread-1")).json();

    const rotated = await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${first.hostSessionId}/rotate`,
      headers: bearer(connector),
      payload: { hostEpoch: "epoch-1", rotationId: "rot-1" },
    });
    expect(rotated.statusCode).toBe(201);
    const current = rotated.json().token as string;
    expect(
      (await daemon.app.inject({ method: "GET", url: "/v1/me", headers: bearer(first.token) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await daemon.app.inject({ method: "GET", url: "/v1/me", headers: bearer(current) }))
        .statusCode,
    ).toBe(200);

    // A lapsed lease makes the tool credential unusable until the host heartbeats again.
    advance(61);
    expect(
      (await daemon.app.inject({ method: "GET", url: "/v1/me", headers: bearer(current) }))
        .statusCode,
    ).toBe(401);
    const heartbeat = await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${first.hostSessionId}/heartbeat`,
      headers: bearer(connector),
      payload: { hostEpoch: "epoch-1", leaseSeconds: 60 },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(
      (await daemon.app.inject({ method: "GET", url: "/v1/me", headers: bearer(current) }))
        .statusCode,
    ).toBe(200);
    const staleEpoch = await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${first.hostSessionId}/heartbeat`,
      headers: bearer(connector),
      payload: { hostEpoch: "epoch-0", leaseSeconds: 60 },
    });
    expect(staleEpoch.statusCode).toBe(403);

    const revoked = await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${first.hostSessionId}/revoke`,
      headers: bearer(connector, "revoke-1"),
      payload: { reason: "operator request" },
    });
    expect(revoked.statusCode).toBe(200);
    const denied = await daemon.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(current),
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("UNAUTHORIZED");

    const restored = await daemon.app.inject({
      method: "POST",
      url: `/v1/agents/${first.agentId}/access/restore`,
      headers: bearer(OPERATOR),
    });
    expect(restored.statusCode).toBe(200);
    const second = await register(daemon, connector, "thread-1", "register-again", {
      providerSessionId: "thread-1-p2",
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().agentId).toBe(first.agentId);

    const offline = await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${second.json().hostSessionId}/offline`,
      headers: bearer(connector, "offline-1"),
      payload: { reason: "session stopped" },
    });
    expect(offline.statusCode).toBe(200);
    expect(
      (
        await daemon.app.inject({
          method: "GET",
          url: "/v1/me",
          headers: bearer(second.json().token),
        })
      ).statusCode,
    ).toBe(401);

    const revokeConnector = await daemon.app.inject({
      method: "POST",
      url: "/v1/connectors/revoke",
      headers: bearer(OPERATOR),
      payload: { adapter: "test-host", hostInstanceId: "host-a" },
    });
    expect(revokeConnector.statusCode).toBe(200);
    expect((await register(daemon, connector, "thread-2")).statusCode).toBe(401);
  });
});
