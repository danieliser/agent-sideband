import { afterEach, describe, expect, it } from "vitest";

import type {
  HostAdapter,
  HostAdapterCapabilities,
  HostExecuteRequest,
  HostOperationReceipt,
  HostPrepareFailure,
  HostPrepareRequest,
} from "../src/core/host-adapter.js";
import { AgentSideband } from "../src/core/sideband.js";
import type { MessageProvenance } from "../src/core/types.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";
import { SqliteScheduleStore } from "../src/scheduling/store.js";
import { Scheduler } from "../src/scheduling/scheduler.js";

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

type Step = "throw" | "unavailable" | "unauthorized" | "conflict" | "ok";

/** Scripted two-step host: each execute() call consumes the next scripted step (default ok). */
function scriptedHost(clock: () => string) {
  const host = {
    prepared: [] as HostPrepareRequest[],
    executed: [] as HostExecuteRequest[],
    script: [] as Step[],
    adapter: undefined as unknown as HostAdapter,
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  host.adapter = {
    name: "scripted-host",
    capabilities: async () => CAPS,
    spawn: unused,
    bind: unused,
    send: unused,
    interrupt: unused,
    stop: unused,
    inspect: unused,
    prepare: async (request: HostPrepareRequest) => {
      host.prepared.push(request);
      return {
        protocolVersion: 1 as const,
        leg: request.leg,
        replaySafe: true,
        payload: {
          commandId: `cmd:${request.operationId}:${request.leg}`,
          createdAt: clock(),
          text: request.body,
        },
      };
    },
    execute: async (request): Promise<HostOperationReceipt> => {
      host.executed.push(request);
      const step = host.script.shift() ?? "ok";
      if (step === "throw") throw new Error("connection reset after write");
      if (step === "unavailable") {
        return {
          stage: "failed",
          receiptId: null,
          errorCode: "HOST_UNAVAILABLE",
          errorMessage: "down",
          retryable: true,
        } as HostPrepareFailure;
      }
      if (step === "unauthorized" || step === "conflict") {
        return {
          stage: "failed",
          receiptId: null,
          errorCode: step === "unauthorized" ? "T3_UNAUTHORIZED" : "T3_CONFLICT",
          errorMessage: step === "unauthorized" ? "401" : "409",
          retryable: true,
        } as HostPrepareFailure;
      }
      return {
        stage: "accepted",
        receiptId: `receipt:${String(request.prepared.payload.commandId)}`,
      };
    },
  };
  return host;
}

const provenance = (): MessageProvenance => ({
  authenticatedPrincipalId: "agent:sender",
  source: "mcp",
  sourceInstanceId: "t3-local",
  sourceOperationId: null,
  trust: "untrusted",
});

const stores: Array<{ close(): void }> = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function coreSetup() {
  const clock = { current: START };
  const host = scriptedHost(() => clock.current);
  const store = SqliteSidebandStore.open(":memory:");
  stores.push(store);
  const sideband = new AgentSideband({ store, adapters: [host.adapter] });
  store.registerAgent({ agentId: "a" });
  store.bindAgent({
    bindingId: "binding-a",
    agentId: "a",
    adapter: "scripted-host",
    hostInstanceId: "local",
    externalId: "thread-a",
    state: "idle",
    capabilities: { wake: true, context: true },
    actorPrincipalId: "operator",
  });
  const message = store.sendMessage({
    idempotencyKey: "m1",
    fromAgentId: "a",
    target: { type: "agent", id: "a" },
    correlationId: "c1",
    body: "Check in.",
    messageClass: "request",
    provenance: provenance(),
  });
  const send = (mode: "wake" | "context" | "both", replay = false) => ({
    principalId: "principal-a",
    idempotencyKey: `send-${mode}`,
    bindingId: "binding-a",
    messageId: message.messageId,
    mode,
    ...(replay ? { replayIndeterminate: true } : {}),
  });
  const operationCount = () =>
    (store.database.prepare("SELECT COUNT(*) AS n FROM operations").get() as { n: number }).n;
  return { clock, host, store, sideband, send, operationCount };
}

describe("replay never converts an unknown first effect into a definitive failure", () => {
  it.each(["unavailable", "unauthorized", "conflict"] as const)(
    "keeps a context dispatch indeterminate when its explicit replay fails with %s",
    async (failure) => {
      const h = coreSetup();
      h.host.script.push("throw", failure);
      const first = await h.sideband.sendMessageToHost(h.send("context"));
      expect(first.operation.stage).toBe("indeterminate");

      h.clock.current = "2026-10-08T13:00:00.000Z";
      const replay = await h.sideband.sendMessageToHost(h.send("context", true));
      expect(replay.operation).toMatchObject({
        operationId: first.operation.operationId,
        stage: "indeterminate",
      });
      // Nothing about the replay result may invite a fresh attempt under a new identity.
      expect(replay.operation.detail.retryable).not.toBe(true);
      expect(h.operationCount()).toBe(1);
      expect(h.host.executed).toHaveLength(2);
      expect(h.host.executed[1]?.prepared).toEqual(h.host.executed[0]?.prepared);
    },
  );

  it("can still be replayed again after a failed replay, and a successful exact replay resolves it", async () => {
    const h = coreSetup();
    h.host.script.push("throw", "unauthorized", "ok");
    const first = await h.sideband.sendMessageToHost(h.send("context"));
    h.clock.current = "2026-10-08T13:00:00.000Z";
    const failedReplay = await h.sideband.sendMessageToHost(h.send("context", true));
    expect(failedReplay.operation.stage).toBe("indeterminate");
    h.clock.current = "2026-10-08T14:00:00.000Z";
    const resolved = await h.sideband.sendMessageToHost(h.send("context", true));
    expect(resolved.operation).toMatchObject({
      operationId: first.operation.operationId,
      stage: "accepted",
    });
    expect(h.host.executed).toHaveLength(3);
    // Byte-identical request every time, including the ORIGINAL timestamp.
    expect(h.host.executed[2]?.prepared).toEqual(h.host.executed[0]?.prepared);
    expect(h.host.executed[2]?.prepared.payload.createdAt).toBe(START);
    expect(h.host.prepared).toHaveLength(1);
    expect(h.operationCount()).toBe(1);
  });

  it("adopts a successful context checkpoint on replay and does not reinject it", async () => {
    const h = coreSetup();
    // context ok, wake first attempt unknown, wake replay rejected.
    h.host.script.push("ok", "throw", "conflict", "ok");
    const first = await h.sideband.sendMessageToHost(h.send("both"));
    expect(first.operation.stage).toBe("indeterminate");
    expect(h.host.executed.map((r) => r.prepared.leg)).toEqual(["context", "wake"]);

    const failedReplay = await h.sideband.sendMessageToHost(h.send("both", true));
    expect(failedReplay.operation.stage).toBe("indeterminate");
    expect(failedReplay.operation.detail.contextReceiptId).toBeTruthy();
    expect(h.host.executed.map((r) => r.prepared.leg)).toEqual(["context", "wake", "wake"]);

    const resolved = await h.sideband.sendMessageToHost(h.send("both", true));
    expect(resolved.operation.stage).toBe("accepted");
    expect(h.host.executed.map((r) => r.prepared.leg)).toEqual(["context", "wake", "wake", "wake"]);
    expect(h.operationCount()).toBe(1);
  });
});

describe("scheduler never mints a new operation after a failed explicit replay", () => {
  it("leaves the occurrence indeterminate and issues no new operation on later ticks", async () => {
    const clock = { current: new Date(START) };
    const now = () => new Date(clock.current);
    const host = scriptedHost(() => clock.current.toISOString());
    const store = SqliteSidebandStore.open(":memory:", { now });
    stores.push(store);
    const schedules = SqliteScheduleStore.attach(store, { now });
    const sideband = new AgentSideband({ store, adapters: [host.adapter] });
    const scheduler = new Scheduler<{ agentId: string }>({
      store,
      sideband,
      schedules,
      now,
      retry: { baseSeconds: 5, maxSeconds: 60, random: () => 0.5 },
      authorizer: {
        authorizeCreate: ({ caller, principalId, targetAgentId }) => ({
          allowed: true,
          ownerPrincipalId: principalId,
          ownerAgentId: caller.agentId,
          targetAgentId,
          grantId: "grant",
          grantEpoch: 1,
        }),
        authorizeDispatch: () => ({ allowed: true, reason: "ok", retryable: false }),
        authorizeCancel: () => ({ allowed: true, reason: "ok" }),
      },
    });
    store.registerAgent({ agentId: "parent" });
    store.bindAgent({
      bindingId: "binding-parent",
      agentId: "parent",
      adapter: "scripted-host",
      hostInstanceId: "local",
      externalId: "thread-parent",
      state: "idle",
      capabilities: { wake: true, context: true },
      actorPrincipalId: "operator",
    });
    const { schedule } = await scheduler.createSchedule({
      caller: { agentId: "parent" },
      principalId: "principal-parent",
      idempotencyKey: "timer-1",
      targetAgentId: "parent",
      name: "Check in",
      body: "Check the review queue.",
      trigger: { type: "after", delaySeconds: 60 },
      deliveryMode: "wake",
    });
    host.script.push("throw", "unauthorized");
    clock.current = new Date(clock.current.getTime() + 60_000);
    await scheduler.runDue();
    const occurrence = schedules.listOccurrences(schedule.scheduleId)[0]!;
    expect(occurrence.state).toBe("indeterminate");
    const operationId = occurrence.operationId;

    clock.current = new Date(clock.current.getTime() + 600_000);
    const replay = await scheduler.replayIndeterminate({ occurrenceId: occurrence.occurrenceId });
    expect(replay.state).toBe("indeterminate");
    expect(schedules.listOccurrences(schedule.scheduleId)[0]).toMatchObject({
      state: "indeterminate",
      operationId,
    });

    for (let tick = 0; tick < 3; tick += 1) {
      clock.current = new Date(clock.current.getTime() + 3_600_000);
      expect(await scheduler.runDue()).toHaveLength(0);
    }
    const count = (
      store.database.prepare("SELECT COUNT(*) AS n FROM operations").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
    expect(host.executed).toHaveLength(2);
    expect(host.prepared).toHaveLength(1);

    // The same occurrence still resolves through the original operation.
    host.script.push("ok");
    const resolved = await scheduler.replayIndeterminate({ occurrenceId: occurrence.occurrenceId });
    expect(resolved.state).toBe("host_accepted");
    expect(schedules.listOccurrences(schedule.scheduleId)[0]?.operationId).toBe(operationId);
    expect(host.executed[2]?.prepared).toEqual(host.executed[0]?.prepared);
  });
});
