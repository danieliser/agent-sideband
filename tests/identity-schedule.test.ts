import { afterEach, describe, expect, it } from "vitest";

import { SidebandError } from "../src/core/errors.js";
import {
  IdentityService,
  createOperatorPrincipal,
  type AuthenticatedAgent,
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
  tick(seconds: number): void;
  session(externalId: string, overrides?: Partial<HostSessionRegistration>): IssuedAgentAccess;
  caller(access: IssuedAgentAccess): AuthenticatedAgent;
}

function harness(operatorPrincipalIds: readonly string[] = []): Harness {
  const clock = { now: START };
  const store = SqliteSidebandStore.open(":memory:", { now: () => clock.now });
  stores.push(store);
  const identity = IdentityService.create(store, {
    now: () => clock.now,
    operatorPrincipalIds: new Set(operatorPrincipalIds),
  });
  const operator = createOperatorPrincipal("operator:test");
  const issued = identity.enrollConnector(operator, { adapter: ADAPTER, hostInstanceId: HOST });
  const connector = identity.resolveConnector(issued.token);
  if (connector === null) throw new Error("connector did not resolve");
  const session = (
    externalId: string,
    overrides: Partial<HostSessionRegistration> = {},
  ): IssuedAgentAccess =>
    identity.provision(
      connector,
      {
        adapter: ADAPTER,
        hostInstanceId: HOST,
        externalId,
        providerSessionId: `provider-${externalId}`,
        hostEpoch: "epoch-1",
        leaseSeconds: 60,
        ...overrides,
      },
      `provision-${externalId}-${overrides.providerSessionId ?? "p"}`,
    );
  return {
    clock,
    store,
    identity,
    operator,
    connector,
    session,
    caller(access) {
      const caller = identity.resolveBearer(access.token);
      if (caller === null) throw new Error("token did not resolve");
      return caller;
    },
    tick(seconds) {
      clock.now = new Date(new Date(clock.now).getTime() + seconds * 1_000).toISOString();
    },
  };
}

function keepAlive(h: Harness, access: IssuedAgentAccess, epoch = "epoch-1"): void {
  h.identity.heartbeat(h.connector, {
    hostSessionId: access.hostSessionId,
    hostEpoch: epoch,
    leaseSeconds: 60,
  });
}

function expectCode(fn: () => unknown, expected: string): SidebandError {
  try {
    fn();
  } catch (error) {
    expect((error as SidebandError).code).toBe(expected);
    return error as SidebandError;
  }
  throw new Error(`expected ${expected} but nothing was thrown`);
}

describe("schedule target authorization", () => {
  it("allows self scheduling and stamps the grant identity and epoch", () => {
    const h = harness();
    const parent = h.session("parent");
    const decision = h.identity.authorizeSchedule(
      h.caller(parent),
      parent.principalId,
      parent.agentId,
    );
    expect(decision).toMatchObject({
      allowed: true,
      ownerPrincipalId: parent.principalId,
      ownerAgentId: parent.agentId,
      targetAgentId: parent.agentId,
    });
    expect(decision.allowed && decision.grantId).toBeTruthy();
    expect(decision.allowed && decision.grantEpoch).toBeGreaterThanOrEqual(1);
  });

  it("allows a verified direct child but never the reverse, a sibling, or a stranger", () => {
    const h = harness();
    const parent = h.session("parent");
    const child = h.session("child", { parentAgentId: parent.agentId });
    const sibling = h.session("sibling", { parentAgentId: parent.agentId });
    const stranger = h.session("stranger");

    expect(
      h.identity.authorizeSchedule(h.caller(parent), parent.principalId, child.agentId).allowed,
    ).toBe(true);
    for (const [actor, target] of [
      [child, parent],
      [child, sibling],
      [sibling, child],
      [stranger, child],
      [parent, stranger],
    ] as const) {
      const decision = h.identity.authorizeSchedule(
        h.caller(actor),
        actor.principalId,
        target.agentId,
      );
      expect(decision.allowed).toBe(false);
    }
  });

  it("grants no authority from team metadata or grandchild distance", () => {
    const h = harness();
    const lead = h.session("lead");
    const worker = h.session("worker");
    h.store.createTeam({ teamId: "ops" });
    h.store.addTeamMember({ teamId: "ops", agentId: lead.agentId, role: "lead" });
    h.store.addTeamMember({
      teamId: "ops",
      agentId: worker.agentId,
      role: "worker",
      parentAgentId: lead.agentId,
    });
    expect(
      h.identity.authorizeSchedule(h.caller(lead), lead.principalId, worker.agentId).allowed,
    ).toBe(false);

    const child = h.session("child", { parentAgentId: lead.agentId });
    const grandchild = h.session("grandchild", { parentAgentId: child.agentId });
    expect(
      h.identity.authorizeSchedule(h.caller(lead), lead.principalId, grandchild.agentId).allowed,
    ).toBe(false);
    expect(
      h.identity.authorizeSchedule(h.caller(child), child.principalId, grandchild.agentId).allowed,
    ).toBe(true);
  });

  it("derives the owner from the bearer: a spoofed owner or missing grant is refused", () => {
    const h = harness();
    const parent = h.session("parent");
    const other = h.session("other");
    const actor = h.caller(parent);
    expect(h.identity.authorizeSchedule(actor, other.principalId, parent.agentId).allowed).toBe(
      false,
    );
    const stripped: AuthenticatedAgent = {
      ...actor,
      grants: new Set([...actor.grants].filter((grant) => grant !== "schedules:create")),
    };
    expect(h.identity.authorizeSchedule(stripped, parent.principalId, parent.agentId).allowed).toBe(
      false,
    );
  });

  it("re-verifies the actor against live state: stale or forged objects gain nothing", () => {
    const h = harness();
    const parent = h.session("parent");
    const child = h.session("child", { parentAgentId: parent.agentId });
    const stranger = h.session("stranger");
    const actor = h.caller(parent);

    // A forged identity swap keeps the real credential id but claims another principal.
    const impersonating: AuthenticatedAgent = {
      ...h.caller(stranger),
      credentialId: actor.credentialId,
    };
    expect(
      h.identity.authorizeSchedule(impersonating, stranger.principalId, child.agentId).allowed,
    ).toBe(false);

    // A held copy dies with its credential.
    h.identity.rotate(h.connector, {
      hostSessionId: parent.hostSessionId,
      hostEpoch: "epoch-1",
      rotationId: "rot-1",
    });
    expect(h.identity.authorizeSchedule(actor, parent.principalId, child.agentId).allowed).toBe(
      false,
    );

    // A plain-JSON operator is not an operator.
    const forgedOperator = { kind: "operator", principalId: "operator:test" } as never;
    expect(
      h.identity.authorizeSchedule(forgedOperator, "operator:test", child.agentId).allowed,
    ).toBe(false);
  });

  it("refuses unknown, retired, or revoked targets", () => {
    const h = harness();
    const parent = h.session("parent");
    const child = h.session("child", { parentAgentId: parent.agentId });
    const actor = h.caller(parent);
    expect(h.identity.authorizeSchedule(actor, parent.principalId, "ghost").allowed).toBe(false);
    h.store.database
      .prepare("UPDATE agents SET lifecycle = 'retired' WHERE agent_id = ?")
      .run(child.agentId);
    expect(h.identity.authorizeSchedule(actor, parent.principalId, child.agentId).allowed).toBe(
      false,
    );
  });

  it("restricts cancel to the owner and read to owner or target", () => {
    const h = harness();
    const parent = h.session("parent");
    const child = h.session("child", { parentAgentId: parent.agentId });
    const stranger = h.session("stranger");
    const owner = parent.principalId;
    const authorize = (who: IssuedAgentAccess, action: "cancel" | "read") =>
      h.identity.authorizeSchedule(h.caller(who), owner, child.agentId, action).allowed;

    expect(authorize(parent, "cancel")).toBe(true);
    expect(authorize(child, "cancel")).toBe(false);
    expect(authorize(stranger, "cancel")).toBe(false);
    expect(authorize(parent, "read")).toBe(true);
    expect(authorize(child, "read")).toBe(true);
    expect(authorize(stranger, "read")).toBe(false);
  });

  it("lets an operator schedule for any active registered agent", () => {
    const h = harness();
    const target = h.session("target");
    expect(
      h.identity.authorizeSchedule(h.operator, h.operator.principalId, target.agentId).allowed,
    ).toBe(true);
    expect(h.identity.authorizeSchedule(h.operator, h.operator.principalId, "ghost").allowed).toBe(
      false,
    );
  });
});

describe("verified spawn provenance", () => {
  it("rejects a parent that is unknown, retired, on another host, or revoked", () => {
    const h = harness();
    expectCode(() => h.session("a", { parentAgentId: "ghost" }), "UNAUTHORIZED");

    const parent = h.session("parent");
    const otherIssued = h.identity.enrollConnector(h.operator, {
      adapter: ADAPTER,
      hostInstanceId: "host-b",
    });
    const otherConnector = h.identity.resolveConnector(otherIssued.token) as HostConnectorPrincipal;
    expectCode(
      () =>
        h.identity.provision(
          otherConnector,
          {
            adapter: ADAPTER,
            hostInstanceId: "host-b",
            externalId: "child",
            providerSessionId: "p",
            hostEpoch: "e",
            leaseSeconds: 60,
            parentAgentId: parent.agentId,
          },
          "cross-host",
        ),
      "UNAUTHORIZED",
    );
    expectCode(() => h.session("self", { parentAgentId: "x" }), "UNAUTHORIZED");

    h.identity.revokeAccess(h.operator, { agentId: parent.agentId, reason: "test" });
    expectCode(() => h.session("late", { parentAgentId: parent.agentId }), "UNAUTHORIZED");
    expect(h.store.listAgents()).toHaveLength(1);
  });

  it("freezes parentage at first enrollment", () => {
    const h = harness();
    const parent = h.session("parent");
    const other = h.session("other");
    h.session("child", { parentAgentId: parent.agentId });
    expectCode(
      () => h.session("child", { parentAgentId: other.agentId, providerSessionId: "again" }),
      "AGENT_CONFLICT",
    );
    // Omitting the parent on a later enrollment keeps the recorded provenance.
    const again = h.session("child", { providerSessionId: "again2" });
    expect(
      h.identity.authorizeSchedule(h.caller(parent), parent.principalId, again.agentId).allowed,
    ).toBe(true);

    const orphan = h.session("orphan");
    expectCode(
      () => h.session("orphan", { parentAgentId: parent.agentId, providerSessionId: "graft" }),
      "AGENT_CONFLICT",
    );
    expect(
      h.identity.authorizeSchedule(h.caller(parent), parent.principalId, orphan.agentId).allowed,
    ).toBe(false);
  });
});

describe("durable schedule delivery authority", () => {
  it("survives token expiry and session turnover for a 30 minute timer", () => {
    const h = harness();
    const agent = h.session("agent");
    const decision = h.identity.authorizeSchedule(
      h.caller(agent),
      agent.principalId,
      agent.agentId,
    );
    if (!decision.allowed) throw new Error("expected allowed");
    expect(h.identity.canDeliverSchedule(agent.principalId, agent.agentId)).toBe(true);

    keepAlive(h, agent);
    h.tick(30 * 60);
    keepAlive(h, agent);
    expect(h.identity.canDeliverSchedule(agent.principalId, agent.agentId)).toBe(true);

    // Eight hours later the tool token is dead, but the durable grant is not.
    h.tick(8 * 3_600);
    expect(h.identity.resolveBearer(agent.token)).toBeNull();
    keepAlive(h, agent);
    expect(
      h.identity.canDeliverSchedule(agent.principalId, agent.agentId, {
        bindingId: agent.bindingId,
        agentId: agent.agentId,
        generation: agent.generation,
      }),
    ).toBe(true);
    expect(
      h.identity.explainScheduleDelivery(agent.principalId, agent.agentId, undefined, {
        grantId: decision.grantId,
        grantEpoch: decision.grantEpoch,
      }).allowed,
    ).toBe(true);
  });

  it("blocks future dispatch on explicit grant revoke and keeps it revoked across re-enrollment", () => {
    const h = harness();
    const parent = h.session("parent");
    const child = h.session("child", { parentAgentId: parent.agentId });
    expect(h.identity.canDeliverSchedule(parent.principalId, child.agentId)).toBe(true);

    h.identity.revokeScheduleGrant(h.operator, {
      ownerAgentId: parent.agentId,
      targetAgentId: child.agentId,
    });
    const blocked = h.identity.explainScheduleDelivery(parent.principalId, child.agentId);
    expect(blocked).toMatchObject({ allowed: false, retryable: false, reason: "grant_revoked" });
    expect(
      h.identity.authorizeSchedule(h.caller(parent), parent.principalId, child.agentId).allowed,
    ).toBe(false);

    // Trusted re-enrollment of the child renews its session but cannot undo the revoke.
    h.session("child", { parentAgentId: parent.agentId, providerSessionId: "provider-child-2" });
    expect(h.identity.canDeliverSchedule(parent.principalId, child.agentId)).toBe(false);

    // Only an explicit operator grant restores it, with a newer epoch.
    h.identity.grantScheduleTarget(h.operator, {
      ownerAgentId: parent.agentId,
      targetAgentId: child.agentId,
    });
    expect(h.identity.canDeliverSchedule(parent.principalId, child.agentId)).toBe(true);
  });

  it("invalidates a pinned authorization when the grant is revoked and re-granted", () => {
    const h = harness();
    const parent = h.session("parent");
    const child = h.session("child", { parentAgentId: parent.agentId });
    const decision = h.identity.authorizeSchedule(
      h.caller(parent),
      parent.principalId,
      child.agentId,
    );
    if (!decision.allowed) throw new Error("expected allowed");
    const pinned = { grantId: decision.grantId, grantEpoch: decision.grantEpoch };
    expect(
      h.identity.explainScheduleDelivery(parent.principalId, child.agentId, undefined, pinned)
        .allowed,
    ).toBe(true);

    h.identity.revokeScheduleGrant(h.operator, {
      ownerAgentId: parent.agentId,
      targetAgentId: child.agentId,
    });
    h.identity.grantScheduleTarget(h.operator, {
      ownerAgentId: parent.agentId,
      targetAgentId: child.agentId,
    });
    expect(h.identity.canDeliverSchedule(parent.principalId, child.agentId)).toBe(true);
    expect(
      h.identity.explainScheduleDelivery(parent.principalId, child.agentId, undefined, pinned),
    ).toMatchObject({ allowed: false, reason: "grant_epoch_changed", retryable: false });
  });

  it("blocks on agent retirement, owner retirement and explicit access revoke", () => {
    const h = harness();
    const parent = h.session("parent");
    const child = h.session("child", { parentAgentId: parent.agentId });

    h.store.database
      .prepare("UPDATE agents SET lifecycle = 'retired' WHERE agent_id = ?")
      .run(child.agentId);
    expect(h.identity.explainScheduleDelivery(parent.principalId, child.agentId)).toMatchObject({
      allowed: false,
      retryable: false,
      reason: "target_retired",
    });
    h.store.database
      .prepare("UPDATE agents SET lifecycle = 'active' WHERE agent_id = ?")
      .run(child.agentId);
    expect(h.identity.canDeliverSchedule(parent.principalId, child.agentId)).toBe(true);

    h.store.database
      .prepare("UPDATE agents SET lifecycle = 'retired' WHERE agent_id = ?")
      .run(parent.agentId);
    expect(h.identity.explainScheduleDelivery(parent.principalId, child.agentId).reason).toBe(
      "owner_retired",
    );
    h.store.database
      .prepare("UPDATE agents SET lifecycle = 'active' WHERE agent_id = ?")
      .run(parent.agentId);

    h.identity.revokeAccess(h.operator, { agentId: child.agentId, reason: "compromised" });
    expect(h.identity.explainScheduleDelivery(parent.principalId, child.agentId).reason).toBe(
      "target_access_revoked",
    );
    h.identity.restoreAccess(h.operator, { agentId: child.agentId });
    expect(h.identity.canDeliverSchedule(parent.principalId, child.agentId)).toBe(true);

    h.identity.revokeAccess(h.operator, { agentId: parent.agentId, reason: "compromised" });
    expect(h.identity.explainScheduleDelivery(parent.principalId, child.agentId).reason).toBe(
      "owner_access_revoked",
    );
    // The parent's revoked access also kills its self-timer.
    expect(h.identity.canDeliverSchedule(parent.principalId, parent.agentId)).toBe(false);
  });

  it("validates the target's host-session binding when one is supplied", () => {
    const h = harness();
    const agent = h.session("agent");
    const exact = {
      bindingId: agent.bindingId,
      agentId: agent.agentId,
      generation: agent.generation,
    };
    expect(h.identity.canDeliverSchedule(agent.principalId, agent.agentId, exact)).toBe(true);

    expect(
      h.identity.explainScheduleDelivery(agent.principalId, agent.agentId, {
        ...exact,
        generation: 2,
      }),
    ).toMatchObject({ allowed: false, retryable: false, reason: "binding_invalid" });
    expect(
      h.identity.explainScheduleDelivery(agent.principalId, agent.agentId, {
        ...exact,
        bindingId: "forged",
      }).reason,
    ).toBe("binding_invalid");
    const other = h.session("other");
    expect(
      h.identity.explainScheduleDelivery(agent.principalId, agent.agentId, {
        bindingId: other.bindingId,
        agentId: other.agentId,
        generation: other.generation,
      }).reason,
    ).toBe("binding_invalid");

    // Session replacement supersedes the old binding for good.
    const next = h.session("agent", { providerSessionId: "provider-agent-2" });
    expect(h.identity.explainScheduleDelivery(agent.principalId, agent.agentId, exact).reason).toBe(
      "binding_invalid",
    );
    expect(
      h.identity.canDeliverSchedule(agent.principalId, agent.agentId, {
        bindingId: next.bindingId,
        agentId: next.agentId,
        generation: next.generation,
      }),
    ).toBe(true);
  });

  it("holds work as retryable while the target is offline, then resumes after renewal", () => {
    const h = harness();
    const agent = h.session("agent");
    const binding = {
      bindingId: agent.bindingId,
      agentId: agent.agentId,
      generation: agent.generation,
    };
    h.identity.markOffline(
      h.connector,
      { hostSessionId: agent.hostSessionId, reason: "stopped" },
      "off",
    );
    expect(
      h.identity.explainScheduleDelivery(agent.principalId, agent.agentId, binding),
    ).toMatchObject({
      allowed: false,
      retryable: true,
      reason: "target_offline",
    });
    // Identity-level checks without a binding are unaffected by presence.
    expect(h.identity.canDeliverSchedule(agent.principalId, agent.agentId)).toBe(true);

    const renewed = h.session("agent", { providerSessionId: "provider-agent-2" });
    expect(
      h.identity.canDeliverSchedule(agent.principalId, agent.agentId, {
        bindingId: renewed.bindingId,
        agentId: renewed.agentId,
        generation: renewed.generation,
      }),
    ).toBe(true);

    // A lapsed lease is also offline-and-retryable.
    h.tick(61);
    expect(
      h.identity.explainScheduleDelivery(agent.principalId, agent.agentId, {
        bindingId: renewed.bindingId,
        agentId: renewed.agentId,
        generation: renewed.generation,
      }),
    ).toMatchObject({ allowed: false, retryable: true, reason: "target_offline" });
  });

  it("explicit connector revoke blocks the agent's own timers permanently", () => {
    const h = harness();
    const agent = h.session("agent");
    h.identity.revoke(
      h.connector,
      { hostSessionId: agent.hostSessionId, reason: "operator request" },
      "revoke",
    );
    expect(h.identity.explainScheduleDelivery(agent.principalId, agent.agentId)).toMatchObject({
      allowed: false,
      retryable: false,
    });
    // Operator restore re-grants only the baseline self grant.
    h.identity.restoreAccess(h.operator, { agentId: agent.agentId });
    h.session("agent", { providerSessionId: "provider-agent-2" });
    expect(h.identity.canDeliverSchedule(agent.principalId, agent.agentId)).toBe(true);
  });

  it("denies unknown owners but honors configured operator owners", () => {
    const h = harness(["operator:test"]);
    const target = h.session("target");
    expect(h.identity.explainScheduleDelivery("agent:ghost", target.agentId)).toMatchObject({
      allowed: false,
      reason: "owner_unknown",
    });
    expect(h.identity.canDeliverSchedule("operator:test", target.agentId)).toBe(true);
    h.identity.revokeAccess(h.operator, { agentId: target.agentId, reason: "x" });
    expect(h.identity.canDeliverSchedule("operator:test", target.agentId)).toBe(false);
    expect(h.identity.canDeliverSchedule("operator:test", "ghost")).toBe(false);
  });
});
