import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SidebandError } from "../src/core/errors.js";
import {
  CredentialAlreadyIssuedError,
  IdentityService,
  createOperatorPrincipal,
  deriveHostAgentId,
  type HostConnectorPrincipal,
  type HostSessionRegistration,
  type IssuedAgentAccess,
} from "../src/security/index.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";

const START = "2026-10-08T12:00:00.000Z";
const ADAPTER = "test-host";
const HOST = "host-a";

const stores: SqliteSidebandStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

interface Harness {
  readonly clock: { now: string };
  readonly store: SqliteSidebandStore;
  readonly identity: IdentityService;
  readonly operator: ReturnType<typeof createOperatorPrincipal>;
  readonly connector: HostConnectorPrincipal;
  readonly connectorToken: string;
  tick(seconds: number): void;
  enroll(adapter: string, host: string, allowed?: readonly string[]): HostConnectorPrincipal;
}

function harness(options: { operatorPrincipalIds?: readonly string[] } = {}): Harness {
  const clock = { now: START };
  const store = SqliteSidebandStore.open(":memory:", { now: () => clock.now });
  stores.push(store);
  const identity = IdentityService.create(store, {
    now: () => clock.now,
    ...(options.operatorPrincipalIds === undefined
      ? {}
      : { operatorPrincipalIds: new Set(options.operatorPrincipalIds) }),
  });
  const operator = createOperatorPrincipal("operator:test");
  const enroll = (
    adapter: string,
    host: string,
    allowed?: readonly string[],
  ): HostConnectorPrincipal => {
    const issued = identity.enrollConnector(operator, {
      adapter,
      hostInstanceId: host,
      ...(allowed === undefined ? {} : { allowedAgentIds: allowed }),
    });
    const principal = identity.resolveConnector(issued.token);
    if (principal === null) throw new Error("connector did not resolve");
    return principal;
  };
  const connectorIssued = identity.enrollConnector(operator, {
    adapter: ADAPTER,
    hostInstanceId: HOST,
  });
  const connector = identity.resolveConnector(connectorIssued.token);
  if (connector === null) throw new Error("connector did not resolve");
  return {
    clock,
    store,
    identity,
    operator,
    connector,
    connectorToken: connectorIssued.token,
    tick(seconds: number) {
      clock.now = new Date(new Date(clock.now).getTime() + seconds * 1_000).toISOString();
    },
    enroll,
  };
}

function registration(overrides: Partial<HostSessionRegistration> = {}): HostSessionRegistration {
  return {
    adapter: ADAPTER,
    hostInstanceId: HOST,
    externalId: "thread-1",
    providerSessionId: "provider-1",
    hostEpoch: "epoch-1",
    leaseSeconds: 60,
    ...overrides,
  };
}

function provision(
  h: Harness,
  overrides: Partial<HostSessionRegistration> = {},
  key = `provision-${overrides.externalId ?? "thread-1"}-${overrides.providerSessionId ?? "provider-1"}`,
  connector: HostConnectorPrincipal = h.connector,
): IssuedAgentAccess {
  return h.identity.provision(connector, registration(overrides), key);
}

function code(error: unknown): string | undefined {
  return error instanceof SidebandError ? error.code : undefined;
}

function expectCode(fn: () => unknown, expected: string): SidebandError {
  try {
    fn();
  } catch (error) {
    expect(code(error)).toBe(expected);
    return error as SidebandError;
  }
  throw new Error(`expected ${expected} but nothing was thrown`);
}

function dumpDatabase(database: Database.Database): string {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map(({ name }) => JSON.stringify(database.prepare(`SELECT * FROM "${name}"`).all()))
    .join("\n");
}

describe("host connector credentials", () => {
  it("returns a connector token once, stores only its hash, and scopes it to one host", () => {
    const h = harness();
    expect(h.connectorToken).toMatch(/^sbct_[A-Za-z0-9_-]{43}$/);
    expect(h.connector).toMatchObject({
      kind: "connector",
      adapter: ADAPTER,
      hostInstanceId: HOST,
    });
    expect(dumpDatabase(h.store.database)).not.toContain(h.connectorToken);
    expect(h.identity.resolveConnector("sbct_nope")).toBeNull();
    expect(h.identity.resolveConnector("")).toBeNull();

    const err = expectCode(
      () => h.identity.enrollConnector(h.operator, { adapter: ADAPTER, hostInstanceId: HOST }),
      "CREDENTIAL_ALREADY_ISSUED",
    );
    expect(err).toBeInstanceOf(CredentialAlreadyIssuedError);
    expect(JSON.stringify(err.details)).not.toContain("sbct_");
  });

  it("rotates a connector credential once per rotationId and kills the old token", () => {
    const h = harness();
    const rotated = h.identity.rotateConnector(h.operator, {
      adapter: ADAPTER,
      hostInstanceId: HOST,
      rotationId: "rot-1",
    });
    expect(h.identity.resolveConnector(h.connectorToken)).toBeNull();
    expect(h.identity.resolveConnector(rotated.token)).not.toBeNull();
    expectCode(
      () =>
        h.identity.rotateConnector(h.operator, {
          adapter: ADAPTER,
          hostInstanceId: HOST,
          rotationId: "rot-1",
        }),
      "CREDENTIAL_ALREADY_ISSUED",
    );
    // A stale principal object from the old credential is re-verified against the database.
    expectCode(() => provision(h), "UNAUTHORIZED");
  });

  it("expires and revokes connectors", () => {
    const h = harness();
    const short = h.identity.enrollConnector(h.operator, {
      adapter: ADAPTER,
      hostInstanceId: "short",
      expiresAt: "2026-10-08T12:10:00.000Z",
    });
    expect(h.identity.resolveConnector(short.token)).not.toBeNull();
    h.tick(601);
    expect(h.identity.resolveConnector(short.token)).toBeNull();

    h.identity.revokeConnector(h.operator, {
      adapter: ADAPTER,
      hostInstanceId: HOST,
      reason: "decommissioned",
    });
    expect(h.identity.resolveConnector(h.connectorToken)).toBeNull();
    expectCode(() => provision(h), "UNAUTHORIZED");
  });

  it("revoking a connector also kills the sessions it provisioned", () => {
    const h = harness();
    const access = provision(h);
    expect(h.identity.resolveBearer(access.token)).not.toBeNull();
    h.identity.revokeConnector(h.operator, {
      adapter: ADAPTER,
      hostInstanceId: HOST,
      reason: "host compromised",
    });
    expect(h.identity.resolveBearer(access.token)).toBeNull();
    expect(h.store.getBinding(access.bindingId).active).toBe(false);
  });

  it("rejects forged principals and non-operator management calls", () => {
    const h = harness();
    const forgedOperator = { kind: "operator", principalId: "operator:test" };
    expectCode(
      () =>
        h.identity.enrollConnector(forgedOperator as never, {
          adapter: ADAPTER,
          hostInstanceId: "x",
        }),
      "UNAUTHORIZED",
    );
    const forgedConnector = { ...h.connector };
    expectCode(
      () => h.identity.provision(forgedConnector, registration(), "forged"),
      "UNAUTHORIZED",
    );
  });
});

describe("automatic identity provisioning", () => {
  it("derives a stable, collision-framed agent id from adapter, host and external id", () => {
    const base = deriveHostAgentId("x", "ab", "c");
    expect(deriveHostAgentId("x", "ab", "c")).toBe(base);
    expect(deriveHostAgentId("xa", "b", "c")).not.toBe(base);
    expect(deriveHostAgentId("x", "a", "bc")).not.toBe(base);
    expect(deriveHostAgentId("x", "ab", "d")).not.toBe(base);
    expect(base.length).toBeLessThanOrEqual(128);
  });

  it("atomically creates agent, principal, binding, session and a once-returned token", () => {
    const h = harness();
    const access = provision(h, { displayName: "Planner" });
    const expectedAgent = deriveHostAgentId(ADAPTER, HOST, "thread-1");

    expect(access).toMatchObject({
      agentId: expectedAgent,
      principalId: `agent:${expectedAgent}`,
      generation: 1,
    });
    expect(access.token).toMatch(/^sbat_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(access.token.slice(5), "base64url")).toHaveLength(32);
    expect(access.expiresAt).toBe("2026-10-08T20:00:00.000Z");
    expect(access.leaseExpiresAt).toBe("2026-10-08T12:01:00.000Z");

    const binding = h.store.getBinding(access.bindingId);
    expect(binding).toMatchObject({
      agentId: expectedAgent,
      adapter: ADAPTER,
      hostInstanceId: HOST,
      externalId: "thread-1",
      providerSessionId: "provider-1",
      generation: 1,
      active: true,
      leaseExpiresAt: access.leaseExpiresAt,
    });
    expect(h.store.getAgent(expectedAgent).lifecycle).toBe("active");

    const dump = dumpDatabase(h.store.database);
    expect(dump).not.toContain(access.token);
    expect(dump).not.toContain(access.token.slice(5));
    const events = h.store.database.prepare("SELECT payload_json FROM events").all();
    expect(JSON.stringify(events)).not.toContain("sbat_");
  });

  it("does not leak the operator token and gives each session its own credential", () => {
    const h = harness();
    const one = provision(h, { externalId: "thread-1" });
    const two = provision(h, { externalId: "thread-2", providerSessionId: "provider-2" });
    expect(one.token).not.toBe(two.token);
    expect(one.agentId).not.toBe(two.agentId);
    expect(h.identity.resolveBearer(h.connectorToken)).toBeNull();
    expect(h.identity.resolveBearer(one.token)?.agentId).toBe(one.agentId);
    expect(h.identity.resolveBearer(two.token)?.agentId).toBe(two.agentId);
  });

  it("resolves a bearer to principal, exact session tuple and narrow grants only", () => {
    const h = harness();
    const access = provision(h);
    const caller = h.identity.resolveBearer(access.token);
    expect(caller).toMatchObject({
      principalId: access.principalId,
      agentId: access.agentId,
      hostSessionId: access.hostSessionId,
      bindingId: access.bindingId,
      generation: 1,
      adapter: ADAPTER,
      hostInstanceId: HOST,
      externalId: "thread-1",
    });
    for (const grant of [
      "identity:read",
      "inbox:read",
      "inbox:ack",
      "messages:send",
      "presence:write",
      "schedules:create",
      "schedules:read",
      "schedules:cancel",
    ]) {
      expect(caller?.grants.has(grant as never)).toBe(true);
    }
    for (const forbidden of ["admin", "lifecycle:control", "events:read", "agents:write"]) {
      expect(caller?.grants.has(forbidden as never)).toBe(false);
    }
    expect(h.identity.resolveBearer("sbat_" + "A".repeat(43))).toBeNull();
    expect(h.identity.resolveBearer(access.token + "x")).toBeNull();
    expect(h.identity.resolveBearer("")).toBeNull();
  });

  it("expires the tool token at its bound", () => {
    const h = harness();
    const access = provision(h);
    h.identity.heartbeat(h.connector, {
      hostSessionId: access.hostSessionId,
      hostEpoch: "epoch-1",
      leaseSeconds: 60,
    });
    h.tick(8 * 3_600 - 1);
    h.identity.heartbeat(h.connector, {
      hostSessionId: access.hostSessionId,
      hostEpoch: "epoch-1",
      leaseSeconds: 60,
    });
    expect(h.identity.resolveBearer(access.token)).not.toBeNull();
    h.tick(2);
    expect(h.identity.resolveBearer(access.token)).toBeNull();
  });

  it("returns an explicit already-issued error on provision replay and never reconstructs the token", () => {
    const h = harness();
    const access = provision(h, {}, "key-1");
    const err = expectCode(() => provision(h, {}, "key-1"), "CREDENTIAL_ALREADY_ISSUED");
    expect(err).toBeInstanceOf(CredentialAlreadyIssuedError);
    expect(err.details).toMatchObject({
      agentId: access.agentId,
      principalId: access.principalId,
      hostSessionId: access.hostSessionId,
      bindingId: access.bindingId,
      generation: 1,
    });
    expect(JSON.stringify(err.details)).not.toContain(access.token);
    expect(JSON.stringify(err.details)).not.toContain("sbat_");

    // A different request under the same key is a conflict, not a replay.
    expectCode(
      () => provision(h, { providerSessionId: "provider-9" }, "key-1"),
      "IDEMPOTENCY_CONFLICT",
    );
    // A fresh key for an unchanged live session still cannot mint.
    expectCode(() => provision(h, {}, "key-2"), "CREDENTIAL_ALREADY_ISSUED");
    // The original token keeps working through all of that.
    expect(h.identity.resolveBearer(access.token)).not.toBeNull();
  });

  it("rotates exactly once per rotationId and atomically revokes the prior credential", () => {
    const h = harness();
    const access = provision(h);
    const rotated = h.identity.rotate(h.connector, {
      hostSessionId: access.hostSessionId,
      hostEpoch: "epoch-1",
      rotationId: "rot-1",
    });
    expect(rotated.token).not.toBe(access.token);
    expect(rotated.credentialId).not.toBe(access.credentialId);
    expect(rotated.generation).toBe(1);
    expect(h.identity.resolveBearer(access.token)).toBeNull();
    expect(h.identity.resolveBearer(rotated.token)?.agentId).toBe(access.agentId);
    expectCode(
      () =>
        h.identity.rotate(h.connector, {
          hostSessionId: access.hostSessionId,
          hostEpoch: "epoch-1",
          rotationId: "rot-1",
        }),
      "CREDENTIAL_ALREADY_ISSUED",
    );
    expectCode(
      () =>
        h.identity.rotate(h.connector, {
          hostSessionId: access.hostSessionId,
          hostEpoch: "stale-epoch",
          rotationId: "rot-2",
        }),
      "UNAUTHORIZED",
    );
    expect(h.identity.resolveBearer(rotated.token)).not.toBeNull();

    // A rotationId is bound to its session; reusing it elsewhere is a conflict.
    const other = provision(h, { externalId: "thread-2", providerSessionId: "provider-2" });
    expectCode(
      () =>
        h.identity.rotate(h.connector, {
          hostSessionId: other.hostSessionId,
          hostEpoch: "epoch-1",
          rotationId: "rot-1",
        }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("keeps the logical identity across sessions and revokes the old session credential", () => {
    const h = harness();
    const first = provision(h);
    h.tick(30);
    const second = provision(h, { providerSessionId: "provider-2", hostEpoch: "epoch-1" });
    expect(second.agentId).toBe(first.agentId);
    expect(second.principalId).toBe(first.principalId);
    expect(second.generation).toBe(2);
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(h.identity.resolveBearer(first.token)).toBeNull();
    expect(h.identity.resolveBearer(second.token)?.generation).toBe(2);
    expect(h.store.getBinding(first.bindingId).active).toBe(false);
    expect(h.store.getActiveBinding(first.agentId, ADAPTER).bindingId).toBe(second.bindingId);
  });

  it("rejects spoofed host tuples and unauthorized aliases", () => {
    const h = harness();
    expectCode(() => provision(h, { hostInstanceId: "host-b" }), "UNAUTHORIZED");
    expectCode(() => provision(h, { adapter: "other-host" }), "UNAUTHORIZED");
    expectCode(() => provision(h, { requestedAgentId: "lead" }), "UNAUTHORIZED");
    expect(() => h.store.getAgent("lead")).toThrow();
    expect(h.store.listAgents()).toHaveLength(0);
  });

  it("maps an allow-listed alias onto exactly one host tuple", () => {
    const h = harness();
    const aliasConnector = h.enroll(ADAPTER, "alias-host", ["reviewer"]);
    const access = provision(
      h,
      { hostInstanceId: "alias-host", requestedAgentId: "reviewer" },
      "alias-1",
      aliasConnector,
    );
    expect(access.agentId).toBe("reviewer");

    // The same tuple may not be remapped to another identity.
    expectCode(
      () =>
        provision(
          h,
          { hostInstanceId: "alias-host", requestedAgentId: "other" },
          "alias-2",
          aliasConnector,
        ),
      "UNAUTHORIZED",
    );
    // Another tuple on the same host may not claim the same alias.
    expectCode(
      () =>
        provision(
          h,
          { hostInstanceId: "alias-host", externalId: "thread-9", requestedAgentId: "reviewer" },
          "alias-3",
          aliasConnector,
        ),
      "AGENT_CONFLICT",
    );
    // Omitting the alias on a later enrollment keeps the mapping; the derived id never shadows it.
    const again = provision(
      h,
      { hostInstanceId: "alias-host", providerSessionId: "p2" },
      "alias-4",
      aliasConnector,
    );
    expect(again.agentId).toBe("reviewer");
    expect(again.generation).toBe(2);
  });

  it("adopts a pre-registered alias agent without disturbing its display name", () => {
    const h = harness();
    h.store.registerAgent({ agentId: "reviewer", displayName: "Reviewer" });
    const aliasConnector = h.enroll(ADAPTER, "alias-host", ["reviewer"]);
    const access = provision(
      h,
      { hostInstanceId: "alias-host", requestedAgentId: "reviewer" },
      "alias-1",
      aliasConnector,
    );
    expect(access.agentId).toBe("reviewer");
    expect(h.store.getAgent("reviewer").displayName).toBe("Reviewer");
  });

  it("rolls everything back when any part of provisioning fails", () => {
    const h = harness();
    h.store.database.exec(
      `CREATE TRIGGER fail_credential BEFORE INSERT ON identity_credentials
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() => provision(h)).toThrow();
    for (const table of [
      "agents",
      "bindings",
      "identity_principals",
      "identity_host_sessions",
      "identity_schedule_grants",
      "identity_operations",
    ]) {
      const count = h.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      };
      expect(count.n, table).toBe(0);
    }
  });

  it("applies the identity migration on top of the initial schema alone, idempotently", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    const sql = readFileSync(new URL("../migrations/0003_identity.sql", import.meta.url), "utf8");
    database.exec(sql);
    database.exec(sql);
    const tables = (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "identity_connectors",
        "identity_principals",
        "identity_host_sessions",
        "identity_credentials",
        "identity_operations",
        "identity_schedule_grants",
      ]),
    );
    database.close();
  });
});

describe("host session lifecycle", () => {
  it("renews the lease with heartbeats and requires the exact host epoch", () => {
    const h = harness();
    const access = provision(h);
    h.tick(40);
    const renewed = h.identity.heartbeat(h.connector, {
      hostSessionId: access.hostSessionId,
      hostEpoch: "epoch-1",
      leaseSeconds: 60,
    });
    expect(renewed.leaseExpiresAt).toBe("2026-10-08T12:01:40.000Z");
    expect(h.store.getBinding(access.bindingId).leaseExpiresAt).toBe(renewed.leaseExpiresAt);
    expectCode(
      () =>
        h.identity.heartbeat(h.connector, {
          hostSessionId: access.hostSessionId,
          hostEpoch: "epoch-0",
          leaseSeconds: 60,
        }),
      "UNAUTHORIZED",
    );
    h.tick(50);
    // t=90: past the original lease (60) but within the renewed one (100).
    expect(h.identity.resolveBearer(access.token)).not.toBeNull();
  });

  it("treats a lapsed lease as offline for tools, and a same-epoch heartbeat revives it", () => {
    const h = harness();
    const access = provision(h);
    h.tick(61);
    expect(h.identity.resolveBearer(access.token)).toBeNull();
    h.identity.heartbeat(h.connector, {
      hostSessionId: access.hostSessionId,
      hostEpoch: "epoch-1",
      leaseSeconds: 60,
    });
    expect(h.identity.resolveBearer(access.token)?.agentId).toBe(access.agentId);
  });

  it("rejects the old host epoch once the session is reconciled under a new one", () => {
    const h = harness();
    const first = provision(h);
    const second = provision(h, { providerSessionId: "provider-2", hostEpoch: "epoch-2" });
    expectCode(
      () =>
        h.identity.heartbeat(h.connector, {
          hostSessionId: first.hostSessionId,
          hostEpoch: "epoch-1",
          leaseSeconds: 60,
        }),
      "UNAUTHORIZED",
    );
    expect(h.identity.resolveBearer(first.token)).toBeNull();
    expect(h.identity.resolveBearer(second.token)).not.toBeNull();
  });

  it("scopes lifecycle calls to the connector's own host", () => {
    const h = harness();
    const access = provision(h);
    const other = h.enroll(ADAPTER, "host-b");
    expectCode(
      () =>
        h.identity.heartbeat(other, {
          hostSessionId: access.hostSessionId,
          hostEpoch: "epoch-1",
          leaseSeconds: 60,
        }),
      "UNAUTHORIZED",
    );
    expectCode(
      () =>
        h.identity.rotate(other, {
          hostSessionId: access.hostSessionId,
          hostEpoch: "epoch-1",
          rotationId: "r",
        }),
      "UNAUTHORIZED",
    );
    expectCode(
      () =>
        h.identity.markOffline(other, { hostSessionId: access.hostSessionId, reason: "x" }, "k"),
      "UNAUTHORIZED",
    );
    expect(h.identity.resolveBearer(access.token)).not.toBeNull();
  });

  it("marks a session offline: revokes tokens and binding, keeps identity and grants", () => {
    const h = harness();
    const access = provision(h);
    h.identity.markOffline(
      h.connector,
      { hostSessionId: access.hostSessionId, reason: "session stopped" },
      "off-1",
    );
    h.identity.markOffline(
      h.connector,
      { hostSessionId: access.hostSessionId, reason: "session stopped" },
      "off-1",
    );
    expect(h.identity.resolveBearer(access.token)).toBeNull();
    expect(h.store.getBinding(access.bindingId).active).toBe(false);
    expect(h.store.getAgent(access.agentId).lifecycle).toBe("active");
    expectCode(
      () =>
        h.identity.heartbeat(h.connector, {
          hostSessionId: access.hostSessionId,
          hostEpoch: "epoch-1",
          leaseSeconds: 60,
        }),
      "UNAUTHORIZED",
    );
    // Authorized renewal gives the same logical identity a fresh credential.
    const again = provision(h, { providerSessionId: "provider-2" });
    expect(again.agentId).toBe(access.agentId);
    expect(h.identity.resolveBearer(again.token)).not.toBeNull();
  });

  it("explicit revoke blocks tokens, refuses re-enrollment, and needs an operator to restore", () => {
    const h = harness();
    const access = provision(h);
    h.identity.revoke(
      h.connector,
      { hostSessionId: access.hostSessionId, reason: "operator request" },
      "rev-1",
    );
    expect(h.identity.resolveBearer(access.token)).toBeNull();
    const err = expectCode(() => provision(h, { providerSessionId: "provider-2" }), "UNAUTHORIZED");
    expect(err.details).toMatchObject({ reason: "ACCESS_REVOKED" });
    expect(h.store.listBindings(access.agentId, { includeInactive: true }).items).toHaveLength(1);

    h.identity.restoreAccess(h.operator, { agentId: access.agentId });
    const restored = provision(h, { providerSessionId: "provider-2" });
    expect(restored.agentId).toBe(access.agentId);
    expect(h.identity.resolveBearer(restored.token)).not.toBeNull();
  });
});

it.each([122, 123, 128])(
  "validates derived principal length before persisting alias %i",
  (length) => {
    const h = harness();
    const alias = "a".repeat(length);
    const connector = h.enroll(ADAPTER, "alias-host", [alias]);
    const before = dumpDatabase(h.store.database);
    const issue = () =>
      provision(
        h,
        { hostInstanceId: "alias-host", requestedAgentId: alias },
        "alias-test",
        connector,
      );
    if (length <= 122) expect(issue().principalId).toHaveLength(128);
    else {
      expectCode(issue, "INVALID_ARGUMENT");
      expect(dumpDatabase(h.store.database)).toBe(before);
    }
  },
);
