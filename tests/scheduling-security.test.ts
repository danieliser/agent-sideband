import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentSideband } from "../src/core/sideband.js";
import type {
  HostAdapter,
  HostAdapterCapabilities,
  HostExecuteRequest,
  HostOperationReceipt,
  HostPrepareRequest,
} from "../src/core/host-adapter.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";
import { SCHEDULER_SENDER_AGENT_ID, SqliteScheduleStore } from "../src/scheduling/store.js";
import {
  Scheduler,
  type CreateScheduleInput,
  type ScheduleCreateDecision,
} from "../src/scheduling/scheduler.js";

const START = "2026-10-08T12:00:00.000Z";
const CAPS: HostAdapterCapabilities = {
  spawn: false,
  bind: false,
  wake: true,
  context: false,
  interrupt: false,
  stop: false,
  adoptionReceipts: false,
};

interface Caller {
  readonly agentId: string;
  readonly admin?: boolean;
}

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "sideband-sched-security-"));
  directories.push(directory);
  const clock = { current: new Date(START) };
  const now = () => new Date(clock.current);
  const prepared: HostPrepareRequest[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const adapter: HostAdapter = {
    name: "security-host",
    capabilities: async () => CAPS,
    spawn: unused,
    bind: unused,
    send: unused,
    interrupt: unused,
    stop: unused,
    inspect: unused,
    prepare: async (request) => {
      prepared.push(request);
      return {
        protocolVersion: 1,
        leg: request.leg,
        replaySafe: true,
        payload: { commandId: `cmd:${request.operationId}`, text: request.body },
      };
    },
    execute: async (request: HostExecuteRequest): Promise<HostOperationReceipt> => ({
      stage: "accepted",
      receiptId: `receipt:${String(request.prepared.payload.commandId)}`,
    }),
  };
  const store = SqliteSidebandStore.open(join(directory, "sideband.sqlite"), { now });
  handles.push(store);
  const schedules = SqliteScheduleStore.attach(store, { now });
  const sideband = new AgentSideband({ store, adapters: [adapter] });
  const state = {
    /** Principals whose authority was revoked since they created or cancelled. */
    revoked: new Set<string>(),
    cancelChecks: [] as string[],
  };
  const scheduler = new Scheduler<Caller>({
    store,
    sideband,
    schedules,
    now,
    authorizer: {
      authorizeCreate: ({ caller, principalId, targetAgentId }): ScheduleCreateDecision =>
        state.revoked.has(principalId)
          ? { allowed: false, reason: "grant_revoked" }
          : {
              allowed: true,
              ownerPrincipalId: principalId,
              ownerAgentId: caller.admin ? null : caller.agentId,
              targetAgentId,
              grantId: `grant:${principalId}`,
              grantEpoch: 1,
            },
      authorizeDispatch: () => ({ allowed: true, reason: "ok", retryable: false }),
      authorizeCancel: ({ principalId }) => {
        state.cancelChecks.push(principalId);
        return state.revoked.has(principalId)
          ? { allowed: false, reason: "grant_revoked" }
          : { allowed: true };
      },
    },
  });
  for (const agentId of ["parent", "child"]) store.registerAgent({ agentId });
  for (const agentId of ["parent", "child"]) {
    store.bindAgent({
      bindingId: `binding-${agentId}`,
      agentId,
      adapter: "security-host",
      hostInstanceId: "local",
      externalId: `thread-${agentId}`,
      state: "idle",
      capabilities: { wake: true },
      actorPrincipalId: "operator",
    });
  }
  return {
    store,
    scheduler,
    prepared,
    state,
    advance(ms: number) {
      clock.current = new Date(clock.current.getTime() + ms);
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

describe("scheduled message sender", () => {
  it("never makes an operator wake appear to come from its target", async () => {
    const h = setup();
    // The operator principal is deliberately not a registered agent.
    await h.scheduler.createSchedule(
      input({
        caller: { agentId: "ops", admin: true },
        principalId: "principal-operator",
        targetAgentId: "child",
      }),
    );
    h.advance(60_000);
    await h.scheduler.runDue();

    const [message] = h.store.listInbox("child");
    expect(message).toBeDefined();
    expect(message!.fromAgentId).toBe(SCHEDULER_SENDER_AGENT_ID);
    expect(message!.fromAgentId).not.toBe("child");
    expect(message!.provenance).toMatchObject({
      authenticatedPrincipalId: "principal-operator",
      source: "internal",
      trust: "untrusted",
    });
    expect(message!.metadata).toMatchObject({
      schedule: { ownerPrincipalId: "principal-operator", ownerAgentId: null },
    });
    // The host is told the same thing, so the woken agent cannot read it as self-talk.
    expect(h.prepared.map((request) => request.fromAgentId)).toEqual([SCHEDULER_SENDER_AGENT_ID]);
  });

  it("keeps the system sender stable and registered across occurrences", async () => {
    const h = setup();
    await h.scheduler.createSchedule(
      input({
        caller: { agentId: "ops", admin: true },
        principalId: "principal-operator",
        targetAgentId: "child",
        trigger: { type: "after", delaySeconds: 60 },
      }),
    );
    await h.scheduler.createSchedule(
      input({
        caller: { agentId: "ops", admin: true },
        principalId: "principal-operator",
        idempotencyKey: "timer-2",
        targetAgentId: "parent",
      }),
    );
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.store.listInbox("child")[0]?.fromAgentId).toBe(SCHEDULER_SENDER_AGENT_ID);
    expect(h.store.listInbox("parent")[0]?.fromAgentId).toBe(SCHEDULER_SENDER_AGENT_ID);
    expect(h.store.getAgent(SCHEDULER_SENDER_AGENT_ID).agentId).toBe(SCHEDULER_SENDER_AGENT_ID);
  });

  it("keeps an agent-owned self-schedule distinct from an operator wake of the same agent", async () => {
    const h = setup();
    await h.scheduler.createSchedule(input({ targetAgentId: "parent" }));
    await h.scheduler.createSchedule(
      input({
        caller: { agentId: "ops", admin: true },
        principalId: "principal-operator",
        idempotencyKey: "operator-wake",
        targetAgentId: "parent",
      }),
    );
    h.advance(60_000);
    await h.scheduler.runDue();

    const messages = h.store.listInbox("parent");
    expect(messages).toHaveLength(2);
    const bySender = new Map(messages.map((message) => [message.fromAgentId, message]));
    expect(bySender.get("parent")?.provenance.authenticatedPrincipalId).toBe("principal-parent");
    expect(bySender.get("parent")?.metadata).toMatchObject({
      schedule: { ownerAgentId: "parent" },
    });
    expect(bySender.get(SCHEDULER_SENDER_AGENT_ID)?.provenance.authenticatedPrincipalId).toBe(
      "principal-operator",
    );
    expect(bySender.get(SCHEDULER_SENDER_AGENT_ID)?.metadata).toMatchObject({
      schedule: { ownerAgentId: null },
    });
  });

  it("sends an agent-owned schedule for another agent from its owner, not its target", async () => {
    const h = setup();
    await h.scheduler.createSchedule(input({ targetAgentId: "child" }));
    h.advance(60_000);
    await h.scheduler.runDue();
    expect(h.store.listInbox("child")[0]?.fromAgentId).toBe("parent");
  });
});

describe("cancel replay authorization", () => {
  async function scheduleOne() {
    const h = setup();
    const { schedule } = await h.scheduler.createSchedule(input());
    const cancel = (key = "cancel-1", scheduleId = schedule.scheduleId) =>
      h.scheduler.cancelSchedule({
        caller: { agentId: "parent" },
        principalId: "principal-parent",
        scheduleId,
        idempotencyKey: key,
      });
    return { h, schedule, cancel };
  }

  it("re-checks the authorizer on an exact replay while authority holds", async () => {
    const { h, cancel } = await scheduleOne();
    expect(cancel().replayed).toBe(false);
    expect(cancel().replayed).toBe(true);
    expect(h.state.cancelChecks).toEqual(["principal-parent", "principal-parent"]);
  });

  it("rejects an exact replay once the authority was revoked", async () => {
    const { h, cancel } = await scheduleOne();
    expect(cancel().schedule.status).toBe("cancelled");
    h.state.revoked.add("principal-parent");
    expect(await codeOf(() => cancel())).toBe("UNAUTHORIZED");
  });

  it("does not reveal replay state to a revoked caller through a conflicting repeat", async () => {
    const { h, schedule, cancel } = await scheduleOne();
    cancel();
    h.state.revoked.add("principal-parent");
    expect(await codeOf(() => cancel("cancel-1", "some-other-schedule"))).toBe("UNAUTHORIZED");
    expect(schedule.scheduleId).not.toBe("some-other-schedule");
  });
});
