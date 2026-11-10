import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSideband } from "../src/core/sideband.js";
import type {
  HostAdapter,
  HostAdapterCapabilities,
  HostContextInjectionRequest,
  HostOperationReceipt,
  HostSendRequest,
} from "../src/core/host-adapter.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";
import { SqliteScheduleStore } from "../src/scheduling/store.js";
import {
  Scheduler,
  type CreateScheduleInput,
  type ScheduleAuthorizer,
  type ScheduleDispatchAuthorizationRequest,
  type ScheduleDispatchDecision,
} from "../src/scheduling/scheduler.js";
import type { TimeTrigger } from "../src/scheduling/triggers.js";

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
const WAKE_AND_CONTEXT: HostAdapterCapabilities = { ...WAKE_ONLY, context: true };

interface FakeHost {
  readonly adapter: HostAdapter;
  readonly sends: HostSendRequest[];
  readonly contexts: HostContextInjectionRequest[];
  nextSend: "throw" | "failed" | null;
  nextContext: "failed" | null;
}

function fakeHost(name: string, capabilities: HostAdapterCapabilities): FakeHost {
  const host: FakeHost = {
    adapter: undefined as unknown as HostAdapter,
    sends: [],
    contexts: [],
    nextSend: null,
    nextContext: null,
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused in scheduler tests");
  };
  const adapter: HostAdapter = {
    name,
    capabilities: async () => capabilities,
    spawn: unused,
    bind: unused,
    send: async (request): Promise<HostOperationReceipt> => {
      host.sends.push(request);
      const next = host.nextSend;
      host.nextSend = null;
      if (next === "throw") throw new Error("transport lost");
      if (next === "failed") {
        return { stage: "failed", receiptId: null, errorCode: "HOST_REJECTED", errorMessage: "no" };
      }
      return { stage: "accepted", receiptId: `receipt-${request.operationId}` };
    },
    interrupt: unused,
    stop: unused,
    inspect: unused,
    ...(capabilities.context
      ? {
          injectContext: async (request: HostContextInjectionRequest) => {
            host.contexts.push(request);
            const next = host.nextContext;
            host.nextContext = null;
            if (next === "failed") {
              return {
                stage: "failed",
                receiptId: null,
                errorCode: "CONTEXT_REJECTED",
                errorMessage: "no",
              } as HostOperationReceipt;
            }
            return { stage: "accepted", receiptId: `context-${request.idempotencyKey}` };
          },
        }
      : {}),
  };
  host.adapter = adapter;
  return host;
}

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

async function codeOfAsync(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

/** The trusted credential a surface would resolve; here just the authenticated agent. */
interface TestCaller {
  readonly agentId: string;
}

const WORKER: TestCaller = { agentId: "worker" };

/** Self-only test policy with switchable dispatch decisions, standing in for the identity service. */
interface TestPolicy {
  dispatch: (
    request: ScheduleDispatchAuthorizationRequest,
  ) => ScheduleDispatchDecision | Promise<ScheduleDispatchDecision>;
  readonly dispatchCalls: ScheduleDispatchAuthorizationRequest[];
}

function testAuthorizer(policy: TestPolicy): ScheduleAuthorizer<TestCaller> {
  return {
    authorizeCreate: ({ caller, principalId, targetAgentId }) =>
      caller.agentId === targetAgentId
        ? {
            allowed: true,
            ownerPrincipalId: principalId,
            ownerAgentId: caller.agentId,
            targetAgentId,
            grantId: `grant-${targetAgentId}`,
            grantEpoch: 1,
          }
        : { allowed: false, reason: "not_self" },
    authorizeDispatch: (request) => {
      policy.dispatchCalls.push(request);
      return policy.dispatch(request);
    },
  };
}

const ALLOW: ScheduleDispatchDecision = { allowed: true, reason: "ok", retryable: false };

function request(
  overrides: Partial<CreateScheduleInput<TestCaller>> = {},
): CreateScheduleInput<TestCaller> {
  return {
    caller: { agentId: overrides.ownerAgentId ?? "worker" },
    principalId: "owner-principal",
    ownerAgentId: "worker",
    targetAgentId: "worker",
    idempotencyKey: "remind-1",
    name: "Check build",
    trigger: { type: "after", delaySeconds: 60 },
    body: "Check the build.",
    deliveryMode: "wake",
    ...overrides,
  };
}

describe("durable scheduler core", () => {
  let directory: string | undefined;
  let handles: Array<{ close(): void }> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) handle.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function harness() {
    directory = mkdtempSync(join(tmpdir(), "sideband-scheduling-"));
    const path = join(directory, "sideband.sqlite");
    const clock = { current: new Date(START) };
    const now = () => new Date(clock.current);
    const host = fakeHost("test-host", WAKE_ONLY);
    const contextHost = fakeHost("context-host", WAKE_AND_CONTEXT);
    let sidebandStore!: SqliteSidebandStore;
    let scheduleStore!: SqliteScheduleStore;
    let scheduler!: Scheduler<TestCaller>;
    const policy: TestPolicy = { dispatch: () => ALLOW, dispatchCalls: [] };

    function boot(): void {
      sidebandStore = SqliteSidebandStore.open(path, { now });
      scheduleStore = SqliteScheduleStore.attach(sidebandStore, { now });
      handles = [sidebandStore];
      const sideband = new AgentSideband({
        store: sidebandStore,
        adapters: [host.adapter, contextHost.adapter],
      });
      scheduler = new Scheduler({
        store: sidebandStore,
        sideband,
        schedules: scheduleStore,
        now,
        authorizer: testAuthorizer(policy),
        retry: { baseSeconds: 5, maxSeconds: 300, random: () => 0.5 },
      });
    }

    boot();
    for (const agentId of ["worker", "unbound-worker", "context-worker"]) {
      sidebandStore.registerAgent({ agentId });
    }
    sidebandStore.bindAgent({
      bindingId: "binding-worker",
      agentId: "worker",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-worker",
      state: "idle",
      capabilities: { wake: true, context: false },
      actorPrincipalId: "owner-principal",
    });
    sidebandStore.bindAgent({
      bindingId: "binding-context-worker",
      agentId: "context-worker",
      adapter: "context-host",
      hostInstanceId: "test-local",
      externalId: "thread-context-worker",
      state: "idle",
      capabilities: { wake: true, context: true },
      actorPrincipalId: "owner-principal",
    });

    return {
      host,
      contextHost,
      policy,
      get scheduler() {
        return scheduler;
      },
      get store() {
        return sidebandStore;
      },
      get schedules() {
        return scheduleStore;
      },
      nowIso: () => clock.current.toISOString(),
      advance(milliseconds: number) {
        clock.current = new Date(clock.current.getTime() + milliseconds);
      },
      restart() {
        for (const handle of handles.splice(0)) handle.close();
        boot();
      },
      bindUnboundWorker() {
        sidebandStore.bindAgent({
          bindingId: "binding-unbound-worker",
          agentId: "unbound-worker",
          adapter: "test-host",
          hostInstanceId: "test-local",
          externalId: "thread-unbound-worker",
          state: "idle",
          capabilities: { wake: true, context: false },
          actorPrincipalId: "owner-principal",
        });
      },
    };
  }

  describe("one-shot timers", () => {
    it("fires a relative timer exactly once across daemon restarts", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(request());
      expect(schedule.nextDueAt).toBe("2026-10-08T12:01:00.000Z");

      h.advance(59_000);
      h.restart();
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(0);

      h.advance(1_000);
      h.restart();
      expect(await h.scheduler.runDue()).toHaveLength(1);
      h.restart();
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(1);
      expect(h.host.sends[0]).toMatchObject({
        mode: "wake",
        binding: { bindingId: "binding-worker" },
      });

      expect(h.schedules.listOccurrences(schedule.scheduleId)).toEqual([
        expect.objectContaining({
          state: "host_accepted",
          occurrenceKey: "once:2026-10-08T12:01:00.000Z",
        }),
      ]);
      expect(h.store.getMessage(h.host.sends[0].messageId)).toMatchObject({
        fromAgentId: "worker",
        target: { type: "agent", id: "worker" },
        body: "Check the build.",
        provenance: { authenticatedPrincipalId: "owner-principal", trust: "untrusted" },
      });
    });

    it("does not fire before the due instant", async () => {
      const h = harness();
      await h.scheduler.createSchedule(request());
      h.advance(59_999);
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(0);
    });

    it("normalizes an offset timestamp to UTC and fires an overdue one immediately", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({ trigger: { type: "at", at: "2026-10-08T07:00:00-05:00" } }),
      );
      expect(schedule.nextDueAt).toBe("2026-10-08T12:00:00.000Z");
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
    });

    it("replays a duplicate idempotency key without a second timer or wake", async () => {
      const h = harness();
      const first = await h.scheduler.createSchedule(request());
      const replay = await h.scheduler.createSchedule(request());

      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.schedule.scheduleId).toBe(first.schedule.scheduleId);
      expect(replay.schedule.nextDueAt).toBe(first.schedule.nextDueAt);
      expect(h.schedules.listOccurrences(first.schedule.scheduleId)).toHaveLength(0);

      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
    });

    it("rejects a reused idempotency key carrying a different request", async () => {
      const h = harness();
      await h.scheduler.createSchedule(request());
      expect(
        await codeOfAsync(() => h.scheduler.createSchedule(request({ body: "Different." }))),
      ).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("never fires a cancelled timer and keeps its history", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(request());
      const cancelled = h.scheduler.cancelSchedule({
        caller: WORKER,
        principalId: "owner-principal",
        scheduleId: schedule.scheduleId,
        idempotencyKey: "cancel-1",
      });
      expect(cancelled.schedule.status).toBe("cancelled");
      expect(cancelled.occurrences).toHaveLength(0);

      const replay = h.scheduler.cancelSchedule({
        caller: WORKER,
        principalId: "owner-principal",
        scheduleId: schedule.scheduleId,
        idempotencyKey: "cancel-1",
      });
      expect(replay.replayed).toBe(true);

      h.advance(120_000);
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(0);
      expect(h.schedules.getSchedule(schedule.scheduleId).status).toBe("cancelled");
    });

    it("suppresses a claimed occurrence when cancellation wins before the final authorization", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({ idempotencyKey: "remind-2", trigger: { type: "after", delaySeconds: 60 } }),
      );
      h.advance(60_000);
      const [claim] = h.schedules.claimDue({ limit: 10, leaseSeconds: 30 });
      expect(claim?.occurrence).toMatchObject({ state: "dispatching", committedAt: null });
      const cancelled = h.scheduler.cancelSchedule({
        caller: WORKER,
        principalId: "owner-principal",
        scheduleId: schedule.scheduleId,
        idempotencyKey: "cancel-2",
      });
      expect(cancelled.occurrences[0]).toMatchObject({
        state: "cancelled",
        errorCode: "SCHEDULE_CANCELLED",
      });
      const commit = h.schedules.commitDispatch({
        occurrenceId: claim!.occurrence.occurrenceId,
        leaseEpoch: claim!.occurrence.leaseEpoch,
        binding: { bindingId: "binding-worker", agentId: "worker", generation: 1 },
        unboundCode: "TARGET_UNBOUND",
        decide: () => ALLOW,
      });
      expect(commit.kind).toBe("suppressed");
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(0);
      expect(h.store.listInbox("worker")).toHaveLength(0);
    });

    it("rejects cancellation by a principal that does not own the schedule", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(request());
      expect(
        codeOf(() =>
          h.scheduler.cancelSchedule({
            caller: WORKER,
            principalId: "other-principal",
            scheduleId: schedule.scheduleId,
            idempotencyKey: "cancel-x",
          }),
        ),
      ).toBe("UNAUTHORIZED");
      expect(h.schedules.getSchedule(schedule.scheduleId).status).toBe("active");
    });

    it("rejects a reused cancel key for another schedule", async () => {
      const h = harness();
      const first = await h.scheduler.createSchedule(request());
      const second = await h.scheduler.createSchedule(request({ idempotencyKey: "remind-2" }));
      h.scheduler.cancelSchedule({
        caller: WORKER,
        principalId: "owner-principal",
        scheduleId: first.schedule.scheduleId,
        idempotencyKey: "cancel-shared",
      });
      expect(
        codeOf(() =>
          h.scheduler.cancelSchedule({
            caller: WORKER,
            principalId: "owner-principal",
            scheduleId: second.schedule.scheduleId,
            idempotencyKey: "cancel-shared",
          }),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("rejects targets other than the owning agent", async () => {
      const h = harness();
      expect(
        await codeOfAsync(() =>
          h.scheduler.createSchedule(request({ targetAgentId: "unbound-worker" })),
        ),
      ).toBe("UNAUTHORIZED");
      expect(
        await codeOfAsync(() => h.scheduler.createSchedule(request({ targetAgentId: "missing" }))),
      ).toBe("UNAUTHORIZED");
      expect(h.schedules.listSchedules()).toHaveLength(0);
    });

    it("rejects context delivery on an adapter without context injection, without waking", async () => {
      const h = harness();
      for (const deliveryMode of ["context", "both"] as const) {
        expect(
          await codeOfAsync(() =>
            h.scheduler.createSchedule(
              request({ idempotencyKey: `ctx-${deliveryMode}`, deliveryMode }),
            ),
          ),
        ).toBe("CONTEXT_INJECTION_UNSUPPORTED");
      }
      expect(h.schedules.listSchedules()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(0);
    });

    it("rejects invalid durations and timestamps", async () => {
      const h = harness();
      const invalid: TimeTrigger[] = [
        { type: "after", delaySeconds: 0 },
        { type: "after", delaySeconds: 1.5 },
        { type: "after", delaySeconds: Number.MAX_SAFE_INTEGER },
        { type: "at", at: "2026-10-08T12:00:00" },
        { type: "at", at: "2026-02-30T12:00:00Z" },
      ];
      for (const trigger of invalid) {
        expect(
          await codeOfAsync(() =>
            h.scheduler.createSchedule(
              request({ idempotencyKey: JSON.stringify(trigger), trigger }),
            ),
          ),
        ).toBe("INVALID_ARGUMENT");
      }
      expect(h.schedules.listSchedules()).toHaveLength(0);
    });

    it("holds an occurrence while its target is unbound and fires once a binding appears", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({ ownerAgentId: "unbound-worker", targetAgentId: "unbound-worker" }),
      );
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toEqual([
        expect.objectContaining({ state: "blocked", finished: true }),
      ]);
      expect(h.host.sends).toHaveLength(0);
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        state: "blocked",
        errorCode: "TARGET_UNBOUND",
      });
      expect(h.schedules.getSchedule(schedule.scheduleId).status).toBe("blocked");

      h.bindUnboundWorker();
      h.advance(30_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
      expect(h.schedules.getSchedule(schedule.scheduleId).status).toBe("completed");
    });

    it("records an indeterminate host outcome and never re-wakes it", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(request());
      h.host.nextSend = "throw";
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        state: "indeterminate",
        errorCode: "HOST_ADAPTER_ERROR",
      });
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(1);
    });

    it("records a host rejection as failed without retrying", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(request());
      h.host.nextSend = "failed";
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        state: "failed",
        errorCode: "HOST_REJECTED",
      });
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(1);
    });
  });

  describe("claim seam and crash recovery", () => {
    it("reclaims an expired dispatch lease and still fires exactly once", async () => {
      const h = harness();
      await h.scheduler.createSchedule(request());
      h.advance(60_000);
      expect(h.schedules.claimDue({ limit: 10, leaseSeconds: 30 })).toHaveLength(1);
      expect(await h.scheduler.runDue()).toHaveLength(0);
      h.advance(31_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
    });

    it("re-dispatches the same committed message after a crash between commit and host send", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(request());
      h.advance(60_000);
      const [claim] = h.schedules.claimDue({ limit: 10, leaseSeconds: 30 });
      const commit = h.schedules.commitDispatch({
        occurrenceId: claim!.occurrence.occurrenceId,
        leaseEpoch: claim!.occurrence.leaseEpoch,
        binding: { bindingId: "binding-worker", agentId: "worker", generation: 1 },
        unboundCode: "TARGET_UNBOUND",
        decide: () => ALLOW,
      });
      if (commit.kind !== "committed") throw new Error(`expected commit, got ${commit.kind}`);

      h.restart();
      h.advance(31_000);
      h.restart();
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
      expect(h.host.sends[0]?.messageId).toBe(commit.messageId);
      expect(h.store.listInbox("worker")).toHaveLength(1);
      expect(h.schedules.listOccurrences(schedule.scheduleId)).toEqual([
        expect.objectContaining({ state: "host_accepted", leaseEpoch: 2 }),
      ]);
    });

    it("rolls back the dispatch commit when message attachment fails and retries after the lease", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(request());
      h.advance(60_000);
      vi.spyOn(h.store, "sendMessage").mockImplementationOnce(() => {
        throw new Error("attach failed");
      });
      expect(await h.scheduler.runDue({ leaseSeconds: 30 })).toHaveLength(0);
      expect(h.schedules.listOccurrences(schedule.scheduleId)).toEqual([
        expect.objectContaining({ state: "dispatching", messageId: null, committedAt: null }),
      ]);
      expect(h.schedules.getSchedule(schedule.scheduleId).nextDueAt).toBeNull();
      expect(h.host.sends).toHaveLength(0);

      h.advance(31_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
    });

    it("refuses a finish from a stale lease epoch", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(request());
      h.advance(60_000);
      const [first] = h.schedules.claimDue({ limit: 10, leaseSeconds: 30 });
      h.advance(31_000);
      const [second] = h.schedules.claimDue({ limit: 10, leaseSeconds: 30 });
      expect(second?.occurrence.leaseEpoch).toBe(2);

      const finish = {
        occurrenceId: first!.occurrence.occurrenceId,
        operationId: null,
        errorCode: null,
        errorMessage: null,
      };
      expect(h.schedules.finishOccurrence({ ...finish, leaseEpoch: 1, state: "failed" })).toBe(
        false,
      );
      expect(
        h.schedules.finishOccurrence({ ...finish, leaseEpoch: 2, state: "host_accepted" }),
      ).toBe(true);
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        state: "host_accepted",
        leaseEpoch: 2,
      });
    });
  });

  describe("context delivery", () => {
    it("injects context through a context-capable adapter without waking in context mode", async () => {
      const h = harness();
      await h.scheduler.createSchedule(
        request({
          ownerAgentId: "context-worker",
          targetAgentId: "context-worker",
          deliveryMode: "context",
        }),
      );
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.contextHost.contexts).toHaveLength(1);
      expect(h.contextHost.sends).toHaveLength(0);
      expect(h.host.sends).toHaveLength(0);
    });

    it("injects context and then wakes in both mode", async () => {
      const h = harness();
      await h.scheduler.createSchedule(
        request({
          ownerAgentId: "context-worker",
          targetAgentId: "context-worker",
          deliveryMode: "both",
        }),
      );
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.contextHost.contexts).toHaveLength(1);
      expect(h.contextHost.sends).toHaveLength(1);
      expect(h.contextHost.sends[0]).toMatchObject({ mode: "wake" });
    });

    it("does not wake when context injection fails in both mode", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({
          ownerAgentId: "context-worker",
          targetAgentId: "context-worker",
          deliveryMode: "both",
        }),
      );
      h.contextHost.nextContext = "failed";
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.contextHost.contexts).toHaveLength(1);
      expect(h.contextHost.sends).toHaveLength(0);
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        state: "failed",
      });
    });

    it("blocks a context schedule whose target has conflicting active bindings", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({
          ownerAgentId: "context-worker",
          targetAgentId: "context-worker",
          deliveryMode: "context",
        }),
      );
      h.store.bindAgent({
        bindingId: "binding-context-worker-2",
        agentId: "context-worker",
        adapter: "test-host",
        hostInstanceId: "test-local",
        externalId: "thread-context-worker-2",
        state: "idle",
        capabilities: { wake: true, context: false },
        actorPrincipalId: "owner-principal",
      });
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(0);
      expect(h.contextHost.contexts).toHaveLength(0);
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        state: "blocked",
        errorCode: "BINDING_CONFLICT",
      });
    });
  });

  describe("interval triggers", () => {
    it("fires on the anchored grid and advances the cursor to the next slot", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({
          idempotencyKey: "interval-1",
          trigger: { type: "interval", everySeconds: 60, startAt: "2026-10-08T12:00:30.000Z" },
        }),
      );
      expect(schedule.nextDueAt).toBe("2026-10-08T12:00:30.000Z");
      h.advance(30_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
      expect(h.schedules.getSchedule(schedule.scheduleId)).toMatchObject({
        status: "active",
        nextDueAt: "2026-10-08T12:01:30.000Z",
      });
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        occurrenceKey: "interval:2026-10-08T12:00:30.000Z",
        skippedSlots: 0,
      });
    });

    it("collapses missed slots into one occurrence and records how many were skipped", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({
          idempotencyKey: "interval-2",
          trigger: { type: "interval", everySeconds: 60, startAt: "2026-10-08T12:00:30.000Z" },
        }),
      );
      h.advance(5 * 60_000 + 30_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
      expect(h.schedules.listOccurrences(schedule.scheduleId)).toEqual([
        expect.objectContaining({ skippedSlots: 5, nominalDueAt: "2026-10-08T12:00:30.000Z" }),
      ]);
      expect(h.schedules.getSchedule(schedule.scheduleId).nextDueAt).toBe(
        "2026-10-08T12:06:30.000Z",
      );
    });

    it("coalesces new slots into an outstanding blocked occurrence", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({
          ownerAgentId: "unbound-worker",
          targetAgentId: "unbound-worker",
          idempotencyKey: "interval-3",
          trigger: { type: "interval", everySeconds: 60 },
        }),
      );
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      h.advance(60_000);
      expect(await h.scheduler.runDue()).toEqual([expect.objectContaining({ state: "blocked" })]);
      const occurrences = h.schedules.listOccurrences(schedule.scheduleId);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]).toMatchObject({ state: "blocked", skippedSlots: 1 });
      expect(h.host.sends).toHaveLength(0);
    });
  });

  describe("cron triggers", () => {
    it("fires at the next matching wall-clock minute and reschedules", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({
          idempotencyKey: "cron-1",
          trigger: { type: "cron", expression: "*/15 * * * *" },
        }),
      );
      expect(schedule.nextDueAt).toBe("2026-10-08T12:15:00.000Z");
      h.advance(15 * 60_000);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        occurrenceKey: "cron:2026-10-08T12:15:00.000Z",
        state: "host_accepted",
      });
      expect(h.schedules.getSchedule(schedule.scheduleId).nextDueAt).toBe(
        "2026-10-08T12:30:00.000Z",
      );
    });

    it("requires day-of-month and day-of-week to both match when both are restricted", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({
          idempotencyKey: "cron-and",
          trigger: { type: "cron", expression: "0 9 15 * 1" },
        }),
      );
      const due = new Date(schedule.nextDueAt as string);
      expect(due.getUTCDate()).toBe(15);
      expect(due.getUTCDay()).toBe(1);
      expect(due.getUTCHours()).toBe(9);
    });

    it("skips a slot missed beyond the grace window and records it as expired", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(
        request({
          idempotencyKey: "cron-stale",
          trigger: { type: "cron", expression: "* * * * *" },
        }),
      );
      h.advance(10 * 60_000);
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(0);
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        state: "cancelled",
        errorCode: "CRON_SLOT_EXPIRED",
      });
      expect(h.schedules.getSchedule(schedule.scheduleId).nextDueAt).toBe(
        "2026-10-08T12:11:00.000Z",
      );
    });

    it("evaluates IANA timezones across a daylight-saving transition", async () => {
      const h = harness();
      h.advance(Date.parse("2026-10-31T12:00:00.000Z") - Date.parse(START));
      const { schedule } = await h.scheduler.createSchedule(
        request({
          idempotencyKey: "cron-dst",
          trigger: { type: "cron", expression: "30 9 * * *", timezone: "America/New_York" },
        }),
      );
      expect(schedule.nextDueAt).toBe("2026-10-31T13:30:00.000Z");
      h.advance(Date.parse("2026-10-31T13:30:00.000Z") - Date.parse("2026-10-31T12:00:00.000Z"));
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.schedules.getSchedule(schedule.scheduleId).nextDueAt).toBe(
        "2026-11-01T14:30:00.000Z",
      );
    });

    it("rejects malformed cron expressions and unknown timezones", async () => {
      const h = harness();
      expect(
        await codeOfAsync(() =>
          h.scheduler.createSchedule(
            request({
              idempotencyKey: "cron-bad",
              trigger: { type: "cron", expression: "60 * * * *" },
            }),
          ),
        ),
      ).toBe("INVALID_ARGUMENT");
      expect(
        await codeOfAsync(() =>
          h.scheduler.createSchedule(
            request({
              idempotencyKey: "cron-tz",
              trigger: { type: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" },
            }),
          ),
        ),
      ).toBe("INVALID_ARGUMENT");
    });
  });

  describe("named events", () => {
    const eventRequest = () =>
      request({
        idempotencyKey: "on-build",
        trigger: { type: "event", eventName: "build.finished" },
      });

    it("fires a matching event once, carrying the payload into message metadata", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(eventRequest());
      expect(schedule.nextDueAt).toBeNull();
      expect(
        h.scheduler.emitEvent({
          principalId: "owner-principal",
          eventId: "evt-1",
          eventName: "build.finished",
          occurredAt: START,
          payload: { status: "green" },
        }),
      ).toEqual({ matchedCount: 1, replayed: false });

      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(h.host.sends).toHaveLength(1);
      expect(h.store.getMessage(h.host.sends[0]!.messageId).metadata).toMatchObject({
        event: { status: "green" },
      });
      expect(h.schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
        occurrenceKey: "event:evt-1",
      });
    });

    it("dedupes a replayed event id without creating a second occurrence", async () => {
      const h = harness();
      const { schedule } = await h.scheduler.createSchedule(eventRequest());
      const input = {
        principalId: "owner-principal",
        eventId: "evt-2",
        eventName: "build.finished",
        occurredAt: START,
        payload: { status: "green" },
      };
      h.scheduler.emitEvent(input);
      expect(h.scheduler.emitEvent(input)).toEqual({ matchedCount: 1, replayed: true });
      expect(h.schedules.listOccurrences(schedule.scheduleId)).toHaveLength(1);
      expect(await h.scheduler.runDue()).toHaveLength(1);
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(1);
    });

    it("rejects a reused event id carrying a different payload", async () => {
      const h = harness();
      await h.scheduler.createSchedule(eventRequest());
      const input = {
        principalId: "owner-principal",
        eventId: "evt-3",
        eventName: "build.finished",
        occurredAt: START,
        payload: { status: "green" },
      };
      h.scheduler.emitEvent(input);
      expect(codeOf(() => h.scheduler.emitEvent({ ...input, payload: { status: "red" } }))).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
    });

    it("rejects an event timestamped in the future", async () => {
      const h = harness();
      await h.scheduler.createSchedule(eventRequest());
      expect(
        codeOf(() =>
          h.scheduler.emitEvent({
            principalId: "owner-principal",
            eventId: "evt-future",
            eventName: "build.finished",
            occurredAt: "2026-10-08T13:00:00.000Z",
            payload: {},
          }),
        ),
      ).toBe("INVALID_ARGUMENT");
    });

    it("does not match other event names or other principals' schedules", async () => {
      const h = harness();
      await h.scheduler.createSchedule(eventRequest());
      expect(
        h.scheduler.emitEvent({
          principalId: "owner-principal",
          eventId: "evt-other-name",
          eventName: "deploy.finished",
          occurredAt: START,
          payload: {},
        }).matchedCount,
      ).toBe(0);
      expect(
        h.scheduler.emitEvent({
          principalId: "other-principal",
          eventId: "evt-other-owner",
          eventName: "build.finished",
          occurredAt: START,
          payload: {},
        }).matchedCount,
      ).toBe(0);
      expect(await h.scheduler.runDue()).toHaveLength(0);
      expect(h.host.sends).toHaveLength(0);
    });
  });
});
