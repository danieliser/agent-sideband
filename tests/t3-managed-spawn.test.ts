import { afterEach, describe, expect, it, vi } from "vitest";

import { T3HostAdapter } from "../src/adapters/t3.js";
import { SidebandError } from "../src/core/errors.js";
import { AgentSideband, type SpawnAgentInput } from "../src/core/sideband.js";
import {
  IdentityService,
  createOperatorPrincipal,
  type HostConnectorPrincipal,
} from "../src/security/index.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";

const NOW = "2026-10-08T12:00:00.000Z";
const ENVIRONMENT = "environment-1";
const OPERATOR_ID = "operator:test";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function environmentResponse(): Response {
  return new Response(
    JSON.stringify({
      environmentId: ENVIRONMENT,
      label: "Local T3",
      platform: { os: "macos", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {},
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface Dispatch {
  readonly command: Record<string, unknown>;
  readonly intents: Array<Record<string, unknown>>;
  readonly operationStage: string;
}

function world(options: { managed: boolean; failTurnStart?: boolean }) {
  const store = SqliteSidebandStore.open(":memory:", { now: () => NOW });
  cleanups.push(() => store.close());
  const identity = IdentityService.create(store, {
    now: () => NOW,
    operatorPrincipalIds: new Set([OPERATOR_ID]),
    spawnIntents: true,
  });
  const operator = createOperatorPrincipal(OPERATOR_ID);
  const dispatches: Dispatch[] = [];
  let operationId: string | undefined;
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method !== "POST") return environmentResponse();
    const command = JSON.parse(String(init.body)) as Record<string, unknown>;
    dispatches.push({
      command,
      intents: store.database
        .prepare("SELECT * FROM identity_spawn_intents ORDER BY rowid")
        .all() as Array<Record<string, unknown>>,
      operationStage: operationId === undefined ? "n/a" : store.getOperation(operationId).stage,
    });
    if (options.failTurnStart === true && command.type === "thread.turn.start") {
      return new Response("boom", { status: 500 });
    }
    return new Response(JSON.stringify({ sequence: dispatches.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const adapter = new T3HostAdapter({
    baseUrl: "http://127.0.0.1:3773",
    token: "t3-test-token",
    fetch: fetchMock,
    now: () => NOW,
  });
  const sideband = new AgentSideband({
    store,
    adapters: [adapter],
    ...(options.managed && identity.spawnIdentity !== null
      ? { spawnIdentity: identity.spawnIdentity }
      : {}),
  });
  const issued = identity.enrollConnector(operator, {
    adapter: "t3",
    hostInstanceId: ENVIRONMENT,
    allowedAgentIds: [],
  });
  const connector = identity.resolveConnector(issued.token) as HostConnectorPrincipal;
  const spawn = (overrides: Partial<SpawnAgentInput> = {}) =>
    sideband
      .spawnAgent({
        spawner: operator,
        idempotencyKey: "spawn-1",
        agentId: "worker-1",
        adapter: "t3",
        parentAgentId: null,
        prompt: "do the work",
        provider: "provider-work",
        ...overrides,
        metadata: { projectId: "project-1", model: "model-1", ...overrides.metadata },
      } as SpawnAgentInput)
      .then((result) => {
        operationId = result.operation.operationId;
        return result;
      });
  // Capture the operation id as soon as it exists so in-flight dispatches can report its stage.
  const originalBegin = store.beginOperation.bind(store);
  store.beginOperation = ((input) => {
    const begun = originalBegin(input);
    operationId = begun.operation.operationId;
    return begun;
  }) as typeof store.beginOperation;
  return { store, identity, sideband, connector, dispatches, fetchMock, spawn };
}

function intents(store: SqliteSidebandStore): Array<Record<string, unknown>> {
  return store.database
    .prepare("SELECT * FROM identity_spawn_intents ORDER BY rowid")
    .all() as Array<Record<string, unknown>>;
}

function agentIds(store: SqliteSidebandStore): string[] {
  return (store.listAgents({ limit: 1_000 }) as readonly { agentId: string }[]).map(
    (agent) => agent.agentId,
  );
}

describe("T3 managed spawn through core", () => {
  it("reserves the planned thread before the first T3 mutation and enrolls it as the intended agent", async () => {
    const w = world({ managed: true });
    const result = await w.spawn();

    expect(result.operation.stage).toBe("accepted");
    const operationId = result.operation.operationId;
    const planned = result.operation.stage === "accepted" ? w.dispatches[0]?.command.threadId : "";
    expect(planned).toMatch(/^sideband-[0-9a-f]{32}$/);
    expect(w.dispatches.map((dispatch) => dispatch.command.threadId)).toEqual([planned, planned]);

    // At the moment T3 was first mutated the intent was committed and the operation dispatching.
    const first = w.dispatches[0];
    expect(first?.operationStage).toBe("dispatching");
    expect(first?.intents).toHaveLength(1);
    expect(first?.intents[0]).toMatchObject({
      spawn_operation_id: operationId,
      status: "pending",
      adapter: "t3",
      host_instance_id: ENVIRONMENT,
      external_id: planned,
      intended_agent_id: "worker-1",
    });

    // The thread's own enrollment adopts the intent: one agent, no second ha_ identity.
    const issued = w.identity.provision(
      w.connector,
      {
        adapter: "t3",
        hostInstanceId: ENVIRONMENT,
        externalId: planned as string,
        providerSessionId: "provider-1",
        hostEpoch: "epoch-1",
        leaseSeconds: 60,
      },
      "provision-1",
    );
    expect(issued.agentId).toBe("worker-1");
    expect(agentIds(w.store).filter((id) => id.startsWith("ha_"))).toEqual([]);
    expect(intents(w.store)[0]).toMatchObject({ status: "adopted" });
  });

  it("refuses a caller-chosen thread id before any write or T3 mutation", async () => {
    const w = world({ managed: true });
    await expect(w.spawn({ metadata: { threadId: "someone-elses-thread" } })).rejects.toSatisfy(
      (error: unknown) => error instanceof SidebandError && error.code === "INVALID_ARGUMENT",
    );

    expect(w.dispatches).toEqual([]);
    expect(w.fetchMock).not.toHaveBeenCalled();
    expect(intents(w.store)).toHaveLength(0);
    expect(agentIds(w.store)).not.toContain("worker-1");
  });

  it("keeps the intent pending on a partial spawn so the tuple is never reassigned", async () => {
    const w = world({ managed: true, failTurnStart: true });
    const result = await w.spawn();

    expect(result.operation.stage).toBe("indeterminate");
    const rows = intents(w.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      host_instance_id: ENVIRONMENT,
      external_id: w.dispatches[0]?.command.threadId,
    });
  });

  it("preserves unmanaged behavior without a coordinator: caller thread id, no intent", async () => {
    const w = world({ managed: false });
    const result = await w.spawn({ metadata: { threadId: "chosen-thread" } });

    expect(result.operation.stage).toBe("accepted");
    expect(w.dispatches.map((dispatch) => dispatch.command.threadId)).toEqual([
      "chosen-thread",
      "chosen-thread",
    ]);
    expect(intents(w.store)).toHaveLength(0);
  });
});
