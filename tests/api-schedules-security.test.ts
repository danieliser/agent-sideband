import { afterEach, describe, expect, it } from "vitest";

import type { ApiGrant, AuthenticatedPrincipal } from "../src/api/auth.js";
import { allApiGrants, agentApiGrants } from "../src/api/auth.js";
import { buildAgentSidebandServer } from "../src/api/server.js";
import type { HostAdapter } from "../src/core/host-adapter.js";
import { AgentSideband } from "../src/core/sideband.js";
import { Scheduler } from "../src/scheduling/scheduler.js";
import { SqliteScheduleStore } from "../src/scheduling/store.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";

const stores: SqliteSidebandStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = SqliteSidebandStore.open(":memory:");
  stores.push(store);
  const schedules = SqliteScheduleStore.attach(store);
  store.registerAgent({ agentId: "worker" });
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const host: HostAdapter = {
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
    send: async () => ({ stage: "accepted", receiptId: "receipt" }),
    interrupt: unused,
    stop: unused,
    inspect: unused,
  };
  store.bindAgent({
    bindingId: "binding-worker",
    agentId: "worker",
    adapter: "test-host",
    hostInstanceId: "local",
    externalId: "worker",
    state: "idle",
    capabilities: { wake: true, context: false },
    actorPrincipalId: "operator",
  });
  const sideband = new AgentSideband({ store, adapters: [host] });
  const scheduler = new Scheduler<AuthenticatedPrincipal>({
    store,
    sideband,
    schedules,
    now: () => new Date("2026-10-08T12:00:00.000Z"),
    authorizer: {
      authorizeCreate: ({ caller, principalId, targetAgentId }) => ({
        allowed: caller.kind === "operator" || caller.agentId === targetAgentId,
        reason: "not allowed",
        ownerPrincipalId: principalId,
        ownerAgentId: caller.kind === "operator" ? null : caller.agentId,
        targetAgentId,
        grantId: null,
        grantEpoch: 0,
      }),
      authorizeDispatch: () => ({ allowed: true, reason: "ok", retryable: false }),
    },
  });
  const principals = new Map<string, AuthenticatedPrincipal>([
    [
      "operator",
      {
        kind: "operator",
        principalId: "operator",
        agentId: "operator",
        source: "http",
        sourceInstanceId: "test",
        grants: allApiGrants,
      },
    ],
    [
      "agent",
      {
        kind: "agent",
        principalId: "agent:worker",
        agentId: "worker",
        source: "http",
        sourceInstanceId: "test",
        grants: agentApiGrants,
      },
    ],
    [
      "connector",
      {
        kind: "connector",
        principalId: "connector:test",
        agentId: null,
        source: "http",
        sourceInstanceId: "test",
        grants: new Set<ApiGrant>(["schedules:create"]),
      },
    ],
    [
      "service",
      {
        kind: "service",
        principalId: "service:test",
        agentId: null,
        source: "http",
        sourceInstanceId: "test",
        grants: new Set<ApiGrant>(["schedules:create"]),
      },
    ],
  ]);
  const app = buildAgentSidebandServer({
    store,
    sideband,
    scheduling: { scheduler, schedules },
    authenticate: (request) =>
      principals.get((request.headers.authorization ?? "").slice(7)) ?? null,
  });
  return app;
}

function post(app: ReturnType<typeof setup>, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/v1/schedules",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": `key-${token}` },
    payload: { body: "Reminder", trigger: { type: "after", delaySeconds: 60 }, ...payload },
  });
}

describe("schedule HTTP ownership security", () => {
  it("allows an operator reminder for an explicit target without inventing an owner agent", async () => {
    const app = setup();
    const response = await post(app, "operator", { targetAgentId: "worker" });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().schedule).toMatchObject({
      ownerAgentId: null,
      targetAgentId: "worker",
    });
  });

  it("requires an explicit target for an operator without using its placeholder agent id", async () => {
    const app = setup();
    const response = await post(app, "operator", {});
    expect(response.statusCode).toBe(403);
  });

  it("keeps the agent self-target default", async () => {
    const app = setup();
    const response = await post(app, "agent", {});
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().schedule).toMatchObject({
      ownerAgentId: "worker",
      targetAgentId: "worker",
    });
  });

  it.each(["connector", "service"])(
    "rejects %s credentials even when granted schedule creation",
    async (token) => {
      const app = setup();
      const response = await post(app, token, { targetAgentId: "worker" });
      expect(response.statusCode).toBe(403);
    },
  );
});
