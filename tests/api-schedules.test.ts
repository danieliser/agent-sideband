import { afterEach, describe, expect, it } from "vitest";

import type { ApiGrant, AuthenticatedPrincipal } from "../src/api/auth.js";
import { agentApiGrants, allApiGrants } from "../src/api/auth.js";
import { buildAgentSidebandServer } from "../src/api/server.js";
import type {
  HostAdapter,
  HostAdapterCapabilities,
  HostContextInjectionRequest,
  HostOperationReceipt,
  HostSendRequest,
} from "../src/core/host-adapter.js";
import { AgentSideband } from "../src/core/sideband.js";
import { Scheduler } from "../src/scheduling/scheduler.js";
import { SqliteScheduleStore } from "../src/scheduling/store.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";

const START = "2026-10-08T12:00:00.000Z";
const WAKE_ONLY: HostAdapterCapabilities = {
  spawn: false,
  bind: false,
  wake: true,
  context: false,
  interrupt: false,
  stop: false,
  adoptionReceipts: false,
};

function fakeHost(name: string, capabilities: HostAdapterCapabilities) {
  const sends: HostSendRequest[] = [];
  const contexts: HostContextInjectionRequest[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const adapter: HostAdapter = {
    name,
    capabilities: async () => capabilities,
    spawn: unused,
    bind: unused,
    send: async (request): Promise<HostOperationReceipt> => {
      sends.push(request);
      return { stage: "accepted", receiptId: `receipt-${request.operationId}` };
    },
    interrupt: unused,
    stop: unused,
    inspect: unused,
    ...(capabilities.context
      ? {
          injectContext: async (request: HostContextInjectionRequest) => {
            contexts.push(request);
            return { stage: "accepted", receiptId: `context-${request.idempotencyKey}` } as const;
          },
        }
      : {}),
  };
  return { adapter, sends, contexts };
}

function agentPrincipal(agentId: string, grants: ReadonlySet<ApiGrant> = agentApiGrants) {
  return {
    kind: "agent",
    principalId: `agent:${agentId}`,
    agentId,
    source: "http",
    sourceInstanceId: "schedule-test",
    grants,
  } satisfies AuthenticatedPrincipal;
}

const stores: SqliteSidebandStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const clock = { current: new Date(START) };
  const now = () => new Date(clock.current);
  const store = SqliteSidebandStore.open(":memory:", { now });
  stores.push(store);
  const schedules = SqliteScheduleStore.attach(store, { now });
  const wakeHost = fakeHost("wake-host", WAKE_ONLY);
  const contextHost = fakeHost("context-host", { ...WAKE_ONLY, context: true });
  const sideband = new AgentSideband({
    store,
    adapters: [wakeHost.adapter, contextHost.adapter],
  });
  // Self-only policy standing in for the identity service, which has its own tests.
  const scheduler = new Scheduler<AuthenticatedPrincipal>({
    store,
    sideband,
    schedules,
    now,
    authorizer: {
      authorizeCreate: ({ caller, principalId, targetAgentId }) =>
        caller.agentId === targetAgentId
          ? {
              allowed: true,
              ownerPrincipalId: principalId,
              ownerAgentId: caller.agentId,
              targetAgentId,
              grantId: null,
              grantEpoch: 0,
            }
          : { allowed: false, reason: "self only" },
      authorizeDispatch: () => ({ allowed: true, reason: "ok", retryable: false }),
    },
  });
  for (const agentId of ["worker", "peer", "context-worker", "limited"]) {
    store.registerAgent({ agentId });
  }
  store.bindAgent({
    bindingId: "binding-worker",
    agentId: "worker",
    adapter: "wake-host",
    hostInstanceId: "local",
    externalId: "thread-worker",
    state: "idle",
    capabilities: { wake: true, context: false },
    actorPrincipalId: "operator",
  });
  store.bindAgent({
    bindingId: "binding-context-worker",
    agentId: "context-worker",
    adapter: "context-host",
    hostInstanceId: "local",
    externalId: "thread-context-worker",
    state: "idle",
    capabilities: { wake: true, context: true },
    actorPrincipalId: "operator",
  });
  const principals = new Map<string, AuthenticatedPrincipal>([
    ["worker-token", agentPrincipal("worker")],
    ["peer-token", agentPrincipal("peer")],
    ["context-token", agentPrincipal("context-worker")],
    ["limited-token", agentPrincipal("limited", new Set<ApiGrant>(["inbox:read"]))],
    [
      "operator-token",
      {
        kind: "operator",
        principalId: "operator",
        agentId: "operator",
        source: "http",
        sourceInstanceId: "schedule-test",
        grants: allApiGrants,
      },
    ],
  ]);
  const app = buildAgentSidebandServer({
    sideband,
    store,
    scheduling: { scheduler, schedules },
    authenticate: (request) => {
      const header = request.headers.authorization ?? "";
      return principals.get(header.replace(/^Bearer /, "")) ?? null;
    },
  });
  return {
    app,
    store,
    scheduler,
    wakeHost,
    contextHost,
    advance(seconds: number) {
      clock.current = new Date(clock.current.getTime() + seconds * 1000);
    },
  };
}

type Harness = ReturnType<typeof setup>;

function as(token: string, key?: string) {
  return {
    authorization: `Bearer ${token}`,
    ...(key === undefined ? {} : { "idempotency-key": key }),
  };
}

async function createSchedule(
  h: Harness,
  payload: Record<string, unknown>,
  key = "remind-30m",
  token = "worker-token",
) {
  return h.app.inject({ method: "POST", url: "/v1/schedules", headers: as(token, key), payload });
}

const in30Minutes = {
  name: "Review status",
  trigger: { type: "after", delaySeconds: 1800 },
  body: "Review the current checkpoint and continue the assigned work.",
};

describe("schedule HTTP API", () => {
  it("creates a self-targeted wake reminder and replays the exact key", async () => {
    const h = setup();
    const created = await createSchedule(h, in30Minutes);
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({
      replayed: false,
      receiptLevel: "scheduled",
      requestedTrigger: { type: "after", delaySeconds: 1800 },
      schedule: {
        ownerAgentId: "worker",
        targetAgentId: "worker",
        deliveryMode: "wake",
        status: "active",
        nextDueAt: "2026-10-08T12:30:00.000Z",
        trigger: { type: "at", at: "2026-10-08T12:30:00.000Z" },
      },
    });
    expect(body.schedule.ownerPrincipalId).toBeUndefined();

    h.advance(5);
    const replay = await createSchedule(h, in30Minutes);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      replayed: true,
      schedule: { scheduleId: body.schedule.scheduleId, nextDueAt: "2026-10-08T12:30:00.000Z" },
    });

    const conflict = await createSchedule(h, { ...in30Minutes, body: "Something else." });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false });
  });

  it("requires an idempotency key and a schedule grant", async () => {
    const h = setup();
    const missing = await h.app.inject({
      method: "POST",
      url: "/v1/schedules",
      headers: as("worker-token"),
      payload: in30Minutes,
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe("INVALID_ARGUMENT");

    const limited = await createSchedule(h, in30Minutes, "limited-1", "limited-token");
    expect(limited.statusCode).toBe(403);
    expect(limited.json().error.code).toBe("FORBIDDEN");

    const anonymous = await h.app.inject({
      method: "POST",
      url: "/v1/schedules",
      headers: { "idempotency-key": "anon" },
      payload: in30Minutes,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("rejects caller-supplied identity fields instead of trusting them", async () => {
    const h = setup();
    for (const field of ["ownerAgentId", "ownerPrincipalId", "fromAgentId", "principalId"]) {
      const response = await createSchedule(
        h,
        { ...in30Minutes, [field]: "peer" },
        `spoof-${field}`,
      );
      expect(response.statusCode, field).toBe(422);
      expect(response.json().error).toMatchObject({
        code: "IDENTITY_FIELD_REJECTED",
        details: { field },
      });
    }
    const list = await h.app.inject({
      method: "GET",
      url: "/v1/schedules",
      headers: as("worker-token"),
    });
    expect(list.json().items).toEqual([]);
  });

  it("normalizes absolute, interval and timezone-aware cron triggers", async () => {
    const h = setup();
    const at = await createSchedule(
      h,
      { name: "Wake", body: "Wake up.", trigger: { type: "at", at: "2026-10-09T09:00:00-04:00" } },
      "at-1",
    );
    expect(at.statusCode).toBe(201);
    expect(at.json().schedule.nextDueAt).toBe("2026-10-09T13:00:00.000Z");

    const cron = await createSchedule(
      h,
      {
        name: "Weekday review",
        body: "Run the recurring review.",
        trigger: { type: "cron", expression: "0 9 * * MON-FRI", timezone: "America/New_York" },
      },
      "cron-1",
    );
    expect(cron.statusCode).toBe(201);
    expect(cron.json().schedule).toMatchObject({
      trigger: { type: "cron", expression: "0 9 * * MON-FRI", timezone: "America/New_York" },
      // Thursday 08:00 in New York at START, so 09:00 EDT the same day.
      nextDueAt: "2026-10-08T13:00:00.000Z",
    });

    const interval = await createSchedule(
      h,
      { name: "Hourly", body: "Check in.", trigger: { type: "interval", everySeconds: 3600 } },
      "interval-1",
    );
    expect(interval.statusCode).toBe(201);
    expect(interval.json().schedule.nextDueAt).toBe("2026-10-08T13:00:00.000Z");

    for (const [key, trigger] of [
      ["bad-offset", { type: "at", at: "2026-10-09T09:00:00" }],
      ["bad-zone", { type: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" }],
      ["bad-delay", { type: "after", delaySeconds: 1.5 }],
      ["bad-kind", { type: "weekly" }],
      ["bad-shape", "tomorrow morning"],
    ] as const) {
      const response = await createSchedule(h, { name: "x", body: "x", trigger }, key);
      expect(response.statusCode, key).toBe(422);
      expect(response.json().error.code, key).toBe("INVALID_ARGUMENT");
    }
  });

  it("refuses other targets and unsupported context delivery without a silent fallback", async () => {
    const h = setup();
    const other = await createSchedule(h, { ...in30Minutes, targetAgentId: "peer" }, "other-1");
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("FORBIDDEN");

    const context = await createSchedule(h, { ...in30Minutes, deliveryMode: "context" }, "ctx-1");
    expect(context.statusCode).toBe(422);
    expect(context.json().error.code).toBe("CONTEXT_INJECTION_UNSUPPORTED");
    const both = await createSchedule(h, { ...in30Minutes, deliveryMode: "both" }, "both-1");
    expect(both.json().error.code).toBe("CONTEXT_INJECTION_UNSUPPORTED");

    const supported = await createSchedule(
      h,
      { ...in30Minutes, deliveryMode: "context" },
      "ctx-ok",
      "context-token",
    );
    expect(supported.statusCode).toBe(201);
    expect(supported.json().schedule.deliveryMode).toBe("context");

    const list = await h.app.inject({
      method: "GET",
      url: "/v1/schedules",
      headers: as("worker-token"),
    });
    expect(list.json().items).toEqual([]);
  });

  it("isolates schedule visibility and cancellation by credential", async () => {
    const h = setup();
    const created = (await createSchedule(h, in30Minutes)).json().schedule;
    const path = `/v1/schedules/${created.scheduleId}`;

    expect(
      (await h.app.inject({ method: "GET", url: path, headers: as("worker-token") })).statusCode,
    ).toBe(200);
    const hidden = await h.app.inject({ method: "GET", url: path, headers: as("peer-token") });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("SCHEDULE_NOT_FOUND");
    const peerList = await h.app.inject({
      method: "GET",
      url: "/v1/schedules",
      headers: as("peer-token"),
    });
    expect(peerList.json()).toEqual({ items: [], next: null });
    const operatorView = await h.app.inject({
      method: "GET",
      url: path,
      headers: as("operator-token"),
    });
    expect(operatorView.statusCode).toBe(200);

    const peerCancel = await h.app.inject({
      method: "POST",
      url: `${path}/cancel`,
      headers: as("peer-token", "peer-cancel"),
    });
    expect(peerCancel.statusCode).toBe(404);

    const cancelled = await h.app.inject({
      method: "POST",
      url: `${path}/cancel`,
      headers: as("worker-token", "cancel-1"),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      replayed: false,
      schedule: { status: "cancelled", nextDueAt: null },
      suppressedOccurrenceIds: [],
      inFlightOccurrenceIds: [],
    });
    const replay = await h.app.inject({
      method: "POST",
      url: `${path}/cancel`,
      headers: as("worker-token", "cancel-1"),
    });
    expect(replay.json().replayed).toBe(true);

    h.advance(3600);
    await h.scheduler.runDue();
    expect(h.wakeHost.sends).toHaveLength(0);
  });

  it("delivers a due reminder through the durable inbox with the owner as sender", async () => {
    const h = setup();
    const created = (await createSchedule(h, in30Minutes)).json().schedule;
    h.advance(1799);
    await h.scheduler.runDue();
    expect(h.wakeHost.sends).toHaveLength(0);
    h.advance(1);
    await h.scheduler.runDue();
    expect(h.wakeHost.sends).toHaveLength(1);
    expect(h.wakeHost.sends[0]).toMatchObject({ mode: "wake", fromAgentId: "worker" });

    const occurrences = await h.app.inject({
      method: "GET",
      url: `/v1/schedules/${created.scheduleId}/occurrences`,
      headers: as("worker-token"),
    });
    expect(occurrences.statusCode).toBe(200);
    const [occurrence] = occurrences.json().items;
    expect(occurrence).toMatchObject({
      nominalDueAt: "2026-10-08T12:30:00.000Z",
      state: "host_accepted",
      lateSeconds: 0,
    });

    const inbox = await h.app.inject({
      method: "GET",
      url: "/v1/inbox",
      headers: as("worker-token"),
    });
    const [message] = inbox.json().items;
    expect(message).toMatchObject({ messageId: occurrence.messageId, fromAgentId: "worker" });
    const claimed = await h.app.inject({
      method: "POST",
      url: `/v1/inbox/${message.messageId}/claim`,
      headers: as("worker-token"),
      payload: { consumerId: "worker-loop", leaseSeconds: 30 },
    });
    expect(claimed.json().status).toBe("claimed");
    const acked = await h.app.inject({
      method: "POST",
      url: `/v1/inbox/${message.messageId}/ack`,
      headers: as("worker-token"),
      payload: { claimToken: claimed.json().claimToken },
    });
    expect(acked.json().status).toBe("delivered");

    const detail = await h.app.inject({
      method: "GET",
      url: `/v1/schedules/${created.scheduleId}`,
      headers: as("worker-token"),
    });
    expect(detail.json()).toMatchObject({
      status: "completed",
      latestOccurrence: { occurrenceId: occurrence.occurrenceId, state: "host_accepted" },
    });
  });

  it("restricts named-event ingress to the operator or a trusted host", async () => {
    const h = setup();
    const event = { eventName: "build-finished", occurredAt: START, payload: { ok: true } };
    const agent = await h.app.inject({
      method: "POST",
      url: "/v1/schedule-events",
      headers: as("worker-token", "event-1"),
      payload: event,
    });
    expect(agent.statusCode).toBe(403);
    const operator = await h.app.inject({
      method: "POST",
      url: "/v1/schedule-events",
      headers: as("operator-token", "event-1"),
      payload: event,
    });
    expect(operator.statusCode).toBe(202);
    expect(operator.json()).toMatchObject({ eventId: "event-1", replayed: false });
  });
});

describe("capabilities and identity", () => {
  it("reports honest per-binding delivery capabilities", async () => {
    const h = setup();
    const worker = await h.app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: as("worker-token"),
    });
    expect(worker.statusCode).toBe(200);
    expect(worker.json()).toMatchObject({
      protocolVersion: 1,
      scheduling: {
        available: true,
        triggers: { after: true, at: true, interval: true, cron: true },
        cronFields: 5,
        cronDayMatch: "and",
        defaultTarget: "self",
        defaultDeliveryMode: "wake",
      },
      delivery: { adapter: "wake-host", wake: true, context: false, both: false },
    });
    const context = await h.app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: as("context-token"),
    });
    expect(context.json().delivery).toMatchObject({ context: true, both: true });
  });

  it("describes the caller without secrets", async () => {
    const h = setup();
    const me = await h.app.inject({ method: "GET", url: "/v1/me", headers: as("worker-token") });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      kind: "agent",
      principalId: "agent:worker",
      agentId: "worker",
      binding: { bindingId: "binding-worker", adapter: "wake-host", generation: 1 },
    });
    expect(me.json().grants).toContain("schedules:create");
    expect(JSON.stringify(me.json())).not.toContain("worker-token");
  });
});
