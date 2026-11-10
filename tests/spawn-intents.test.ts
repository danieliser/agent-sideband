import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { SidebandError } from "../src/core/errors.js";
import {
  IdentityService,
  createOperatorPrincipal,
  deriveHostAgentId,
  deriveHostSessionId,
} from "../src/security/index.js";
import {
  SpawnIntentStore,
  allowSpawn,
  createSpawnCaller,
  denySpawn,
  spawnIntentMigration,
  type SpawnAuthorizationDecision,
  type SpawnCaller,
  type SpawnIntentRequest,
} from "../src/security/spawn-intents.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";

const START = "2026-10-08T12:00:00.000Z";
const ADAPTER = "test-host";
const HOST = "host-a";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type Authorize = (caller: SpawnCaller, request: SpawnIntentRequest) => SpawnAuthorizationDecision;

/** Mirrors what a real policy must do: echo the trusted caller's identity and the adapter tuple. */
const echoPolicy: Authorize = (caller, request) =>
  allowSpawn({
    spawnerPrincipalId: caller.principalId,
    parentAgentId: caller.agentId,
    adapter: request.adapter,
    hostInstanceId: request.hostInstanceId,
    externalId: request.externalId,
    intendedAgentId: request.intendedAgentId,
  });

interface Harness {
  readonly clock: { now: string };
  readonly store: SqliteSidebandStore;
  readonly intents: SpawnIntentStore;
  readonly calls: Array<{ caller: SpawnCaller; request: SpawnIntentRequest }>;
  readonly policy: { current: Authorize };
  readonly parent: SpawnCaller;
  readonly operator: SpawnCaller;
}

function harness(
  options: { withIdentity?: boolean; store?: SqliteSidebandStore; clock?: { now: string } } = {},
): Harness {
  const clock = options.clock ?? { now: START };
  const store = options.store ?? SqliteSidebandStore.open(":memory:", { now: () => clock.now });
  if (options.store === undefined) cleanups.push(() => store.close());
  if (options.withIdentity !== false) IdentityService.create(store, { now: () => clock.now });
  store.registerAgent({ agentId: "parent" });
  const calls: Harness["calls"] = [];
  const policy = { current: echoPolicy };
  const intents = SpawnIntentStore.attach(store, {
    now: () => clock.now,
    authorize(caller, request) {
      calls.push({ caller, request });
      return policy.current(caller, request);
    },
  });
  return {
    clock,
    store,
    intents,
    calls,
    policy,
    parent: createSpawnCaller({ principalId: "agent:parent", agentId: "parent" }),
    operator: createSpawnCaller({ principalId: "operator:test", agentId: null }),
  };
}

function request(overrides: Partial<SpawnIntentRequest> = {}): SpawnIntentRequest {
  return {
    spawnOperationId: "spawn-op-1",
    adapter: ADAPTER,
    hostInstanceId: HOST,
    externalId: "thread-1",
    intendedAgentId: "child-1",
    ...overrides,
  };
}

function expectCode(fn: () => unknown, expected: string): SidebandError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SidebandError);
    expect((error as SidebandError).code).toBe(expected);
    return error as SidebandError;
  }
  throw new Error(`expected ${expected} but nothing was thrown`);
}

function rowCount(h: Harness): number {
  return (
    h.store.database.prepare("SELECT COUNT(*) AS n FROM identity_spawn_intents").get() as {
      n: number;
    }
  ).n;
}

function provisionSession(
  h: Harness,
  input: { externalId: string; requestedAgentId?: string; hostInstanceId?: string },
): { agentId: string } {
  const identity = IdentityService.create(h.store, { now: () => h.clock.now });
  const operator = createOperatorPrincipal("operator:test");
  const hostInstanceId = input.hostInstanceId ?? HOST;
  const issued = identity.enrollConnector(operator, {
    adapter: ADAPTER,
    hostInstanceId,
  });
  const connector = identity.resolveConnector(issued.token);
  if (connector === null) throw new Error("connector did not resolve");
  const access = identity.provision(
    connector,
    {
      adapter: ADAPTER,
      hostInstanceId,
      externalId: input.externalId,
      providerSessionId: "provider-1",
      hostEpoch: "epoch-1",
      leaseSeconds: 60,
    },
    `provision-${input.externalId}`,
  );
  return { agentId: (access as { agentId: string }).agentId };
}

describe("trust boundary", () => {
  it("has no permissive default: attach requires a synchronous policy callback", () => {
    const store = SqliteSidebandStore.open(":memory:");
    cleanups.push(() => store.close());
    IdentityService.create(store);
    expectCode(
      () => SpawnIntentStore.attach(store, {} as unknown as { authorize: Authorize }),
      "INVALID_ARGUMENT",
    );
    expectCode(
      () =>
        SpawnIntentStore.attach(store, { authorize: "yes" } as unknown as { authorize: Authorize }),
      "INVALID_ARGUMENT",
    );
  });

  it("refuses a raw-JSON caller before the policy runs or any row is written", () => {
    const h = harness();
    const fake = JSON.parse(
      '{"kind":"spawn-caller","principalId":"agent:parent","agentId":"parent"}',
    ) as SpawnCaller;
    expectCode(() => h.intents.reserve(fake, request()), "UNAUTHORIZED");
    expectCode(() => h.intents.reserve({ ...h.parent }, request()), "UNAUTHORIZED");
    expect(h.calls).toHaveLength(0);
    expect(rowCount(h)).toBe(0);
  });

  it("refuses a decision that did not come from allowSpawn", () => {
    const h = harness();
    const forged = JSON.parse(
      JSON.stringify({
        allowed: true,
        spawnerPrincipalId: "agent:parent",
        parentAgentId: "parent",
        adapter: ADAPTER,
        hostInstanceId: HOST,
        externalId: "thread-1",
        intendedAgentId: "child-1",
      }),
    ) as SpawnAuthorizationDecision;
    h.policy.current = () => forged;
    expectCode(() => h.intents.reserve(h.parent, request()), "UNAUTHORIZED");
    h.policy.current = () => Promise.resolve(echoPolicy(h.parent, request())) as never;
    expectCode(() => h.intents.reserve(h.parent, request()), "UNAUTHORIZED");
    h.policy.current = () => undefined as never;
    expectCode(() => h.intents.reserve(h.parent, request()), "UNAUTHORIZED");
    expect(rowCount(h)).toBe(0);
  });

  it("denies on a policy denial and surfaces the reason without writing", () => {
    const h = harness();
    h.policy.current = () => denySpawn("spawner has no spawn grant");
    const error = expectCode(() => h.intents.reserve(h.parent, request()), "UNAUTHORIZED");
    expect(error.details).toMatchObject({ reason: "SPAWN_DENIED" });
    expect(rowCount(h)).toBe(0);
  });

  it("propagates a throwing policy and writes nothing", () => {
    const h = harness();
    h.policy.current = () => {
      throw new Error("policy backend down");
    };
    expect(() => h.intents.reserve(h.parent, request())).toThrow("policy backend down");
    expect(rowCount(h)).toBe(0);
  });

  it("runs the policy before the reservation exists", () => {
    const h = harness();
    let seen = -1;
    h.policy.current = (caller, req) => {
      seen = rowCount(h);
      return echoPolicy(caller, req);
    };
    h.intents.reserve(h.parent, request());
    expect(seen).toBe(0);
    expect(rowCount(h)).toBe(1);
  });

  it("rejects request fields that smuggle authority, including model metadata", () => {
    const h = harness();
    const smuggled = { ...request(), metadata: { parentAgentId: "root", spawnerPrincipalId: "x" } };
    expectCode(() => h.intents.reserve(h.parent, smuggled), "INVALID_ARGUMENT");
    expectCode(
      () => h.intents.reserve(h.parent, { ...request(), status: "adopted" } as never),
      "INVALID_ARGUMENT",
    );
    expect(h.calls).toHaveLength(0);
    expect(rowCount(h)).toBe(0);
  });

  it("validates identifiers", () => {
    const h = harness();
    for (const bad of [
      request({ spawnOperationId: "" }),
      request({ externalId: " thread" }),
      request({ hostInstanceId: "a\nb" }),
      request({ intendedAgentId: "x".repeat(129) }),
    ]) {
      expectCode(() => h.intents.reserve(h.parent, bad), "INVALID_ARGUMENT");
    }
    expect(rowCount(h)).toBe(0);
  });
});

describe("owner and parent derivation", () => {
  it("stores the spawner and parent derived from the trusted caller", () => {
    const h = harness();
    const intent = h.intents.reserve(h.parent, request());
    expect(intent).toMatchObject({
      spawnOperationId: "spawn-op-1",
      hostSessionId: deriveHostSessionId(ADAPTER, HOST, "thread-1"),
      adapter: ADAPTER,
      hostInstanceId: HOST,
      externalId: "thread-1",
      intendedAgentId: "child-1",
      parentAgentId: "parent",
      spawnerPrincipalId: "agent:parent",
      status: "pending",
      createdAt: START,
      adoptedAt: null,
      abandonedAt: null,
    });
    const operatorIntent = h.intents.reserve(
      h.operator,
      request({ spawnOperationId: "spawn-op-2", externalId: "thread-2", intendedAgentId: "c2" }),
    );
    expect(operatorIntent).toMatchObject({
      parentAgentId: null,
      spawnerPrincipalId: "operator:test",
    });
  });

  it("rejects a caller-declared parent or spawner that differs from the derived one", () => {
    const h = harness();
    expectCode(
      () => h.intents.reserve(h.parent, request({ declaredParentAgentId: "someone-else" })),
      "UNAUTHORIZED",
    );
    expectCode(
      () => h.intents.reserve(h.parent, request({ declaredParentAgentId: null })),
      "UNAUTHORIZED",
    );
    expectCode(
      () => h.intents.reserve(h.operator, request({ declaredParentAgentId: "parent" })),
      "UNAUTHORIZED",
    );
    expectCode(
      () => h.intents.reserve(h.parent, request({ declaredSpawnerPrincipalId: "operator:test" })),
      "UNAUTHORIZED",
    );
    expect(rowCount(h)).toBe(0);
    // Matching declarations are redundant but accepted.
    const ok = h.intents.reserve(
      h.parent,
      request({ declaredParentAgentId: "parent", declaredSpawnerPrincipalId: "agent:parent" }),
    );
    expect(ok.parentAgentId).toBe("parent");
  });

  it("requires the derived parent to be a registered agent", () => {
    const h = harness();
    const ghost = createSpawnCaller({ principalId: "agent:ghost", agentId: "ghost" });
    expectCode(() => h.intents.reserve(ghost, request()), "AGENT_NOT_FOUND");
    expect(rowCount(h)).toBe(0);
  });

  it("denies a decision that differs from the request tuple, agent, principal or parent", () => {
    const h = harness();
    const base = (caller: SpawnCaller, req: SpawnIntentRequest) => ({
      spawnerPrincipalId: caller.principalId,
      parentAgentId: caller.agentId,
      adapter: req.adapter,
      hostInstanceId: req.hostInstanceId,
      externalId: req.externalId,
      intendedAgentId: req.intendedAgentId,
    });
    const mutations: Array<Record<string, string | null>> = [
      { adapter: "other-host" },
      { hostInstanceId: "host-b" },
      { externalId: "thread-9" },
      { intendedAgentId: "child-9" },
      { spawnerPrincipalId: "agent:other" },
      { parentAgentId: "other" },
      { parentAgentId: null },
    ];
    for (const mutation of mutations) {
      h.policy.current = (caller, req) => allowSpawn({ ...base(caller, req), ...mutation });
      expectCode(() => h.intents.reserve(h.parent, request()), "UNAUTHORIZED");
    }
    expect(rowCount(h)).toBe(0);
  });
});

describe("reservation", () => {
  it("replays the exact authorized reservation stably and reauthorizes every time", () => {
    const h = harness();
    const first = h.intents.reserve(h.parent, request());
    h.clock.now = "2026-10-08T13:00:00.000Z";
    const replay = h.intents.reserve(h.parent, request());
    expect(replay).toEqual(first);
    expect(h.calls).toHaveLength(2);
    expect(rowCount(h)).toBe(1);

    h.policy.current = () => denySpawn("revoked since reservation");
    expectCode(() => h.intents.reserve(h.parent, request()), "UNAUTHORIZED");
    expect(h.intents.find("spawn-op-1")).toEqual(first);
  });

  it("rejects an operation id reused with a different tuple, agent, principal or parent", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    for (const changed of [
      request({ externalId: "thread-2" }),
      request({ hostInstanceId: "host-b" }),
      request({ intendedAgentId: "child-2" }),
    ]) {
      expectCode(() => h.intents.reserve(h.parent, changed), "IDEMPOTENCY_CONFLICT");
    }
    expectCode(() => h.intents.reserve(h.operator, request()), "IDEMPOTENCY_CONFLICT");
    h.store.registerAgent({ agentId: "other-parent" });
    const other = createSpawnCaller({ principalId: "agent:parent", agentId: "other-parent" });
    expectCode(() => h.intents.reserve(other, request()), "IDEMPOTENCY_CONFLICT");
    expect(rowCount(h)).toBe(1);
  });

  it("denies a second operation for the same tuple, whoever asks", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    const rival = request({ spawnOperationId: "spawn-op-2", intendedAgentId: "child-2" });
    expectCode(() => h.intents.reserve(h.parent, rival), "AGENT_CONFLICT");
    expectCode(() => h.intents.reserve(h.operator, rival), "AGENT_CONFLICT");
    expect(rowCount(h)).toBe(1);
  });

  it("allows one in-flight spawn per intended agent and host", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    const sameAgent = request({ spawnOperationId: "spawn-op-2", externalId: "thread-2" });
    expectCode(() => h.intents.reserve(h.parent, sameAgent), "AGENT_CONFLICT");
    h.intents.reserve(h.parent, { ...sameAgent, hostInstanceId: "host-b" });
    expect(rowCount(h)).toBe(2);
  });

  it("denies a tuple that already has a managed host session", () => {
    const h = harness();
    const { agentId } = provisionSession(h, { externalId: "thread-live" });
    expect(agentId).toBe(deriveHostAgentId(ADAPTER, HOST, "thread-live"));
    expectCode(
      () =>
        h.intents.reserve(
          h.parent,
          request({ externalId: "thread-live", intendedAgentId: "someone-else" }),
        ),
      "AGENT_CONFLICT",
    );
    // The agent already holds a session on this host, so a second thread for it cannot be spawned.
    expectCode(
      () =>
        h.intents.reserve(
          h.parent,
          request({
            spawnOperationId: "spawn-op-2",
            externalId: "thread-2",
            intendedAgentId: agentId,
          }),
        ),
      "AGENT_CONFLICT",
    );
    expect(rowCount(h)).toBe(0);
  });

  it("rolls back with the outer transaction on the same connection", () => {
    const h = harness();
    expect(() =>
      h.store.database.transaction(() => {
        h.store.registerAgent({ agentId: "side-effect" });
        h.intents.reserve(h.parent, request());
        throw new Error("host dispatch claim failed");
      })(),
    ).toThrow("host dispatch claim failed");
    expect(rowCount(h)).toBe(0);
    expectCode(() => h.store.getAgent("side-effect"), "AGENT_NOT_FOUND");

    h.store.database.transaction(() => {
      h.store.registerAgent({ agentId: "side-effect" });
      h.intents.reserve(h.parent, request());
    })();
    expect(rowCount(h)).toBe(1);
    expect(h.store.getAgent("side-effect").agentId).toBe("side-effect");
  });

  it("rolls the outer transaction back when reservation is denied", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    expect(() =>
      h.store.database.transaction(() => {
        h.store.registerAgent({ agentId: "side-effect" });
        h.intents.reserve(
          h.parent,
          request({ spawnOperationId: "spawn-op-2", intendedAgentId: "child-2" }),
        );
      })(),
    ).toThrowError(expect.objectContaining({ code: "AGENT_CONFLICT" }));
    expectCode(() => h.store.getAgent("side-effect"), "AGENT_NOT_FOUND");
    expect(rowCount(h)).toBe(1);
  });
});

describe("adoption", () => {
  const claim = {
    adapter: ADAPTER,
    hostInstanceId: HOST,
    externalId: "thread-1",
    agentId: "child-1",
  };

  it("adopts a pending intent exactly once", () => {
    const h = harness();
    const reserved = h.intents.reserve(h.parent, request());
    h.clock.now = "2026-10-08T12:05:00.000Z";
    const adopted = h.intents.adopt(claim);
    expect(adopted).toMatchObject({
      spawnOperationId: reserved.spawnOperationId,
      status: "adopted",
      parentAgentId: "parent",
      spawnerPrincipalId: "agent:parent",
      adoptedAt: "2026-10-08T12:05:00.000Z",
    });
    expectCode(() => h.intents.adopt(claim), "AGENT_CONFLICT");
    expect(h.intents.find("spawn-op-1")).toEqual(adopted);
  });

  it("reports no intent for a tuple that was never reserved", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    expect(h.intents.adopt({ ...claim, externalId: "thread-other" })).toBeNull();
    expect(h.intents.adopt({ ...claim, hostInstanceId: "host-b" })).toBeNull();
    expect(h.intents.find("spawn-op-1")?.status).toBe("pending");
  });

  it("refuses a connector tuple that matches with a different agent and keeps the intent pending", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    expectCode(() => h.intents.adopt({ ...claim, agentId: "hijacker" }), "AGENT_CONFLICT");
    expect(h.intents.find("spawn-op-1")?.status).toBe("pending");
    expect(h.intents.adopt(claim)?.status).toBe("adopted");
  });

  it("does not overwrite a managed host session", () => {
    const h = harness();
    h.intents.reserve(h.parent, request({ externalId: "thread-live", intendedAgentId: "child-1" }));
    const { agentId } = provisionSession(h, { externalId: "thread-live" });
    expectCode(() => h.intents.adopt({ ...claim, externalId: "thread-live" }), "AGENT_CONFLICT");
    expect(
      h.intents.findByTuple({ adapter: ADAPTER, hostInstanceId: HOST, externalId: "thread-live" })
        ?.status,
    ).toBe("pending");
    const session = h.store.database
      .prepare("SELECT agent_id FROM identity_host_sessions WHERE external_id = 'thread-live'")
      .get() as { agent_id: string };
    expect(session.agent_id).toBe(agentId);
  });

  it("is transactional with the caller so a failed provision leaves it pending", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    expect(() =>
      h.store.database.transaction(() => {
        expect(h.intents.adopt(claim)?.status).toBe("adopted");
        throw new Error("provision failed");
      })(),
    ).toThrow("provision failed");
    expect(h.intents.find("spawn-op-1")?.status).toBe("pending");
  });

  it("never adopts an abandoned intent", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    h.intents.abandon(h.parent, "spawn-op-1", "host spawn failed");
    expectCode(() => h.intents.adopt(claim), "AGENT_CONFLICT");
    expect(h.intents.find("spawn-op-1")?.status).toBe("abandoned");
  });
});

describe("abandonment", () => {
  it("is terminal, idempotent and conservative about the tuple", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    h.clock.now = "2026-10-08T12:10:00.000Z";
    const abandoned = h.intents.abandon(h.parent, "spawn-op-1", "definite host failure");
    expect(abandoned).toMatchObject({
      status: "abandoned",
      statusReason: "definite host failure",
      abandonedAt: "2026-10-08T12:10:00.000Z",
    });
    h.clock.now = "2026-10-08T12:20:00.000Z";
    expect(h.intents.abandon(h.parent, "spawn-op-1", "again")).toEqual(abandoned);

    // The host may have created the thread, so neither a replay nor a rival may reclaim the tuple.
    expectCode(() => h.intents.reserve(h.parent, request()), "AGENT_CONFLICT");
    expectCode(
      () =>
        h.intents.reserve(
          h.parent,
          request({ spawnOperationId: "spawn-op-2", intendedAgentId: "child-2" }),
        ),
      "AGENT_CONFLICT",
    );
    expect(rowCount(h)).toBe(1);
  });

  it("cannot abandon an adopted intent", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    h.intents.adopt({
      adapter: ADAPTER,
      hostInstanceId: HOST,
      externalId: "thread-1",
      agentId: "child-1",
    });
    expectCode(() => h.intents.abandon(h.parent, "spawn-op-1", "late"), "AGENT_CONFLICT");
    expect(h.intents.find("spawn-op-1")?.status).toBe("adopted");
  });

  it("only the recorded spawner can abandon, and only as a trusted caller", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    expectCode(() => h.intents.abandon(h.operator, "spawn-op-1", "nope"), "UNAUTHORIZED");
    const fake = JSON.parse('{"principalId":"agent:parent","agentId":"parent"}') as SpawnCaller;
    expectCode(() => h.intents.abandon(fake, "spawn-op-1", "nope"), "UNAUTHORIZED");
    expectCode(() => h.intents.abandon(h.parent, "missing-op", "nope"), "OPERATION_NOT_FOUND");
    expect(h.intents.find("spawn-op-1")?.status).toBe("pending");
  });

  it("keeps terminal rows immutable even against direct SQL", () => {
    const h = harness();
    h.intents.reserve(h.parent, request());
    h.intents.abandon(h.parent, "spawn-op-1", "failed");
    const db = h.store.database;
    expect(() => db.prepare("DELETE FROM identity_spawn_intents").run()).toThrow(/permanent/);
    expect(() =>
      db.prepare("UPDATE identity_spawn_intents SET status = 'pending', abandoned_at = NULL").run(),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare("UPDATE identity_spawn_intents SET intended_agent_id = 'x'").run(),
    ).toThrow(/immutable/);
    expect(h.intents.find("spawn-op-1")?.status).toBe("abandoned");
  });
});

describe("restart persistence", () => {
  it("keeps pending and adopted intents across reopen without reapplying the migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-intents-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "sideband.db");
    const clock = { now: START };

    const first = SqliteSidebandStore.open(path, { now: () => clock.now });
    const h1 = harness({ store: first, clock });
    const pending = h1.intents.reserve(h1.parent, request());
    h1.intents.reserve(
      h1.parent,
      request({ spawnOperationId: "spawn-op-2", externalId: "thread-2", intendedAgentId: "c2" }),
    );
    h1.intents.adopt({
      adapter: ADAPTER,
      hostInstanceId: HOST,
      externalId: "thread-2",
      agentId: "c2",
    });
    const applied = first.appliedMigrations().find((m) => m.version === 4);
    first.close();

    clock.now = "2026-10-09T00:00:00.000Z";
    const second = SqliteSidebandStore.open(path, { now: () => clock.now });
    cleanups.push(() => second.close());
    expect(second.appliedMigrations().some((m) => m.version === 4)).toBe(true);
    const h2 = harness({ store: second, clock });
    expect(second.appliedMigrations().find((m) => m.version === 4)).toEqual(applied);
    expect(h2.intents.find("spawn-op-1")).toEqual(pending);
    expect(h2.intents.find("spawn-op-2")?.status).toBe("adopted");
    expect(h2.intents.reserve(h2.parent, request())).toEqual(pending);
    expectCode(
      () =>
        h2.intents.adopt({
          adapter: ADAPTER,
          hostInstanceId: HOST,
          externalId: "thread-2",
          agentId: "c2",
        }),
      "AGENT_CONFLICT",
    );
  });
});

describe("migration 4", () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  it("is not part of core open, so core cannot apply it before identity 3 exists", () => {
    const store = SqliteSidebandStore.open(":memory:");
    cleanups.push(() => store.close());
    expect(store.appliedMigrations().map((m) => m.version)).toEqual([1, 2]);
    const tables = store.database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'identity_spawn_intents'")
      .all();
    expect(tables).toHaveLength(0);
  });

  it("refuses to attach before the identity schema exists and records nothing", () => {
    const store = SqliteSidebandStore.open(":memory:");
    cleanups.push(() => store.close());
    expectCode(
      () => SpawnIntentStore.attach(store, { authorize: echoPolicy }),
      "MIGRATION_CONFLICT",
    );
    expect(store.appliedMigrations().map((m) => m.version)).toEqual([1, 2]);
    expect(
      store.database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'identity_spawn_intents'")
        .all(),
    ).toHaveLength(0);
  });

  it("applies through the shared ledger once with the file checksum", () => {
    const h = harness();
    const again = SpawnIntentStore.attach(h.store, { authorize: echoPolicy });
    expect(again).toBeInstanceOf(SpawnIntentStore);
    const rows = h.store.appliedMigrations().filter((m) => m.version === 4);
    expect(rows).toHaveLength(1);
    const sql = readFileSync(
      new URL("../migrations/0004_spawn_intents.sql", import.meta.url),
      "utf8",
    );
    expect(rows[0]).toMatchObject({ name: "spawn_intents", checksum: sha(sql) });
    expect(spawnIntentMigration()).toEqual({ version: 4, name: "spawn_intents", sql });
  });

  it("rejects a changed migration body after it was applied", () => {
    const h = harness();
    const changed = { ...spawnIntentMigration(), sql: `${spawnIntentMigration().sql}\n-- edited` };
    expectCode(() => h.store.applyMigrations([changed]), "MIGRATION_CONFLICT");
  });

  it("preserves 0001-0003 data and the earlier ledger rows", () => {
    const clock = { now: START };
    const store = SqliteSidebandStore.open(":memory:", { now: () => clock.now });
    cleanups.push(() => store.close());
    IdentityService.create(store, { now: () => clock.now });
    store.registerAgent({ agentId: "sender" });
    store.registerAgent({ agentId: "recipient" });
    const sent = store.sendMessage({
      idempotencyKey: "pre-0004",
      fromAgentId: "sender",
      target: { type: "agent", id: "recipient" },
      correlationId: "pre",
      body: "written before migration 4",
      messageClass: "request",
      provenance: {
        authenticatedPrincipalId: "operator:test",
        source: "mcp",
        sourceInstanceId: "t3-local",
        sourceOperationId: null,
        trust: "untrusted",
      },
    });
    const { agentId } = provisionSessionOn(store, clock);
    const before = store.appliedMigrations();
    const sessions = store.database.prepare("SELECT * FROM identity_host_sessions").all();

    SpawnIntentStore.attach(store, { now: () => clock.now, authorize: echoPolicy });

    const after = store.appliedMigrations();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((m) => m.version)).toEqual([1, 2, 4]);
    expect(store.getMessage(sent.messageId).body).toBe("written before migration 4");
    expect(store.database.prepare("SELECT * FROM identity_host_sessions").all()).toEqual(sessions);
    expect(store.getAgent(agentId).agentId).toBe(agentId);
  });
});

function provisionSessionOn(
  store: SqliteSidebandStore,
  clock: { now: string },
): { agentId: string } {
  const identity = IdentityService.create(store, { now: () => clock.now });
  const issued = identity.enrollConnector(createOperatorPrincipal("operator:test"), {
    adapter: ADAPTER,
    hostInstanceId: HOST,
  });
  const connector = identity.resolveConnector(issued.token);
  if (connector === null) throw new Error("connector did not resolve");
  const access = identity.provision(
    connector,
    {
      adapter: ADAPTER,
      hostInstanceId: HOST,
      externalId: "thread-pre",
      providerSessionId: "provider-1",
      hostEpoch: "epoch-1",
      leaseSeconds: 60,
    },
    "provision-pre",
  );
  return { agentId: (access as { agentId: string }).agentId };
}
