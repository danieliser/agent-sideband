import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSidebandDaemon, type SidebandDaemon } from "../src/api/daemon.js";
import { SidebandError } from "../src/core/errors.js";
import type { HostAdapter, HostSpawnReceipt, HostSpawnRequest } from "../src/core/host-adapter.js";
import { AgentSideband, type SpawnAgentInput } from "../src/core/sideband.js";
import type { SpawnIdentityCoordinator } from "../src/core/spawn-identity.js";
import {
  DEFAULT_AGENT_GRANTS,
  IdentityService,
  createOperatorPrincipal,
  type HostConnectorPrincipal,
  type HostSessionRegistration,
  type IssuedAgentAccess,
} from "../src/security/index.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";

const START = "2026-10-08T12:00:00.000Z";
const ADAPTER = "planned-host";
const HOST = "env-1";
const OPERATOR_ID = "operator:test";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type Behavior =
  | "accept"
  | "fail"
  | "indeterminate"
  | "partial"
  | "throw"
  | "mismatch"
  | "provision-then-accept"
  | "provision-then-fail";

interface World {
  readonly clock: { now: string };
  readonly store: SqliteSidebandStore;
  readonly identity: IdentityService;
  readonly sideband: AgentSideband;
  readonly operator: ReturnType<typeof createOperatorPrincipal>;
  readonly connector: HostConnectorPrincipal;
  readonly host: HostAdapter & {
    behavior: Behavior;
    readonly spawn: ReturnType<typeof vi.fn>;
    readonly bind: ReturnType<typeof vi.fn>;
    readonly seen: Array<{
      request: HostSpawnRequest;
      intent: Record<string, unknown> | undefined;
      operationStage: string;
    }>;
  };
  readonly coordinator: SpawnIdentityCoordinator;
  close(): void;
}

function plannedThread(operationId: string): string {
  return `thread-${operationId}`;
}

function worldOn(
  store: SqliteSidebandStore,
  clock: { now: string },
  options: { grants?: readonly string[]; connector?: HostConnectorPrincipal } = {},
): World {
  const identity = IdentityService.create(store, {
    now: () => clock.now,
    operatorPrincipalIds: new Set([OPERATOR_ID]),
    spawnIntents: true,
    ...(options.grants === undefined ? {} : { grants: options.grants as never }),
  });
  const operator = createOperatorPrincipal(OPERATOR_ID);
  let connector = options.connector;
  if (connector === undefined) {
    const issued = identity.enrollConnector(operator, {
      adapter: ADAPTER,
      hostInstanceId: HOST,
      allowedAgentIds: ["parent-default", "parent-granted", "taken-agent"],
    });
    const resolved = identity.resolveConnector(issued.token);
    if (resolved === null) throw new Error("connector did not resolve");
    connector = resolved;
  }
  const coordinator = identity.spawnIdentity;
  if (coordinator === null) throw new Error("spawn identity coordination was not enabled");

  const seen: World["host"]["seen"] = [];
  const hostState = { behavior: "accept" as Behavior };
  const provisionPlanned = (request: HostSpawnRequest): void => {
    identity.provision(
      connector as HostConnectorPrincipal,
      registration(plannedThread(request.operationId)),
      `race-${request.operationId}`,
    );
  };
  const host = {
    name: ADAPTER,
    get behavior() {
      return hostState.behavior;
    },
    set behavior(value: Behavior) {
      hostState.behavior = value;
    },
    reservedSpawnMetadata: ["threadId"],
    capabilities: vi.fn(async () => ({
      spawn: true,
      bind: true,
      wake: true,
      context: false,
      interrupt: true,
      stop: true,
      adoptionReceipts: true,
    })),
    planSpawn: vi.fn(async (request: { operationId: string }) => ({
      hostInstanceId: HOST,
      externalId: plannedThread(request.operationId),
    })),
    spawn: vi.fn(async (request: HostSpawnRequest): Promise<HostSpawnReceipt> => {
      const intent = store.database
        .prepare("SELECT * FROM identity_spawn_intents WHERE spawn_operation_id = ?")
        .get(request.operationId) as Record<string, unknown> | undefined;
      const operation = store.getOperation(request.operationId);
      seen.push({ request, intent, operationStage: operation.stage });
      const accepted = (externalId: string): HostSpawnReceipt => ({
        stage: "accepted",
        receiptId: `receipt-${request.operationId}`,
        externalId,
        hostInstanceId: HOST,
        state: "starting",
      });
      switch (hostState.behavior) {
        case "fail":
          return {
            stage: "failed",
            receiptId: null,
            errorCode: "HOST_REJECTED",
            errorMessage: "The host rejected the spawn.",
          };
        case "indeterminate":
          return {
            stage: "indeterminate",
            receiptId: null,
            errorCode: "HOST_TIMEOUT",
            errorMessage: "The host did not answer.",
          };
        case "partial":
          return {
            stage: "indeterminate",
            receiptId: null,
            errorCode: "HOST_PARTIAL_SPAWN",
            errorMessage: "The thread was created but the first turn did not start.",
            detail: { externalId: plannedThread(request.operationId), hostInstanceId: HOST },
          };
        case "throw":
          throw new Error("socket hang up");
        case "mismatch":
          return accepted("thread-somewhere-else");
        case "provision-then-fail":
          provisionPlanned(request);
          return {
            stage: "failed",
            receiptId: null,
            errorCode: "HOST_REJECTED",
            errorMessage: "The host rejected the spawn.",
          };
        case "provision-then-accept":
          provisionPlanned(request);
          return accepted(plannedThread(request.operationId));
        case "accept":
          return accepted(plannedThread(request.operationId));
      }
    }),
    bind: vi.fn(async (request) => ({
      stage: "observed" as const,
      receiptId: `bind-${request.idempotencyKey}`,
      externalId: request.externalId,
      hostInstanceId: request.hostInstanceId,
      state: "idle" as const,
    })),
    send: vi.fn(async () => ({ stage: "accepted" as const, receiptId: "send-1" })),
    interrupt: vi.fn(async () => ({ stage: "accepted" as const, receiptId: "interrupt-1" })),
    stop: vi.fn(async () => ({ stage: "observed" as const, receiptId: "stop-1" })),
    inspect: vi.fn(async () => ({ state: "idle" as const })),
    seen,
  } as unknown as World["host"];

  const sideband = new AgentSideband({ store, adapters: [host], spawnIdentity: coordinator });
  return {
    clock,
    store,
    identity,
    sideband,
    operator,
    connector,
    host,
    coordinator,
    close: () => store.close(),
  };
}

function world(options: { grants?: readonly string[] } = {}): World {
  const clock = { now: START };
  const store = SqliteSidebandStore.open(":memory:", { now: () => clock.now });
  const w = worldOn(store, clock, options);
  cleanups.push(() => store.close());
  return w;
}

function registration(
  externalId: string,
  overrides: Partial<HostSessionRegistration> = {},
): HostSessionRegistration {
  return {
    adapter: ADAPTER,
    hostInstanceId: HOST,
    externalId,
    providerSessionId: "provider-1",
    hostEpoch: "epoch-1",
    leaseSeconds: 60,
    ...overrides,
  };
}

function spawnInput(w: World, overrides: Partial<SpawnAgentInput> = {}): SpawnAgentInput {
  return {
    spawner: w.operator,
    idempotencyKey: "spawn-1",
    agentId: "worker-1",
    adapter: ADAPTER,
    parentAgentId: null,
    prompt: "do the work",
    provider: "codex",
    metadata: {},
    ...overrides,
  } as SpawnAgentInput;
}

function code(error: unknown): string | undefined {
  return error instanceof SidebandError ? error.code : undefined;
}

async function expectRejects(
  promise: Promise<unknown>,
  expectedCode: string,
  reason?: string,
): Promise<SidebandError> {
  try {
    await promise;
  } catch (error) {
    expect(code(error)).toBe(expectedCode);
    if (reason !== undefined) expect((error as SidebandError).details.reason).toBe(reason);
    return error as SidebandError;
  }
  throw new Error(`expected ${expectedCode} but nothing was thrown`);
}

function expectThrows(fn: () => unknown, expectedCode: string, reason?: string): SidebandError {
  try {
    fn();
  } catch (error) {
    expect(code(error)).toBe(expectedCode);
    if (reason !== undefined) expect((error as SidebandError).details.reason).toBe(reason);
    return error as SidebandError;
  }
  throw new Error(`expected ${expectedCode} but nothing was thrown`);
}

function intents(w: World): Array<Record<string, unknown>> {
  return w.store.database
    .prepare("SELECT * FROM identity_spawn_intents ORDER BY rowid")
    .all() as Array<Record<string, unknown>>;
}

function sessions(w: World): Array<Record<string, unknown>> {
  return w.store.database
    .prepare("SELECT * FROM identity_host_sessions ORDER BY created_at")
    .all() as Array<Record<string, unknown>>;
}

function derivedAgents(w: World): string[] {
  return (w.store.listAgents({ limit: 1_000 }) as readonly { agentId: string }[])
    .map((agent) => agent.agentId)
    .filter((agentId) => agentId.startsWith("ha_"));
}

function agentExists(w: World, agentId: string): boolean {
  try {
    w.store.getAgent(agentId);
    return true;
  } catch (error) {
    if (code(error) === "AGENT_NOT_FOUND") return false;
    throw error;
  }
}

/** Provisions a parent agent on the host and returns its live agent credential handle. */
function liveAgent(w: World, agentId: string, externalId = `parent-${agentId}`) {
  const issued: IssuedAgentAccess = w.identity.provision(
    w.connector,
    registration(externalId, { requestedAgentId: agentId }),
    `provision-${externalId}`,
  );
  const resolved = w.identity.resolveBearer(issued.token);
  if (resolved === null) throw new Error("agent credential did not resolve");
  return { issued, resolved };
}

describe("managed spawn: intent before host I/O", () => {
  it("commits the dispatch claim and the authorized intent before the adapter is called", async () => {
    const w = world();
    const result = await w.sideband.spawnAgent(spawnInput(w));

    expect(w.host.spawn).toHaveBeenCalledTimes(1);
    const seen = w.host.seen[0];
    const operationId = result.operation.operationId;
    expect(seen?.operationStage).toBe("dispatching");
    expect(seen?.intent).toMatchObject({
      spawn_operation_id: operationId,
      status: "pending",
      adapter: ADAPTER,
      host_instance_id: HOST,
      external_id: plannedThread(operationId),
      intended_agent_id: "worker-1",
      parent_agent_id: null,
      spawner_principal_id: OPERATOR_ID,
    });
    // The adapter is told exactly which tuple the intent reserved.
    expect(seen?.request.plan).toEqual({
      hostInstanceId: HOST,
      externalId: plannedThread(operationId),
    });
    expect(result.operation.stage).toBe("accepted");
    // No raw bind: the binding appears only when the host session enrolls.
    expect(result.binding).toBeNull();
    expect(w.store.listBindings("worker-1", { includeInactive: true }).items).toHaveLength(0);
    expect(intents(w)[0]?.status).toBe("pending");
  });

  it("rolls the dispatch claim back when the reservation is refused, with no host I/O", async () => {
    const w = world();
    // The agent id already has a pending spawn on this host, so a second reserve must conflict.
    await w.sideband.spawnAgent(spawnInput(w));
    w.host.spawn.mockClear();
    const error = await expectRejects(
      w.sideband.spawnAgent(spawnInput(w, { idempotencyKey: "spawn-2" })),
      "AGENT_CONFLICT",
    );
    expect(error.code).toBe("AGENT_CONFLICT");
    expect(w.host.spawn).not.toHaveBeenCalled();
    const queued = w.store.database
      .prepare("SELECT stage FROM operations WHERE idempotency_key = 'spawn-2'")
      .get() as { stage: string };
    expect(queued.stage).toBe("queued");
    expect(intents(w)).toHaveLength(1);
  });

  it("replays an exact request without a second spawn, intent or tuple", async () => {
    const w = world();
    const first = await w.sideband.spawnAgent(spawnInput(w));
    const second = await w.sideband.spawnAgent(spawnInput(w));
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(w.host.spawn).toHaveBeenCalledTimes(1);
    expect(intents(w)).toHaveLength(1);
  });
});

describe("managed spawn: authority", () => {
  it("refuses a missing, forged or mismatched spawner before any write or host I/O", async () => {
    const w = world();
    const attempts: Array<[Partial<SpawnAgentInput>, string]> = [
      [{ spawner: undefined }, "SPAWNER_REQUIRED"],
      [{ spawner: { kind: "operator", principalId: OPERATOR_ID } }, "SPAWNER_NOT_VERIFIED"],
      [
        { spawner: { principalId: OPERATOR_ID, agentId: null, grants: ["admin"] } },
        "SPAWNER_NOT_VERIFIED",
      ],
      [{ principalId: "agent:victim" }, "PRINCIPAL_MISMATCH"],
      [{ parentAgentId: "victim" }, "PARENT_MISMATCH"],
    ];
    for (const [overrides, reason] of attempts) {
      await expectRejects(
        w.sideband.spawnAgent(
          spawnInput(w, {
            agentId: "attacker-made",
            idempotencyKey: `bad-${reason}`,
            ...overrides,
          }),
        ),
        "UNAUTHORIZED",
        reason,
      );
    }
    expect(w.host.spawn).not.toHaveBeenCalled();
    expect(w.host.planSpawn).not.toHaveBeenCalled();
    expect(agentExists(w, "attacker-made")).toBe(false);
    expect(intents(w)).toHaveLength(0);
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM operations").get()).toEqual({
      n: 0,
    });
  });

  it("refuses a caller-chosen host tuple so an existing thread cannot be hijacked", async () => {
    const w = world();
    await expectRejects(
      w.sideband.spawnAgent(spawnInput(w, { metadata: { threadId: "someone-elses-thread" } })),
      "INVALID_ARGUMENT",
    );
    expect(w.host.spawn).not.toHaveBeenCalled();
    expect(agentExists(w, "worker-1")).toBe(false);
    expect(intents(w)).toHaveLength(0);
  });

  it("denies default managed agent credentials: lifecycle authority is never granted silently", async () => {
    const w = world();
    expect(DEFAULT_AGENT_GRANTS).not.toContain("agents:spawn");
    const parent = liveAgent(w, "parent-default");
    expect(parent.resolved.grants.has("agents:spawn" as never)).toBe(false);
    await expectRejects(
      w.sideband.spawnAgent(
        spawnInput(w, {
          spawner: parent.resolved,
          principalId: parent.resolved.principalId,
          parentAgentId: "parent-default",
        }),
      ),
      "UNAUTHORIZED",
      "SPAWN_NOT_PERMITTED",
    );
    expect(w.host.spawn).not.toHaveBeenCalled();
    expect(intents(w)).toHaveLength(0);
  });

  it("derives provenance from a live agent that was explicitly granted spawn", async () => {
    const w = world({ grants: [...DEFAULT_AGENT_GRANTS, "agents:spawn"] });
    const parent = liveAgent(w, "parent-granted");
    // A copy of the credential with an inflated agent id is not the verified credential.
    await expectRejects(
      w.sideband.spawnAgent(
        spawnInput(w, {
          spawner: { ...parent.resolved, agentId: "parent-granted-x" },
          principalId: parent.resolved.principalId,
          parentAgentId: "parent-granted",
        }),
      ),
      "UNAUTHORIZED",
    );
    const result = await w.sideband.spawnAgent(
      spawnInput(w, {
        spawner: parent.resolved,
        principalId: parent.resolved.principalId,
        parentAgentId: "parent-granted",
      }),
    );
    expect(result.operation.stage).toBe("accepted");
    expect(intents(w)[0]).toMatchObject({
      parent_agent_id: "parent-granted",
      spawner_principal_id: parent.resolved.principalId,
      intended_agent_id: "worker-1",
    });
    // The enrolled child inherits the parent as verified provenance, with the child grant.
    const operationId = result.operation.operationId;
    const access = w.identity.provision(
      w.connector,
      registration(plannedThread(operationId)),
      "child-enroll",
    );
    expect(access.agentId).toBe("worker-1");
    expect(sessions(w).find((row) => row.agent_id === "worker-1")?.parent_agent_id).toBe(
      "parent-granted",
    );
  });

  it("re-authorizes exact replays: a revoked spawner cannot read back its own operation", async () => {
    const w = world({ grants: [...DEFAULT_AGENT_GRANTS, "agents:spawn"] });
    const parent = liveAgent(w, "parent-granted");
    const input = spawnInput(w, {
      spawner: parent.resolved,
      principalId: parent.resolved.principalId,
      parentAgentId: "parent-granted",
    });
    await w.sideband.spawnAgent(input);
    w.identity.revokeAccess(w.operator, { agentId: "parent-granted", reason: "test" });
    await expectRejects(w.sideband.spawnAgent(input), "UNAUTHORIZED");
    expect(w.host.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not let an agent spawner claim an identity that already exists", async () => {
    const w = world({ grants: [...DEFAULT_AGENT_GRANTS, "agents:spawn"] });
    const parent = liveAgent(w, "parent-granted");
    liveAgent(w, "taken-agent", "taken-thread");
    await expectRejects(
      w.sideband.spawnAgent(
        spawnInput(w, {
          agentId: "taken-agent",
          spawner: parent.resolved,
          principalId: parent.resolved.principalId,
          parentAgentId: "parent-granted",
        }),
      ),
      "UNAUTHORIZED",
    );
    expect(w.host.spawn).not.toHaveBeenCalled();
    const stage = w.store.database
      .prepare("SELECT stage FROM operations WHERE agent_id = 'taken-agent' AND kind = 'spawn'")
      .get() as { stage: string } | undefined;
    expect(stage?.stage ?? "queued").toBe("queued");
  });
});

describe("provision adopts the spawn intent", () => {
  it("enrolls the planned thread as the intended agent, with no second identity", async () => {
    const w = world();
    const result = await w.sideband.spawnAgent(spawnInput(w));
    const tuple = plannedThread(result.operation.operationId);

    const access = w.identity.provision(w.connector, registration(tuple), "enroll-1");
    expect(access.agentId).toBe("worker-1");
    expect(derivedAgents(w)).toEqual([]);
    expect(sessions(w)).toHaveLength(1);
    expect(sessions(w)[0]).toMatchObject({
      agent_id: "worker-1",
      external_id: tuple,
      parent_agent_id: null,
    });
    expect(intents(w)[0]).toMatchObject({ status: "adopted" });
    expect(w.store.getActiveBinding("worker-1").bindingId).toBe(access.bindingId);

    // Re-enrolling the same tuple keeps the identity and moves to a newer generation.
    const again = w.identity.provision(
      w.connector,
      registration(tuple, { providerSessionId: "provider-2", hostEpoch: "epoch-2" }),
      "enroll-2",
    );
    expect(again.agentId).toBe("worker-1");
    expect(again.generation).toBeGreaterThan(access.generation);
    expect(derivedAgents(w)).toEqual([]);
    expect(sessions(w)).toHaveLength(1);
    expect(w.store.getActiveBinding("worker-1").bindingId).toBe(again.bindingId);
  });

  it("adopts a spawn that was reserved before a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sideband-spawn-identity-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "sideband.db");
    const clock = { now: START };

    const first = worldOn(SqliteSidebandStore.open(path, { now: () => clock.now }), clock);
    const result = await first.sideband.spawnAgent(spawnInput(first));
    const tuple = plannedThread(result.operation.operationId);
    expect(first.store.appliedMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4]);
    first.close();

    // A fresh process: the connector credential survives in the database, not in memory.
    const store = SqliteSidebandStore.open(path, { now: () => clock.now });
    cleanups.push(() => store.close());
    expect(store.appliedMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4]);
    const identity = IdentityService.create(store, {
      now: () => clock.now,
      operatorPrincipalIds: new Set([OPERATOR_ID]),
      spawnIntents: true,
    });
    expect(store.appliedMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4]);
    const connector = identity.resolveConnector(
      // Rotating re-issues a usable token for the persisted connector.
      identity.rotateConnector(createOperatorPrincipal(OPERATOR_ID), {
        adapter: ADAPTER,
        hostInstanceId: HOST,
        rotationId: "after-restart",
      }).token,
    );
    if (connector === null) throw new Error("connector did not survive restart");

    const access = identity.provision(connector, registration(tuple), "enroll-after-restart");
    expect(access.agentId).toBe("worker-1");
    expect(store.database.prepare("SELECT status FROM identity_spawn_intents").all()).toEqual([
      { status: "adopted" },
    ]);
    expect(
      (store.listAgents({ limit: 100 }) as readonly { agentId: string }[]).filter((a) =>
        a.agentId.startsWith("ha_"),
      ),
    ).toEqual([]);
  });

  it("denies the wrong connector and leaves the intent pending for the right one", async () => {
    const w = world();
    const other = w.identity.enrollConnector(w.operator, {
      adapter: ADAPTER,
      hostInstanceId: "env-2",
    });
    const otherConnector = w.identity.resolveConnector(other.token) as HostConnectorPrincipal;
    const result = await w.sideband.spawnAgent(spawnInput(w));
    const tuple = plannedThread(result.operation.operationId);

    expectThrows(
      () =>
        w.identity.provision(
          otherConnector,
          registration(tuple, { hostInstanceId: HOST }),
          "wrong-connector",
        ),
      "UNAUTHORIZED",
      "CONNECTOR_SCOPE",
    );
    expect(intents(w)[0]?.status).toBe("pending");
    expect(sessions(w)).toHaveLength(0);
    expect(derivedAgents(w)).toEqual([]);

    // The right connector cannot rename the intended agent or invent a different parent either.
    expectThrows(
      () =>
        w.identity.provision(
          w.connector,
          registration(tuple, { requestedAgentId: "someone-else" }),
          "alias",
        ),
      "UNAUTHORIZED",
      "ALIAS_NOT_PERMITTED",
    );
    expectThrows(
      () =>
        w.identity.provision(
          w.connector,
          registration(tuple, { parentAgentId: "victim" }),
          "parent",
        ),
      "AGENT_CONFLICT",
    );
    expect(intents(w)[0]?.status).toBe("pending");
    expect(sessions(w)).toHaveLength(0);

    expect(w.identity.provision(w.connector, registration(tuple), "right").agentId).toBe(
      "worker-1",
    );
  });

  it("without managed coordination a connector still derives its own identity", () => {
    const clock = { now: START };
    const store = SqliteSidebandStore.open(":memory:", { now: () => clock.now });
    cleanups.push(() => store.close());
    const identity = IdentityService.create(store, { now: () => clock.now });
    const operator = createOperatorPrincipal(OPERATOR_ID);
    const connector = identity.resolveConnector(
      identity.enrollConnector(operator, { adapter: ADAPTER, hostInstanceId: HOST }).token,
    ) as HostConnectorPrincipal;
    const access = identity.provision(connector, registration("legacy-thread"), "legacy");
    expect(access.agentId).toMatch(/^ha_/);
    expect(identity.spawnIdentity).toBeNull();
    const intentTable = store.database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'identity_spawn_intents'")
      .get();
    expect(intentTable).toBeUndefined();
  });
});

describe("racing provision and spawn", () => {
  it("yields exactly one agent, one session and one current binding when enrollment wins the race", async () => {
    const w = world();
    w.host.behavior = "provision-then-accept";
    const result = await w.sideband.spawnAgent(spawnInput(w));
    const tuple = plannedThread(result.operation.operationId);

    expect(derivedAgents(w)).toEqual([]);
    expect(sessions(w)).toHaveLength(1);
    const session = sessions(w)[0] as { agent_id: string; binding_id: string };
    expect(session.agent_id).toBe("worker-1");
    const bindings = w.store.listBindings("worker-1", { includeInactive: true }).items;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.bindingId).toBe(session.binding_id);
    expect(bindings[0]).toMatchObject({ externalId: tuple, active: true });
    // The operation points at the managed binding instead of creating a second one.
    expect(result.operation.stage).toBe("accepted");
    expect(result.operation.bindingId).toBe(session.binding_id);
    expect(result.binding?.bindingId).toBe(session.binding_id);
    expect(intents(w)[0]?.status).toBe("adopted");

    // A replay returns the same operation and the same single binding.
    const replay = await w.sideband.spawnAgent(spawnInput(w));
    expect(replay.operation.operationId).toBe(result.operation.operationId);
    expect(w.store.listBindings("worker-1", { includeInactive: true }).items).toHaveLength(1);
  });

  it("yields the same single identity when enrollment arrives after the receipt", async () => {
    const w = world();
    const result = await w.sideband.spawnAgent(spawnInput(w));
    const tuple = plannedThread(result.operation.operationId);
    const first = w.identity.provision(w.connector, registration(tuple), "late-1");
    const second = w.identity.provision(
      w.connector,
      registration(tuple, { providerSessionId: "provider-2", hostEpoch: "epoch-2" }),
      "late-2",
    );
    expect(first.agentId).toBe("worker-1");
    expect(second.agentId).toBe("worker-1");
    expect(sessions(w)).toHaveLength(1);
    expect(derivedAgents(w)).toEqual([]);
    expect(w.store.getActiveBinding("worker-1").bindingId).toBe(second.bindingId);
  });
});

describe("raw bind guard", () => {
  it("refuses to overwrite a managed tuple or attach a second agent", async () => {
    const w = world();
    const result = await w.sideband.spawnAgent(spawnInput(w));
    const tuple = plannedThread(result.operation.operationId);
    const access = w.identity.provision(w.connector, registration(tuple), "enroll");
    w.store.registerAgent({ agentId: "intruder" });
    const before = w.store.listBindings("worker-1", { includeInactive: true }).items.length;

    const rawBind = (agentId: string) =>
      w.store.bindAgent({
        agentId,
        adapter: ADAPTER,
        hostInstanceId: HOST,
        externalId: tuple,
        providerSessionId: "raw",
        state: "running",
        actorPrincipalId: "attacker",
      });
    expectThrows(() => rawBind("intruder"), "BINDING_CONFLICT");
    expectThrows(() => rawBind("worker-1"), "BINDING_CONFLICT");

    // The public path refuses before any host I/O.
    await expectRejects(
      w.sideband.bindAgent({
        idempotencyKey: "raw-bind",
        agentId: "intruder",
        adapter: ADAPTER,
        externalId: tuple,
        hostInstanceId: HOST,
        metadata: {},
      }),
      "BINDING_CONFLICT",
    );
    expect(w.host.bind).not.toHaveBeenCalled();

    expect(w.store.listBindings("worker-1", { includeInactive: true }).items).toHaveLength(before);
    expect(w.store.listBindings("intruder", { includeInactive: true }).items).toHaveLength(0);
    expect(w.store.getActiveBinding("worker-1").bindingId).toBe(access.bindingId);
  });

  it("refuses a raw bind of a tuple that is reserved by a pending intent", async () => {
    const w = world();
    const result = await w.sideband.spawnAgent(spawnInput(w));
    const tuple = plannedThread(result.operation.operationId);
    w.store.registerAgent({ agentId: "intruder" });
    expectThrows(
      () =>
        w.store.bindAgent({
          agentId: "intruder",
          adapter: ADAPTER,
          hostInstanceId: HOST,
          externalId: tuple,
          state: "running",
          actorPrincipalId: "attacker",
        }),
      "BINDING_CONFLICT",
    );
    // The enrolling connector still adopts the tuple afterwards.
    expect(w.identity.provision(w.connector, registration(tuple), "enroll").agentId).toBe(
      "worker-1",
    );
  });

  it("still allows a raw bind of an unmanaged tuple", async () => {
    const w = world();
    w.store.registerAgent({ agentId: "legacy" });
    const binding = w.store.bindAgent({
      agentId: "legacy",
      adapter: ADAPTER,
      hostInstanceId: HOST,
      externalId: "unmanaged-thread",
      state: "running",
      actorPrincipalId: OPERATOR_ID,
    });
    expect(binding.agentId).toBe("legacy");
  });
});

describe("failure outcomes and tuple reassignment", () => {
  it("abandons the intent after a definite failure and never reuses the tuple", async () => {
    const w = world();
    w.host.behavior = "fail";
    const result = await w.sideband.spawnAgent(spawnInput(w));
    const tuple = plannedThread(result.operation.operationId);
    expect(result.operation.stage).toBe("failed");
    expect(intents(w)[0]).toMatchObject({ status: "abandoned" });
    expect(result.binding).toBeNull();

    // The burned tuple cannot be enrolled as a derived identity or reserved by anyone else.
    expectThrows(
      () => w.identity.provision(w.connector, registration(tuple), "after-fail"),
      "AGENT_CONFLICT",
    );
    expect(derivedAgents(w)).toEqual([]);
    expect(sessions(w)).toHaveLength(0);
    w.store.registerAgent({ agentId: "other" });
    expectThrows(
      () =>
        w.coordinator.reserve(w.operator, {
          spawnOperationId: "other-op",
          adapter: ADAPTER,
          hostInstanceId: HOST,
          externalId: tuple,
          intendedAgentId: "other",
        }),
      "AGENT_CONFLICT",
    );

    // A deliberate retry is a new operation with a fresh tuple.
    w.host.behavior = "accept";
    const retry = await w.sideband.spawnAgent(spawnInput(w, { idempotencyKey: "spawn-retry" }));
    expect(retry.operation.stage).toBe("accepted");
    expect(plannedThread(retry.operation.operationId)).not.toBe(tuple);
    expect(intents(w).map((row) => row.status)).toEqual(["abandoned", "pending"]);
  });

  for (const behavior of ["indeterminate", "partial", "throw"] as const) {
    it(`keeps the tuple reserved and adoptable after a ${behavior} host outcome`, async () => {
      const w = world();
      w.host.behavior = behavior;
      const result = await w.sideband.spawnAgent(spawnInput(w));
      const tuple = plannedThread(result.operation.operationId);
      expect(result.operation.stage).toBe("indeterminate");
      expect(intents(w)[0]?.status).toBe("pending");
      expect(w.store.listBindings("worker-1", { includeInactive: true }).items).toHaveLength(0);

      // No reassignment: another agent cannot take the possibly created thread.
      w.store.registerAgent({ agentId: "other" });
      expectThrows(
        () =>
          w.coordinator.reserve(w.operator, {
            spawnOperationId: "other-op",
            adapter: ADAPTER,
            hostInstanceId: HOST,
            externalId: tuple,
            intendedAgentId: "other",
          }),
        "AGENT_CONFLICT",
      );
      // The thread may exist, so its own connector still enrolls it as the intended agent.
      expect(w.identity.provision(w.connector, registration(tuple), "enroll").agentId).toBe(
        "worker-1",
      );
      expect(derivedAgents(w)).toEqual([]);
    });
  }

  it("treats a host tuple that differs from the plan as an unknown outcome, never a binding", async () => {
    const w = world();
    w.host.behavior = "mismatch";
    const result = await w.sideband.spawnAgent(spawnInput(w));
    expect(result.operation.stage).toBe("indeterminate");
    expect(result.operation.errorCode).toBe("SPAWN_TUPLE_MISMATCH");
    expect(intents(w)[0]?.status).toBe("pending");
    expect(w.store.listBindings("worker-1", { includeInactive: true }).items).toHaveLength(0);
    const stray = w.store.database
      .prepare("SELECT COUNT(*) AS n FROM bindings WHERE external_id = 'thread-somewhere-else'")
      .get();
    expect(stray).toEqual({ n: 0 });
  });

  it("does not abandon or overwrite an intent that enrollment already adopted", async () => {
    const w = world();
    w.host.behavior = "provision-then-fail";
    const result = await w.sideband.spawnAgent(spawnInput(w));
    expect(result.operation.stage).toBe("failed");
    expect(intents(w)[0]?.status).toBe("adopted");
    expect(sessions(w)).toHaveLength(1);
    expect(sessions(w)[0]?.agent_id).toBe("worker-1");
    expect(w.store.getActiveBinding("worker-1").bindingId).toBe(
      (sessions(w)[0] as { binding_id: string }).binding_id,
    );
  });
});

describe("unmanaged behavior is preserved", () => {
  it("keeps the legacy raw bind when no coordinator is configured", async () => {
    const clock = { now: START };
    const store = SqliteSidebandStore.open(":memory:", { now: () => clock.now });
    cleanups.push(() => store.close());
    const w = worldOn(store, clock);
    const sideband = new AgentSideband({ store, adapters: [w.host] });
    w.host.spawn.mockClear();
    const result = await sideband.spawnAgent(
      spawnInput(w, { spawner: undefined, agentId: "legacy-1", parentAgentId: "operator" }),
    );
    expect(w.host.planSpawn).not.toHaveBeenCalled();
    expect(result.binding).toMatchObject({ agentId: "legacy-1" });
    expect(w.host.seen.at(-1)?.request.plan).toBeUndefined();
    expect(intents(w)).toHaveLength(0);
  });

  it("keeps the legacy raw bind for an adapter without planSpawn", async () => {
    const w = world();
    const legacy = {
      ...w.host,
      name: "legacy-host",
      planSpawn: undefined,
      reservedSpawnMetadata: undefined,
      spawn: vi.fn(async (request: HostSpawnRequest) => ({
        stage: "accepted" as const,
        receiptId: `legacy-${request.operationId}`,
        externalId: "legacy-thread",
        hostInstanceId: "legacy-env",
        state: "starting" as const,
      })),
    } as unknown as HostAdapter;
    const sideband = new AgentSideband({
      store: w.store,
      adapters: [legacy],
      spawnIdentity: w.coordinator,
    });
    const result = await sideband.spawnAgent(
      spawnInput(w, { adapter: "legacy-host", spawner: undefined, parentAgentId: "operator" }),
    );
    expect(result.binding).toMatchObject({ agentId: "worker-1", externalId: "legacy-thread" });
    expect(intents(w)).toHaveLength(0);
  });
});

describe("daemon opt-in", () => {
  const TOKEN = "operator-token-that-is-long-enough-for-the-daemon";
  const daemons: SidebandDaemon[] = [];
  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.close();
  });

  function plannedAdapter(calls: HostSpawnRequest[]): HostAdapter {
    const unused = async (): Promise<never> => {
      throw new Error("unused");
    };
    return {
      name: ADAPTER,
      reservedSpawnMetadata: ["threadId"],
      capabilities: async () => ({
        spawn: true,
        bind: false,
        wake: false,
        context: false,
        interrupt: false,
        stop: false,
        adoptionReceipts: false,
      }),
      planSpawn: async (request) => ({
        hostInstanceId: HOST,
        externalId: plannedThread(request.operationId),
      }),
      spawn: async (request) => {
        calls.push(request);
        return {
          stage: "accepted",
          receiptId: `receipt-${request.operationId}`,
          externalId: request.plan?.externalId ?? "missing-plan",
          hostInstanceId: HOST,
        };
      },
      bind: unused,
      send: unused,
      interrupt: unused,
      stop: unused,
      inspect: unused,
    };
  }

  it("reserves the intent for an operator spawn and refuses a caller-chosen thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sideband-spawn-daemon-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const calls: HostSpawnRequest[] = [];
    const daemon = createSidebandDaemon({
      database: join(dir, "sideband.sqlite"),
      operatorToken: TOKEN,
      managedSpawnIdentity: true,
      scheduler: { autoStart: false },
      adapters: [{ name: ADAPTER, create: () => plannedAdapter(calls) }],
    });
    daemons.push(daemon);
    const headers = { authorization: `Bearer ${TOKEN}`, "idempotency-key": "daemon-spawn-1" };
    const body = { adapter: ADAPTER, prompt: "go", provider: "codex", metadata: {} };

    const hijack = await daemon.app.inject({
      method: "POST",
      url: "/v1/agents/worker-9/spawn",
      headers: { ...headers, "idempotency-key": "daemon-hijack" },
      payload: { ...body, metadata: { threadId: "existing-thread" } },
    });
    expect(hijack.statusCode).toBe(422);
    expect(calls).toHaveLength(0);

    const spawned = await daemon.app.inject({
      method: "POST",
      url: "/v1/agents/worker-9/spawn",
      headers,
      payload: body,
    });
    expect(spawned.statusCode).toBe(202);
    expect(calls).toHaveLength(1);
    const intent = daemon.store.database
      .prepare("SELECT * FROM identity_spawn_intents")
      .get() as Record<string, unknown>;
    expect(intent).toMatchObject({
      status: "pending",
      intended_agent_id: "worker-9",
      parent_agent_id: null,
      spawner_principal_id: "operator",
      external_id: calls[0]?.plan?.externalId,
    });
    expect(daemon.store.appliedMigrations().map((migration) => migration.version)).toEqual([
      1, 2, 3, 4,
    ]);

    const unauthenticated = await daemon.app.inject({
      method: "POST",
      url: "/v1/agents/worker-10/spawn",
      headers: { "idempotency-key": "daemon-anon" },
      payload: body,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(calls).toHaveLength(1);
  });
});
