import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AgentSideband } from "../src/core/sideband.js";
import type {
  HostAdapter,
  HostAdapterCapabilities,
  HostExecuteRequest,
  HostOperationReceipt,
  HostPrepareFailure,
  HostPrepareRequest,
} from "../src/core/host-adapter.js";
import { SqliteSidebandStore, coreMigrations } from "../src/store/sqlite.js";
import { SqliteScheduleStore } from "../src/scheduling/store.js";
import {
  Scheduler,
  type CreateScheduleInput,
  type ScheduleCreateDecision,
  type ScheduleDispatchAuthorizationRequest,
  type ScheduleDispatchDecision,
} from "../src/scheduling/scheduler.js";

const START = "2026-10-08T12:00:00.000Z";
const CAPS: HostAdapterCapabilities = {
  spawn: false,
  bind: false,
  wake: true,
  context: true,
  interrupt: false,
  stop: false,
  adoptionReceipts: false,
};
const ALLOW: ScheduleDispatchDecision = { allowed: true, reason: "ok", retryable: false };

interface Caller {
  readonly agentId: string;
  readonly admin?: boolean;
}

/** A host with two-step delivery that records exactly what it was asked to send. */
function preparedHost(name: string, clock: () => string) {
  const host = {
    prepared: [] as HostPrepareRequest[],
    executed: [] as HostExecuteRequest[],
    replaySafe: true,
    nextPrepare: null as HostPrepareFailure | null,
    nextExecute: [] as Array<"throw" | "retryable-failed">,
    gate: null as Promise<void> | null,
    onExecute: null as (() => void) | null,
    adapter: undefined as unknown as HostAdapter,
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  host.adapter = {
    name,
    capabilities: async () => CAPS,
    spawn: unused,
    bind: unused,
    send: unused,
    interrupt: unused,
    stop: unused,
    inspect: unused,
    prepare: async (request) => {
      if (host.nextPrepare) {
        const failure = host.nextPrepare;
        host.nextPrepare = null;
        return failure;
      }
      host.prepared.push(request);
      return {
        protocolVersion: 1,
        leg: request.leg,
        replaySafe: host.replaySafe,
        payload: {
          commandId: `cmd:${request.operationId}:${request.leg}`,
          createdAt: clock(),
          text: request.body,
        },
      };
    },
    execute: async (request): Promise<HostOperationReceipt> => {
      host.executed.push(request);
      host.onExecute?.();
      if (host.gate) await host.gate;
      const next = host.nextExecute.shift();
      if (next === "throw") throw new Error("connection reset after write");
      if (next === "retryable-failed") {
        return {
          stage: "failed",
          receiptId: null,
          errorCode: "HOST_UNAVAILABLE",
          errorMessage: "down",
          retryable: true,
        };
      }
      return {
        stage: "accepted",
        receiptId: `receipt:${String(request.prepared.payload.commandId)}`,
      };
    },
  };
  return host;
}

const handles: Array<{ close(): void }> = [];
const directories: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "sideband-hardening-"));
  directories.push(directory);
  const path = join(directory, "sideband.sqlite");
  const clock = { current: new Date(START) };
  const now = () => new Date(clock.current);
  const host = preparedHost("prepared-host", () => clock.current.toISOString());
  const policy = {
    /** parent may schedule child; everyone may schedule self; admin may schedule anyone. */
    create: (caller: Caller, principalId: string, targetAgentId: string): ScheduleCreateDecision =>
      caller.agentId === targetAgentId ||
      (caller.agentId === "parent" && targetAgentId === "child") ||
      caller.admin === true
        ? {
            allowed: true,
            ownerPrincipalId: principalId,
            ownerAgentId: caller.admin ? null : caller.agentId,
            targetAgentId,
            grantId: `grant:${caller.agentId}:${targetAgentId}`,
            grantEpoch: 3,
          }
        : { allowed: false, reason: "grant_missing" },
    dispatch: (() => ALLOW) as (
      request: ScheduleDispatchAuthorizationRequest,
    ) => ScheduleDispatchDecision | Promise<ScheduleDispatchDecision>,
    dispatchCalls: [] as ScheduleDispatchAuthorizationRequest[],
    inTransaction: [] as boolean[],
  };
  let store!: SqliteSidebandStore;
  let schedules!: SqliteScheduleStore;
  let scheduler!: Scheduler<Caller>;
  let sideband!: AgentSideband;
  let adapterAvailable = true;
  const boot = () => {
    store = SqliteSidebandStore.open(path, { now });
    handles.push(store);
    schedules = SqliteScheduleStore.attach(store, { now });
    sideband = new AgentSideband({ store, adapters: adapterAvailable ? [host.adapter] : [] });
    scheduler = new Scheduler<Caller>({
      store,
      sideband,
      schedules,
      now,
      retry: { baseSeconds: 5, maxSeconds: 60, random: () => 0.5 },
      authorizer: {
        authorizeCreate: ({ caller, principalId, targetAgentId }) =>
          policy.create(caller, principalId, targetAgentId),
        authorizeDispatch: (request) => {
          policy.dispatchCalls.push(request);
          policy.inTransaction.push(store.database.inTransaction);
          return policy.dispatch(request);
        },
        authorizeCancel: ({ caller, principalId, ownerPrincipalId }) => ({
          allowed: caller.admin === true || principalId === ownerPrincipalId,
          reason: "not_owner",
        }),
      },
    });
  };
  boot();
  for (const agentId of ["parent", "child", "worker"]) store.registerAgent({ agentId });
  const bind = (agentId: string, generation?: number) =>
    store.bindAgent({
      bindingId: `binding-${agentId}${generation ? `-${generation}` : ""}`,
      agentId,
      adapter: "prepared-host",
      hostInstanceId: "local",
      externalId: `thread-${agentId}`,
      ...(generation === undefined ? {} : { generation }),
      state: "idle",
      capabilities: { wake: true, context: true },
      actorPrincipalId: "operator",
    });
  bind("parent");
  bind("child");
  return {
    host,
    policy,
    path,
    bind,
    get store() {
      return store;
    },
    get schedules() {
      return schedules;
    },
    get scheduler() {
      return scheduler;
    },
    get sideband() {
      return sideband;
    },
    advance(ms: number) {
      clock.current = new Date(clock.current.getTime() + ms);
    },
    nowIso: () => clock.current.toISOString(),
    restart(available = true) {
      adapterAvailable = available;
      store.close();
      boot();
    },
  };
}

function input(overrides: Partial<CreateScheduleInput<Caller>> = {}): CreateScheduleInput<Caller> {
  return {
    caller: { agentId: "parent" },
    principalId: "principal-parent",
    idempotencyKey: "timer-1",
    targetAgentId: "parent",
    name: "Check in",
    body: "Check the review queue.",
    trigger: { type: "after", delaySeconds: 60 },
    deliveryMode: "wake",
    ...overrides,
  };
}

async function codeOf(action: () => unknown): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("trusted schedule authorization", () => {
  it("refuses to construct a scheduler without a trusted authorizer", () => {
    const h = setup();
    expect(
      () =>
        new Scheduler({
          store: h.store,
          sideband: h.sideband,
          schedules: h.schedules,
          now: () => new Date(),
          authorizer: undefined as never,
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("takes the owner from the authorizer and rejects a conflicting caller-declared owner", async () => {
    const h = setup();
    expect(await codeOf(() => h.scheduler.createSchedule(input({ ownerAgentId: "child" })))).toBe(
      "UNAUTHORIZED",
    );
    const { schedule } = await h.scheduler.createSchedule(input());
    expect(schedule).toMatchObject({
      ownerPrincipalId: "principal-parent",
      ownerAgentId: "parent",
      grantId: "grant:parent:parent",
      grantEpoch: 3,
    });
    expect(h.schedules.listSchedules()).toHaveLength(1);
  });

  it("lets a verified parent schedule its child and pins the grant for dispatch", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input({ targetAgentId: "child" }));
    h.advance(60_000);
    expect(await h.scheduler.runDue()).toEqual([
      expect.objectContaining({ state: "host_accepted" }),
    ]);
    expect(h.policy.dispatchCalls[0]).toEqual({
      scheduleId: schedule.scheduleId,
      occurrenceId: expect.any(String),
      ownerPrincipalId: "principal-parent",
      ownerAgentId: "parent",
      targetAgentId: "child",
      binding: { bindingId: "binding-child", agentId: "child", generation: 1 },
      pinned: { grantId: "grant:parent:child", grantEpoch: 3 },
      deliveryMode: "wake",
    });
    expect(h.store.listInbox("child")[0]).toMatchObject({
      fromAgentId: "parent",
      provenance: { authenticatedPrincipalId: "principal-parent", trust: "untrusted" },
    });
    expect(
      await codeOf(() =>
        h.scheduler.createSchedule(
          input({ caller: { agentId: "child" }, idempotencyKey: "up", targetAgentId: "parent" }),
        ),
      ),
    ).toBe("UNAUTHORIZED");
  });

  it("fails closed when the decision describes another principal or target", async () => {
    const h = setup();
    const original = h.policy.create;
    h.policy.create = (caller, principalId, targetAgentId) => {
      const decision = original(caller, principalId, targetAgentId);
      return decision.allowed ? { ...decision, targetAgentId: "worker" } : decision;
    };
    expect(await codeOf(() => h.scheduler.createSchedule(input()))).toBe("UNAUTHORIZED");
    h.policy.create = (caller, principalId, targetAgentId) => {
      const decision = original(caller, principalId, targetAgentId);
      return decision.allowed ? { ...decision, ownerPrincipalId: "someone-else" } : decision;
    };
    expect(await codeOf(() => h.scheduler.createSchedule(input()))).toBe("UNAUTHORIZED");
    expect(h.schedules.listSchedules()).toHaveLength(0);
  });

  it("re-authorizes an exact idempotent replay", async () => {
    const h = setup();
    await h.scheduler.createSchedule(input({ targetAgentId: "child" }));
    expect((await h.scheduler.createSchedule(input({ targetAgentId: "child" }))).replayed).toBe(
      true,
    );
    h.policy.create = () => ({ allowed: false, reason: "grant_revoked" });
    expect(await codeOf(() => h.scheduler.createSchedule(input({ targetAgentId: "child" })))).toBe(
      "UNAUTHORIZED",
    );
  });

  it("evaluates a synchronous dispatch decision inside the commit transaction", async () => {
    const h = setup();
    await h.scheduler.createSchedule(input());
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.policy.inTransaction).toEqual([true]);
  });

  it("suspends on a permanent revoke without waking or materializing mail, and never hot-loops", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(
      input({ targetAgentId: "child", trigger: { type: "interval", everySeconds: 60 } }),
    );
    h.policy.dispatch = () => ({ allowed: false, reason: "grant_revoked", retryable: false });
    h.advance(60_000);
    expect(await h.scheduler.runDue()).toEqual([expect.objectContaining({ state: "blocked" })]);
    expect(h.schedules.getSchedule(schedule.scheduleId)).toMatchObject({
      status: "suspended",
      statusReason: "grant_revoked",
    });
    expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
      state: "blocked",
      errorCode: "grant_revoked",
      retryAt: null,
      messageId: null,
    });
    for (let index = 0; index < 5; index += 1) {
      h.advance(3_600_000);
      expect(await h.scheduler.runDue()).toHaveLength(0);
    }
    h.policy.dispatch = () => ALLOW;
    h.advance(3_600_000);
    expect(await h.scheduler.runDue()).toHaveLength(0);
    expect(h.policy.dispatchCalls).toHaveLength(1);
    expect(h.host.executed).toHaveLength(0);
    expect(h.store.listInbox("child")).toHaveLength(0);
  });

  it("holds a retryable denial until its persisted retry instant", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input({ targetAgentId: "child" }));
    h.policy.dispatch = () => ({ allowed: false, reason: "target_offline", retryable: true });
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
      state: "blocked",
      errorCode: "target_offline",
      retryAt: "2026-10-08T12:01:05.000Z",
    });
    expect(h.schedules.getSchedule(schedule.scheduleId).status).toBe("blocked");
    h.advance(4_000);
    expect(await h.scheduler.runDue()).toHaveLength(0);
    h.policy.dispatch = () => ALLOW;
    h.advance(1_000);
    expect(await h.scheduler.runDue()).toEqual([
      expect.objectContaining({ state: "host_accepted" }),
    ]);
    expect(h.schedules.getSchedule(schedule.scheduleId).status).toBe("completed");
  });

  it("treats a throwing authorizer as a retryable block", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    h.policy.dispatch = () => {
      throw new Error("identity store unavailable");
    };
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
      state: "blocked",
      errorCode: "SCHEDULE_AUTHORIZER_ERROR",
      retryAt: expect.any(String),
    });
    expect(h.host.executed).toHaveLength(0);
  });

  it("lets cancellation win while an async authorization is pending", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    let release!: (decision: ScheduleDispatchDecision) => void;
    h.policy.dispatch = () =>
      new Promise<ScheduleDispatchDecision>((resolve) => {
        release = resolve;
      });
    h.advance(60_000);
    const running = h.scheduler.runDue();
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = h.scheduler.cancelSchedule({
      caller: { agentId: "parent" },
      principalId: "principal-parent",
      scheduleId: schedule.scheduleId,
      idempotencyKey: "cancel-during-auth",
    });
    expect(cancelled.occurrences[0]).toMatchObject({ state: "cancelled" });
    release(ALLOW);
    expect(await running).toHaveLength(0);
    expect(h.host.executed).toHaveLength(0);
    expect(h.store.listInbox("parent")).toHaveLength(0);
  });

  it("reports a committed dispatch as in flight and returns its honest receipt", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    let open!: () => void;
    h.host.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let executing!: () => void;
    const started = new Promise<void>((resolve) => {
      executing = resolve;
    });
    h.host.onExecute = () => executing();
    h.advance(60_000);
    const running = h.scheduler.runDue();
    await started;
    const cancelled = h.scheduler.cancelSchedule({
      caller: { agentId: "parent" },
      principalId: "principal-parent",
      scheduleId: schedule.scheduleId,
      idempotencyKey: "cancel-in-flight",
    });
    expect(cancelled.occurrences[0]).toMatchObject({ state: "dispatching" });
    expect(cancelled.occurrences[0]?.committedAt).not.toBeNull();
    open();
    expect(await running).toEqual([expect.objectContaining({ state: "host_accepted" })]);
    expect(h.schedules.getSchedule(schedule.scheduleId).status).toBe("cancelled");
  });

  it("lets a scoped admin cancel through the injected cancel policy", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    expect(
      await codeOf(() =>
        h.scheduler.cancelSchedule({
          caller: { agentId: "child" },
          principalId: "principal-child",
          scheduleId: schedule.scheduleId,
          idempotencyKey: "child-cancel",
        }),
      ),
    ).toBe("UNAUTHORIZED");
    expect(
      h.scheduler.cancelSchedule({
        caller: { agentId: "ops", admin: true },
        principalId: "principal-admin",
        scheduleId: schedule.scheduleId,
        idempotencyKey: "admin-cancel",
      }).schedule.status,
    ).toBe("cancelled");
  });

  it("supports operator-owned schedules with no owning agent", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(
      input({
        caller: { agentId: "ops", admin: true },
        principalId: "operator",
        targetAgentId: "child",
      }),
    );
    expect(schedule.ownerAgentId).toBeNull();
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.store.listInbox("child")[0]?.metadata).toMatchObject({
      schedule: { ownerPrincipalId: "operator", ownerAgentId: null },
    });
  });
});

describe("bounded retry and clock shifts", () => {
  it("backs off an unbound target exponentially, persisted across restarts, then fires", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(
      input({
        caller: { agentId: "worker" },
        principalId: "principal-worker",
        targetAgentId: "worker",
      }),
    );
    h.advance(60_000);
    const retryAts: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await h.scheduler.runDue();
      const occurrence = h.schedules.listOccurrences(schedule.scheduleId)[0]!;
      expect(occurrence).toMatchObject({ state: "blocked", errorCode: "TARGET_UNBOUND" });
      retryAts.push(occurrence.retryAt as string);
      h.restart();
      expect(await h.scheduler.runDue()).toHaveLength(0);
      h.advance(Date.parse(occurrence.retryAt as string) - Date.parse(h.nowIso()));
    }
    const gaps = retryAts.map((at, index) =>
      index === 0 ? 0 : (Date.parse(at) - Date.parse(retryAts[index - 1]!)) / 1000,
    );
    expect(gaps.slice(1)).toEqual([10, 20, 40, 60]);
    h.bind("worker");
    expect(await h.scheduler.runDue()).toEqual([
      expect.objectContaining({ state: "host_accepted" }),
    ]);
  });

  it("does not stall a retry when the wall clock jumps backwards", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(
      input({
        caller: { agentId: "worker" },
        principalId: "principal-worker",
        targetAgentId: "worker",
      }),
    );
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.schedules.listOccurrences(schedule.scheduleId)[0]?.state).toBe("blocked");
    h.bind("worker");
    h.advance(-2 * 3_600_000);
    h.restart();
    expect(await h.scheduler.runDue()).toEqual([
      expect.objectContaining({ state: "host_accepted" }),
    ]);
  });

  it("retries a definitive no-effect host failure with a fresh operation, sending once", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    h.host.nextPrepare = {
      stage: "failed",
      receiptId: null,
      errorCode: "HOST_UNREACHABLE",
      errorMessage: "host is down",
      retryable: true,
    };
    h.advance(60_000);
    expect(await h.scheduler.runDue()).toEqual([expect.objectContaining({ state: "queued" })]);
    const waiting = h.schedules.listOccurrences(schedule.scheduleId)[0]!;
    expect(waiting).toMatchObject({
      state: "queued",
      errorCode: "HOST_UNREACHABLE",
      dispatchAttempt: 1,
      committedAt: null,
      retryAt: "2026-10-08T12:01:05.000Z",
    });
    expect(h.host.executed).toHaveLength(0);
    expect(await h.scheduler.runDue()).toHaveLength(0);

    h.advance(5_000);
    expect(await h.scheduler.runDue()).toEqual([
      expect.objectContaining({ state: "host_accepted" }),
    ]);
    expect(h.host.executed).toHaveLength(1);
    expect(h.host.executed[0]?.prepared.payload.commandId).toBe(
      `cmd:${h.host.executed[0]?.operationId}:wake`,
    );
    expect(h.store.listInbox("parent")).toHaveLength(1);
  });
});

describe("stored host requests and replay", () => {
  it("never automatically retries an ambiguous send", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    h.host.nextExecute.push("throw");
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.schedules.listOccurrences(schedule.scheduleId)[0]?.state).toBe("indeterminate");
    h.advance(3_600_000);
    h.restart();
    expect(await h.scheduler.runDue()).toHaveLength(0);
    expect(h.host.executed).toHaveLength(1);
  });

  it("explicitly replays the exact stored request when the adapter declared it replay-safe", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    h.host.nextExecute.push("throw");
    h.advance(60_000);
    await h.scheduler.runDue();
    const occurrence = h.schedules.listOccurrences(schedule.scheduleId)[0]!;
    h.advance(600_000);
    h.restart();
    expect(
      await h.scheduler.replayIndeterminate({ occurrenceId: occurrence.occurrenceId }),
    ).toMatchObject({ state: "host_accepted", finished: true });
    expect(h.host.prepared).toHaveLength(1);
    expect(h.host.executed).toHaveLength(2);
    expect(h.host.executed[1]?.prepared).toEqual(h.host.executed[0]?.prepared);
    expect(h.host.executed[1]?.prepared.payload.createdAt).toBe("2026-10-08T12:01:00.000Z");
  });

  it("refuses to replay a request the adapter did not declare replay-safe", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    h.host.replaySafe = false;
    h.host.nextExecute.push("throw");
    h.advance(60_000);
    await h.scheduler.runDue();
    const occurrence = h.schedules.listOccurrences(schedule.scheduleId)[0]!;
    expect(
      await codeOf(() =>
        h.scheduler.replayIndeterminate({ occurrenceId: occurrence.occurrenceId }),
      ),
    ).toBe("HOST_OUTCOME_INDETERMINATE");
    expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
      state: "indeterminate",
      errorCode: "HOST_OUTCOME_INDETERMINATE",
    });
    expect(h.host.executed).toHaveLength(1);
  });

  it("refuses a replay once the schedule's authority is revoked", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    h.host.nextExecute.push("throw");
    h.advance(60_000);
    await h.scheduler.runDue();
    const occurrence = h.schedules.listOccurrences(schedule.scheduleId)[0]!;
    h.policy.dispatch = () => ({
      allowed: false,
      reason: "owner_access_revoked",
      retryable: false,
    });
    expect(
      await codeOf(() =>
        h.scheduler.replayIndeterminate({ occurrenceId: occurrence.occurrenceId }),
      ),
    ).toBe("UNAUTHORIZED");
    expect(h.host.executed).toHaveLength(1);
  });

  it("checkpoints the context leg so a failed wake is not retried into a second injection", async () => {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input({ deliveryMode: "both" }));
    h.host.nextExecute.push("retryable-failed");
    h.host.nextExecute.unshift(undefined as never);
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.host.executed.map((request) => request.prepared.leg)).toEqual(["context", "wake"]);
    expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
      state: "failed",
      errorCode: "HOST_UNAVAILABLE",
    });
    h.advance(3_600_000);
    expect(await h.scheduler.runDue()).toHaveLength(0);
    expect(h.host.executed).toHaveLength(2);
  });

  it("bounds the untrusted context payload and carries it as data", async () => {
    const h = setup();
    expect(
      await codeOf(() =>
        h.scheduler.createSchedule(input({ context: { blob: "x".repeat(17 * 1024) } })),
      ),
    ).toBe("INVALID_ARGUMENT");
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 9; index += 1) deep = { nested: deep };
    expect(await codeOf(() => h.scheduler.createSchedule(input({ context: deep })))).toBe(
      "INVALID_ARGUMENT",
    );
    await h.scheduler.createSchedule(input({ context: { ticket: "T-1", priority: "high" } }));
    expect(
      await codeOf(() =>
        h.scheduler.createSchedule(input({ context: { ticket: "T-2", priority: "high" } })),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.store.listInbox("parent")[0]).toMatchObject({
      metadata: { scheduleContext: { ticket: "T-1", priority: "high" } },
      provenance: { trust: "untrusted" },
    });
  });
});

describe("migration ledger", () => {
  it("records core migrations once and rejects an edited applied migration", () => {
    const h = setup();
    expect(h.store.appliedMigrations().map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: "initial" },
      { version: 2, name: "schedules" },
    ]);
    const before = h.store.appliedMigrations();
    h.restart();
    expect(h.store.appliedMigrations()).toEqual(before);
    const [first] = coreMigrations();
    expect(() =>
      h.store.applyMigrations([{ ...first!, sql: `${first!.sql}\n-- edited` }]),
    ).toThrowError(expect.objectContaining({ code: "MIGRATION_CONFLICT" }));
  });

  it("upgrades a pre-ledger database without re-running or rewriting 0001", () => {
    const directory = mkdtempSync(join(tmpdir(), "sideband-ledger-"));
    directories.push(directory);
    const path = join(directory, "legacy.sqlite");
    const legacy = new Database(path);
    legacy.exec(coreMigrations()[0]!.sql);
    legacy
      .prepare(
        "INSERT INTO agents (agent_id, display_name, lifecycle, created_at, updated_at) VALUES ('kept', NULL, 'active', ?, ?)",
      )
      .run(START, START);
    legacy.close();
    const store = SqliteSidebandStore.open(path);
    handles.push(store);
    expect(store.getAgent("kept").agentId).toBe("kept");
    expect(store.appliedMigrations().map(({ version }) => version)).toEqual([1, 2]);
  });

  it("refuses a pre-ledger schedules table instead of silently keeping its old shape", () => {
    const directory = mkdtempSync(join(tmpdir(), "sideband-ledger-"));
    directories.push(directory);
    const path = join(directory, "old-schedules.sqlite");
    const legacy = new Database(path);
    legacy.exec(coreMigrations()[0]!.sql);
    legacy.exec("CREATE TABLE schedules (schedule_id TEXT PRIMARY KEY, owner_agent_id TEXT)");
    legacy.close();
    expect(() => SqliteSidebandStore.open(path)).toThrowError(
      expect.objectContaining({ code: "MIGRATION_CONFLICT" }),
    );
  });
});

describe("remote review recovery regressions", () => {
  it("retries a due reminder after its adapter is restored", async () => {
    const h = setup();
    await h.scheduler.createSchedule(input());
    h.restart(false);
    h.advance(60_000);
    expect((await h.scheduler.runDue())[0]?.state).toBe("blocked");
    h.advance(6_000);
    h.restart();
    expect((await h.scheduler.runDue())[0]?.state).toBe("host_accepted");
    expect(h.host.executed).toHaveLength(1);
  });

  it("retains new named events while an earlier occurrence is blocked", async () => {
    const h = setup();
    await h.scheduler.createSchedule(
      input({
        caller: { agentId: "parent", admin: true },
        trigger: { type: "event", eventName: "build.done" },
      }),
    );
    h.policy.dispatch = () => ({ allowed: false, reason: "target_offline", retryable: true });
    const emit = (eventId: string) =>
      h.scheduler.emitEvent({
        principalId: "principal-parent",
        eventId,
        eventName: "build.done",
        occurredAt: h.nowIso(),
        payload: {},
      });
    expect(emit("first").matchedCount).toBe(1);
    expect((await h.scheduler.runDue())[0]?.state).toBe("blocked");
    expect(emit("second").matchedCount).toBe(1);
    h.policy.dispatch = () => ALLOW;
    h.advance(6_000);
    await h.scheduler.runDue();
    expect(h.host.executed).toHaveLength(2);
  });

  it("does not let a legacy overflowing interval poison the due batch", async () => {
    const h = setup();
    const bad = await h.scheduler.createSchedule(
      input({ trigger: { type: "interval", everySeconds: 60, startAt: START } }),
    );
    h.store.database
      .prepare("UPDATE schedules SET trigger_json = ? WHERE schedule_id = ?")
      .run(
        JSON.stringify({ type: "interval", everySeconds: Number.MAX_SAFE_INTEGER, startAt: START }),
        bad.schedule.scheduleId,
      );
    await h.scheduler.createSchedule(
      input({ idempotencyKey: "healthy", trigger: { type: "at", at: START } }),
    );
    expect(await h.scheduler.runDue()).toHaveLength(2);
    expect(h.host.executed).toHaveLength(2);
  });
});
