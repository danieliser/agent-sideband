import { afterEach, describe, expect, it } from "vitest";

import { buildAgentSidebandServer } from "../src/api/server.js";
import { allApiGrants, staticBearerAuthenticator } from "../src/api/auth.js";
import { AgentSideband } from "../src/core/sideband.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";

const token = "test-token-that-is-long-enough-for-production-parity";
const openStores: SqliteSidebandStore[] = [];

function setup() {
  const store = SqliteSidebandStore.open(":memory:");
  openStores.push(store);
  const sideband = new AgentSideband({ store, adapters: [] });
  return {
    app: buildAgentSidebandServer({
      sideband,
      store,
      authenticate: staticBearerAuthenticator({
        token,
        principal: {
          principalId: "lead-principal",
          agentId: "lead",
          source: "http",
          sourceInstanceId: "api-test",
          grants: allApiGrants,
        },
      }),
    }),
    store,
  };
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

describe("Agent Sideband HTTP API", () => {
  it("keeps health public and every coordination route authenticated", async () => {
    const { app } = setup();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const unauthorized = await app.inject({ method: "GET", url: "/v1/agents" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({
      error: expect.objectContaining({ code: "UNAUTHORIZED" }),
    });
  });

  it("registers identities and delivers a durable direct message", async () => {
    const { app } = setup();
    const headers = { authorization: `Bearer ${token}` };
    for (const agentId of ["lead", "reviewer"]) {
      const response = await app.inject({
        method: "PUT",
        url: `/v1/agents/${agentId}`,
        headers,
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    }

    const sent = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...headers, "idempotency-key": "api-send-1" },
      payload: {
        fromAgentId: "reviewer",
        target: { type: "agent", id: "reviewer" },
        correlationId: "task-1",
        body: "Review this.",
        messageClass: "request",
      },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toEqual(
      expect.objectContaining({
        fromAgentId: "lead",
        provenance: expect.objectContaining({ authenticatedPrincipalId: "lead-principal" }),
      }),
    );

    const inbox = await app.inject({ method: "GET", url: "/v1/agents/reviewer/inbox", headers });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toEqual({
      items: [expect.objectContaining({ body: "Review this.", recipientAgentIds: ["reviewer"] })],
      next: null,
    });
  });

  it("rejects an idempotency key reused with a changed request", async () => {
    const { app, store } = setup();
    store.registerAgent({ agentId: "lead" });
    store.registerAgent({ agentId: "two" });
    const headers = { authorization: `Bearer ${token}` };
    const payload = {
      target: { type: "agent", id: "two" },
      correlationId: "work-1",
      body: "Original",
      messageClass: "request",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/messages",
          headers: { ...headers, "idempotency-key": "same-key" },
          payload,
        })
      ).statusCode,
    ).toBe(201);
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...headers, "idempotency-key": "same-key" },
      payload: { ...payload, body: "Changed" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    });
  });

  it("does not expose a public route for forging host adoption receipts", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/operations/untrusted/receipts",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        receipt: { stage: "adopted", receiptId: "forged" },
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("attributes delegated inbox actions to the authenticated principal", async () => {
    const { app, store } = setup();
    store.registerAgent({ agentId: "lead" });
    store.registerAgent({ agentId: "reviewer" });
    const message = store.sendMessage({
      idempotencyKey: "delegated-send",
      fromAgentId: "lead",
      target: { type: "agent", id: "reviewer" },
      correlationId: "delegated-work",
      body: "Please handle this.",
      messageClass: "request",
      provenance: {
        authenticatedPrincipalId: "lead-principal",
        source: "http",
        sourceInstanceId: "api-test",
        sourceOperationId: "delegated-send",
        trust: "untrusted",
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/messages/${message.messageId}/claim`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        recipientAgentId: "reviewer",
        consumerId: "admin-consumer",
        leaseSeconds: 30,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(
      store
        .listEvents({ afterSequence: 0, limit: 100 })
        .find((event) => event.type === "message.claimed"),
    ).toEqual(expect.objectContaining({ actorPrincipalId: "lead-principal" }));
  });

  it("derives self-service claim and acknowledgement identity from the credential", async () => {
    const { app, store } = setup();
    store.registerAgent({ agentId: "lead" });
    store.registerAgent({ agentId: "sender" });
    const message = store.sendMessage({
      idempotencyKey: "self-service-send",
      fromAgentId: "sender",
      target: { type: "agent", id: "lead" },
      correlationId: "self-service-work",
      body: "Handle this without accepting a caller-supplied identity.",
      messageClass: "request",
      provenance: {
        authenticatedPrincipalId: "sender-principal",
        source: "http",
        sourceInstanceId: "api-test",
        sourceOperationId: "self-service-send",
        trust: "untrusted",
      },
    });
    const headers = { authorization: `Bearer ${token}` };

    const claimed = await app.inject({
      method: "POST",
      url: `/v1/inbox/${message.messageId}/claim`,
      headers,
      payload: { consumerId: "lead-worker", leaseSeconds: 30, recipientAgentId: "sender" },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toEqual(
      expect.objectContaining({ recipientAgentId: "lead", status: "claimed" }),
    );

    const acknowledged = await app.inject({
      method: "POST",
      url: `/v1/inbox/${message.messageId}/ack`,
      headers,
      payload: {
        claimToken: claimed.json().claimToken,
        receiptId: "self-service-receipt",
        recipientAgentId: "sender",
      },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toEqual(
      expect.objectContaining({ recipientAgentId: "lead", status: "delivered" }),
    );
  });

  it("derives self-service release identity from the credential", async () => {
    const { app, store } = setup();
    store.registerAgent({ agentId: "lead" });
    store.registerAgent({ agentId: "sender" });
    const message = store.sendMessage({
      idempotencyKey: "self-service-release-send",
      fromAgentId: "sender",
      target: { type: "agent", id: "lead" },
      correlationId: "self-service-release-work",
      body: "Release this claim.",
      messageClass: "request",
      provenance: {
        authenticatedPrincipalId: "sender-principal",
        source: "http",
        sourceInstanceId: "api-test",
        sourceOperationId: "self-service-release-send",
        trust: "untrusted",
      },
    });
    const headers = { authorization: `Bearer ${token}` };
    const claimed = await app.inject({
      method: "POST",
      url: `/v1/inbox/${message.messageId}/claim`,
      headers,
      payload: { consumerId: "lead-worker", leaseSeconds: 30 },
    });
    const released = await app.inject({
      method: "POST",
      url: `/v1/inbox/${message.messageId}/release`,
      headers,
      payload: { claimToken: claimed.json().claimToken, recipientAgentId: "sender" },
    });

    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual(
      expect.objectContaining({ recipientAgentId: "lead", status: "pending" }),
    );
  });
});
