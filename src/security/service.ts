import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

import { SidebandError } from "../core/errors.js";
import type { SpawnIdentityCoordinator } from "../core/spawn-identity.js";
import {
  canonicalJson,
  validateIdentifier,
  validateText,
  type SchemaMigration,
  type SqliteSidebandStore,
} from "../store/sqlite.js";
import { CredentialAlreadyIssuedError, unauthorized } from "./errors.js";
import {
  AGENT_TOKEN_PREFIX,
  CONNECTOR_TOKEN_PREFIX,
  TOKEN_BYTES,
  deriveConnectorId,
  deriveHostAgentId,
  deriveHostSessionId,
  mintToken,
  principalIdForAgent,
  sha256Hex,
  type TokenBytes,
} from "./ids.js";
import {
  SpawnIntentStore,
  allowSpawn,
  createSpawnCaller,
  denySpawn,
  type SpawnAuthorizationDecision,
  type SpawnCaller,
  type SpawnIntent,
  type SpawnIntentRequest,
} from "./spawn-intents.js";
import {
  DEFAULT_AGENT_GRANTS,
  OPTIONAL_AGENT_GRANTS,
  type AgentGrant,
  type AuthenticatedAgent,
  type BindingReference,
  type HostConnectorPrincipal,
  type HostSessionRecord,
  type HostSessionRegistration,
  type IssuedAgentAccess,
  type IssuedConnectorCredential,
  type OperatorPrincipal,
  type PinnedScheduleAuthorization,
  type ScheduleAction,
  type ScheduleAuthorization,
  type ScheduleDeliveryDecision,
  type ScheduleDeliveryReason,
} from "./types.js";

const DEFAULT_CREDENTIAL_TTL_SECONDS = 8 * 3_600;
const DEFAULT_MAX_LEASE_SECONDS = 300;
const ENCODED_TOKEN_LENGTH = Math.ceil((TOKEN_BYTES * 4) / 3);

/** Objects minted by this module. Plain JSON that merely looks like a principal is refused. */
const operatorPrincipals = new WeakSet<object>();
const connectorCredentials = new WeakMap<object, string>();

/** Migration 3. Daemons ledger it explicitly so migration 4 can follow it on the same ledger. */
export function identityMigration(): SchemaMigration {
  return {
    version: 3,
    name: "identity",
    sql: readFileSync(new URL("../../migrations/0003_identity.sql", import.meta.url), "utf8"),
  };
}

export function createOperatorPrincipal(principalId: string): OperatorPrincipal {
  validateIdentifier(principalId, "principalId");
  const principal: OperatorPrincipal = Object.freeze({ kind: "operator", principalId });
  operatorPrincipals.add(principal);
  return principal;
}

export interface IdentityServiceOptions {
  readonly now?: () => string | Date;
  readonly tokenBytes?: TokenBytes;
  /** Upper bound of an agent tool token. Default 8 hours. */
  readonly credentialTtlSeconds?: number;
  /** Largest lease a connector may request per registration or heartbeat. Default 300. */
  readonly maxLeaseSeconds?: number;
  /** Narrow grants stamped on every agent credential. Default: DEFAULT_AGENT_GRANTS. */
  readonly grants?: readonly AgentGrant[];
  /** Principals whose schedules need no per-target grant (administrative callers). */
  readonly operatorPrincipalIds?: ReadonlySet<string>;
  /**
   * Opts into managed spawn coordination: ledgers migrations 3 then 4, attaches the spawn intent
   * store and exposes `spawnIdentity`. Off by default, which keeps unmanaged library behavior.
   */
  readonly spawnIntents?: boolean;
}

interface ConnectorRow {
  connector_id: string;
  principal_id: string;
  adapter: string;
  host_instance_id: string;
  token_hash: string;
  allowed_agent_ids_json: string;
  status: "active" | "revoked";
  expires_at: string | null;
}

interface PrincipalRow {
  principal_id: string;
  agent_id: string;
  access_state: "active" | "revoked";
  access_epoch: number;
}

interface SessionRow {
  host_session_id: string;
  connector_id: string;
  adapter: string;
  host_instance_id: string;
  external_id: string;
  agent_id: string;
  principal_id: string;
  parent_agent_id: string | null;
  provider_session_id: string;
  host_epoch: string;
  binding_id: string;
  generation: number;
  status: "active" | "offline";
  lease_expires_at: string;
}

interface CredentialRow {
  credential_id: string;
  principal_id: string;
  host_session_id: string;
  binding_id: string;
  generation: number;
  access_epoch: number;
  grants_json: string;
  expires_at: string;
}

interface GrantRow {
  grant_id: string;
  owner_principal_id: string;
  target_agent_id: string;
  kind: "self" | "child" | "explicit";
  epoch: number;
  revoked_at: string | null;
}

interface OperationRow {
  request_hash: string;
  host_session_id: string | null;
  credential_id: string | null;
}

interface BindingRow {
  binding_id: string;
  agent_id: string;
  generation: number;
  active: number;
  lease_expires_at: string | null;
}

interface LiveCredential {
  readonly credential: CredentialRow;
  readonly session: SessionRow;
}

function fail(code: ConstructorParameters<typeof SidebandError>[0], message: string): never {
  throw new SidebandError(code, message);
}

function sessionRecord(row: SessionRow, now: string): HostSessionRecord {
  return {
    hostSessionId: row.host_session_id,
    connectorId: row.connector_id,
    adapter: row.adapter,
    hostInstanceId: row.host_instance_id,
    externalId: row.external_id,
    agentId: row.agent_id,
    principalId: row.principal_id,
    parentAgentId: row.parent_agent_id,
    providerSessionId: row.provider_session_id,
    hostEpoch: row.host_epoch,
    bindingId: row.binding_id,
    generation: row.generation,
    status: row.status,
    leaseExpiresAt: row.lease_expires_at,
    online: row.status === "active" && row.lease_expires_at > now,
  };
}

function deliveryDecision(
  reason: ScheduleDeliveryReason,
  retryable = false,
): ScheduleDeliveryDecision {
  return { allowed: reason === "ok", reason, retryable };
}

export class IdentityService {
  private readonly db: Database.Database;
  private intents: SpawnIntentStore | null = null;

  private constructor(
    private readonly store: SqliteSidebandStore,
    private readonly options: {
      readonly now: () => string | Date;
      readonly tokenBytes: TokenBytes | undefined;
      readonly credentialTtlSeconds: number;
      readonly maxLeaseSeconds: number;
      readonly grants: readonly AgentGrant[];
      readonly operatorPrincipalIds: ReadonlySet<string>;
    },
  ) {
    this.db = store.database;
  }

  /** Applies the additive identity migration to the store's own connection. */
  static create(store: SqliteSidebandStore, options: IdentityServiceOptions = {}): IdentityService {
    const grants = options.grants ?? DEFAULT_AGENT_GRANTS;
    for (const grant of grants) {
      if (!DEFAULT_AGENT_GRANTS.includes(grant) && !OPTIONAL_AGENT_GRANTS.includes(grant)) {
        fail("INVALID_ARGUMENT", `Unsupported agent grant: ${grant}.`);
      }
    }
    const ttl = options.credentialTtlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS;
    const maxLease = options.maxLeaseSeconds ?? DEFAULT_MAX_LEASE_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 1) {
      fail("INVALID_ARGUMENT", "credentialTtlSeconds must be a positive integer.");
    }
    if (!Number.isInteger(maxLease) || maxLease < 1) {
      fail("INVALID_ARGUMENT", "maxLeaseSeconds must be a positive integer.");
    }
    // Managed spawn needs migration 3 on the ledger before 4 can follow it.
    if (options.spawnIntents === true) store.applyMigrations([identityMigration()]);
    store.database.exec(identityMigration().sql);
    const service = new IdentityService(store, {
      now: options.now ?? (() => new Date()),
      tokenBytes: options.tokenBytes,
      credentialTtlSeconds: ttl,
      maxLeaseSeconds: maxLease,
      grants: [...grants],
      operatorPrincipalIds: options.operatorPrincipalIds ?? new Set(),
    });
    if (options.spawnIntents === true) {
      service.intents = SpawnIntentStore.attach(store, {
        now: service.options.now,
        authorize: (caller, request) => service.authorizeSpawnIntent(caller, request),
      });
    }
    return service;
  }

  /** The managed spawn coordinator, or null when `spawnIntents` was not enabled. */
  get spawnIdentity(): SpawnIdentityCoordinator | null {
    const intents = this.intents;
    if (intents === null) return null;
    return {
      verifySpawner: (spawner) => {
        const caller = this.spawnCaller(spawner);
        return { principalId: caller.principalId, agentId: caller.agentId };
      },
      reserve: (spawner, reservation) => {
        intents.reserve(this.spawnCaller(spawner), {
          spawnOperationId: reservation.spawnOperationId,
          adapter: reservation.adapter,
          hostInstanceId: reservation.hostInstanceId,
          externalId: reservation.externalId,
          intendedAgentId: reservation.intendedAgentId,
        });
      },
      abandon: (spawnOperationId, reason) =>
        this.tx(() => {
          const intent = intents.find(spawnOperationId);
          if (!intent) fail("OPERATION_NOT_FOUND", `No spawn intent ${spawnOperationId}.`);
          if (intent.status === "adopted") return "adopted" as const;
          // The system settles its own operation: the recorded spawner is the only valid actor.
          const caller = createSpawnCaller({
            principalId: intent.spawnerPrincipalId,
            agentId: intent.parentAgentId,
          });
          intents.abandon(caller, spawnOperationId, reason.slice(0, 512) || "host failure");
          return "abandoned" as const;
        }),
      managedBindingId: (tuple, agentId) => {
        const session = this.sessionRow(
          deriveHostSessionId(tuple.adapter, tuple.hostInstanceId, tuple.externalId),
        );
        return session !== undefined && session.agent_id === agentId ? session.binding_id : null;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Operator management (never model-exposed)
  // ---------------------------------------------------------------------------

  enrollConnector(
    operator: OperatorPrincipal,
    input: {
      readonly adapter: string;
      readonly hostInstanceId: string;
      readonly allowedAgentIds?: readonly string[];
      readonly expiresAt?: string;
    },
  ): IssuedConnectorCredential {
    this.requireOperator(operator);
    validateIdentifier(input.adapter, "adapter");
    validateIdentifier(input.hostInstanceId, "hostInstanceId");
    const allowed = [...(input.allowedAgentIds ?? [])].map((id) =>
      validateIdentifier(id, "allowedAgentIds"),
    );
    const expiresAt = this.optionalTimestamp(input.expiresAt, "expiresAt");
    return this.tx(() => {
      const connectorId = deriveConnectorId(input.adapter, input.hostInstanceId);
      const existing = this.connectorRow(connectorId);
      if (existing) {
        throw new CredentialAlreadyIssuedError({
          connectorId,
          principalId: existing.principal_id,
          adapter: existing.adapter,
          hostInstanceId: existing.host_instance_id,
        });
      }
      const now = this.now();
      const token = mintToken(CONNECTOR_TOKEN_PREFIX, this.options.tokenBytes);
      const principalId = `connector:${connectorId}`;
      this.db
        .prepare(
          `INSERT INTO identity_connectors (
             connector_id, principal_id, adapter, host_instance_id, token_hash,
             allowed_agent_ids_json, status, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          connectorId,
          principalId,
          input.adapter,
          input.hostInstanceId,
          sha256Hex(token),
          canonicalJson(allowed),
          expiresAt,
          now,
          now,
        );
      this.event(
        operator.principalId,
        "identity.connector.enrolled",
        "connector",
        connectorId,
        now,
        {
          adapter: input.adapter,
          hostInstanceId: input.hostInstanceId,
          allowedAgentIds: allowed,
          expiresAt,
        },
      );
      return {
        connectorId,
        principalId,
        adapter: input.adapter,
        hostInstanceId: input.hostInstanceId,
        token,
        expiresAt,
      };
    });
  }

  rotateConnector(
    operator: OperatorPrincipal,
    input: {
      readonly adapter: string;
      readonly hostInstanceId: string;
      readonly rotationId: string;
    },
  ): IssuedConnectorCredential {
    this.requireOperator(operator);
    validateIdentifier(input.rotationId, "rotationId");
    return this.tx(() => {
      const connector = this.connectorByHost(input.adapter, input.hostInstanceId);
      if (!connector || connector.status !== "active") {
        unauthorized("CONNECTOR_INVALID", "Connector is unknown or revoked.");
      }
      const requestHash = sha256Hex(canonicalJson({ connectorId: connector.connector_id }));
      const prior = this.operation(connector.principal_id, "connector-rotate", input.rotationId);
      if (prior) {
        throw new CredentialAlreadyIssuedError({
          connectorId: connector.connector_id,
          principalId: connector.principal_id,
          adapter: connector.adapter,
          hostInstanceId: connector.host_instance_id,
        });
      }
      const now = this.now();
      const token = mintToken(CONNECTOR_TOKEN_PREFIX, this.options.tokenBytes);
      this.db
        .prepare(
          "UPDATE identity_connectors SET token_hash = ?, updated_at = ? WHERE connector_id = ?",
        )
        .run(sha256Hex(token), now, connector.connector_id);
      this.recordOperation(
        connector.principal_id,
        "connector-rotate",
        input.rotationId,
        requestHash,
        null,
        null,
        now,
      );
      this.event(
        operator.principalId,
        "identity.connector.rotated",
        "connector",
        connector.connector_id,
        now,
        { rotationId: input.rotationId },
      );
      return {
        connectorId: connector.connector_id,
        principalId: connector.principal_id,
        adapter: connector.adapter,
        hostInstanceId: connector.host_instance_id,
        token,
        expiresAt: connector.expires_at,
      };
    });
  }

  /** Revokes the connector and every session credential it provisioned. */
  revokeConnector(
    operator: OperatorPrincipal,
    input: { readonly adapter: string; readonly hostInstanceId: string; readonly reason: string },
  ): void {
    this.requireOperator(operator);
    validateText(input.reason, "reason", 512);
    this.tx(() => {
      const connector = this.connectorByHost(input.adapter, input.hostInstanceId);
      if (!connector || connector.status === "revoked") return;
      const now = this.now();
      this.db
        .prepare(
          `UPDATE identity_connectors
             SET status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ?
           WHERE connector_id = ?`,
        )
        .run(now, input.reason, now, connector.connector_id);
      const sessions = this.db
        .prepare("SELECT * FROM identity_host_sessions WHERE connector_id = ?")
        .all(connector.connector_id) as SessionRow[];
      for (const session of sessions) {
        this.takeSessionOffline(session, "connector_revoked", now);
      }
      this.event(
        operator.principalId,
        "identity.connector.revoked",
        "connector",
        connector.connector_id,
        now,
        { reason: input.reason },
      );
    });
  }

  /** Explicit access revocation: tokens, schedule grants, and sessions all stop. */
  revokeAccess(
    operator: OperatorPrincipal,
    input: { readonly agentId: string; readonly reason: string },
  ): void {
    this.requireOperator(operator);
    validateText(input.reason, "reason", 512);
    this.tx(() => {
      const principal = this.principalByAgent(input.agentId);
      if (!principal) fail("AGENT_NOT_FOUND", `No identity for agent ${input.agentId}.`);
      this.revokePrincipal(principal, input.reason, operator.principalId);
    });
  }

  /** Re-enables a revoked principal and its baseline self grant; other grants stay revoked. */
  restoreAccess(operator: OperatorPrincipal, input: { readonly agentId: string }): void {
    this.requireOperator(operator);
    this.tx(() => {
      const principal = this.principalByAgent(input.agentId);
      if (!principal) fail("AGENT_NOT_FOUND", `No identity for agent ${input.agentId}.`);
      if (principal.access_state === "active") return;
      const now = this.now();
      this.db
        .prepare(
          `UPDATE identity_principals
             SET access_state = 'active', access_epoch = access_epoch + 1,
                 revoked_at = NULL, revoke_reason = NULL, updated_at = ?
           WHERE principal_id = ?`,
        )
        .run(now, principal.principal_id);
      this.upsertGrant(
        principal.principal_id,
        principal.agent_id,
        "self",
        operator.principalId,
        now,
      );
      this.event(
        operator.principalId,
        "identity.access.restored",
        "agent",
        principal.agent_id,
        now,
        {
          principalId: principal.principal_id,
        },
      );
    });
  }

  grantScheduleTarget(
    operator: OperatorPrincipal,
    input: { readonly ownerAgentId: string; readonly targetAgentId: string },
  ): void {
    this.requireOperator(operator);
    this.tx(() => {
      const owner = this.principalByAgent(input.ownerAgentId);
      if (!owner) fail("AGENT_NOT_FOUND", `No identity for agent ${input.ownerAgentId}.`);
      if (owner.access_state !== "active") {
        unauthorized("ACCESS_REVOKED", "The owner's access is revoked.");
      }
      const target = this.store.getAgent(input.targetAgentId);
      if (target.lifecycle !== "active") fail("INVALID_ARGUMENT", "Target agent is retired.");
      const kind = owner.agent_id === target.agentId ? "self" : "explicit";
      this.upsertGrant(owner.principal_id, target.agentId, kind, operator.principalId, this.now());
    });
  }

  revokeScheduleGrant(
    operator: OperatorPrincipal,
    input: {
      readonly ownerAgentId: string;
      readonly targetAgentId: string;
      readonly reason?: string;
    },
  ): void {
    this.requireOperator(operator);
    this.tx(() => {
      const owner = this.principalByAgent(input.ownerAgentId);
      if (!owner) return;
      const now = this.now();
      const result = this.db
        .prepare(
          `UPDATE identity_schedule_grants
             SET revoked_at = ?, revoke_reason = ?, epoch = epoch + 1, updated_at = ?
           WHERE owner_principal_id = ? AND target_agent_id = ? AND revoked_at IS NULL`,
        )
        .run(now, input.reason ?? "operator", now, owner.principal_id, input.targetAgentId);
      if (result.changes > 0) {
        this.event(
          operator.principalId,
          "identity.schedule-grant.revoked",
          "agent",
          input.targetAgentId,
          now,
          { ownerPrincipalId: owner.principal_id },
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Connector surface
  // ---------------------------------------------------------------------------

  /** Authenticates a connector bearer. The returned principal is re-verified on every use. */
  resolveConnector(token: string): HostConnectorPrincipal | null {
    if (typeof token !== "string" || !this.looksLikeToken(token, CONNECTOR_TOKEN_PREFIX))
      return null;
    const tokenHash = sha256Hex(token);
    const row = this.db
      .prepare("SELECT * FROM identity_connectors WHERE token_hash = ?")
      .get(tokenHash) as ConnectorRow | undefined;
    if (!row || !this.connectorUsable(row)) return null;
    const principal: HostConnectorPrincipal = Object.freeze({
      kind: "connector",
      connectorId: row.connector_id,
      principalId: row.principal_id,
      adapter: row.adapter,
      hostInstanceId: row.host_instance_id,
    });
    connectorCredentials.set(principal, tokenHash);
    return principal;
  }

  provision(
    host: HostConnectorPrincipal,
    input: HostSessionRegistration,
    idempotencyKey: string,
  ): IssuedAgentAccess {
    validateIdentifier(idempotencyKey, "idempotencyKey");
    validateIdentifier(input.adapter, "adapter");
    validateIdentifier(input.hostInstanceId, "hostInstanceId");
    validateIdentifier(input.externalId, "externalId");
    validateIdentifier(input.providerSessionId, "providerSessionId");
    validateIdentifier(input.hostEpoch, "hostEpoch");
    if (input.requestedAgentId !== undefined) {
      validateIdentifier(input.requestedAgentId, "requestedAgentId");
    }
    if (input.parentAgentId !== undefined) validateIdentifier(input.parentAgentId, "parentAgentId");
    if (input.displayName !== undefined) validateText(input.displayName, "displayName", 512);
    const leaseSeconds = this.leaseSeconds(input.leaseSeconds);

    return this.tx(() => {
      const connector = this.requireConnector(host);
      if (
        input.adapter !== connector.adapter ||
        input.hostInstanceId !== connector.host_instance_id
      ) {
        unauthorized("CONNECTOR_SCOPE", "The registration is outside this connector's host.");
      }
      const requestHash = sha256Hex(
        canonicalJson({
          adapter: input.adapter,
          hostInstanceId: input.hostInstanceId,
          externalId: input.externalId,
          providerSessionId: input.providerSessionId,
          hostEpoch: input.hostEpoch,
          leaseSeconds,
          displayName: input.displayName ?? null,
          requestedAgentId: input.requestedAgentId ?? null,
          parentAgentId: input.parentAgentId ?? null,
        }),
      );
      const prior = this.operation(connector.principal_id, "provision", idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) {
          fail("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request.");
        }
        throw this.alreadyIssued(prior.host_session_id, prior.credential_id);
      }

      const hostSessionId = deriveHostSessionId(
        input.adapter,
        input.hostInstanceId,
        input.externalId,
      );
      const session = this.sessionRow(hostSessionId);
      const allowedAliases = JSON.parse(connector.allowed_agent_ids_json) as string[];

      let agentId: string;
      let aliased = false;
      // A tuple Sideband reserved at spawn time enrolls as the agent it was reserved for.
      const intent = session ? null : this.adoptSpawnIntent(input);
      if (session) {
        if (input.requestedAgentId !== undefined && input.requestedAgentId !== session.agent_id) {
          unauthorized("ALIAS_NOT_PERMITTED", "A host tuple maps to exactly one logical agent.");
        }
        agentId = session.agent_id;
      } else if (intent !== null) {
        agentId = intent.intendedAgentId;
      } else if (input.requestedAgentId !== undefined) {
        if (!allowedAliases.includes(input.requestedAgentId)) {
          unauthorized("ALIAS_NOT_PERMITTED", "This connector may not map that agent alias.");
        }
        agentId = input.requestedAgentId;
        aliased = true;
      } else {
        agentId = deriveHostAgentId(input.adapter, input.hostInstanceId, input.externalId);
      }

      const principalId = principalIdForAgent(agentId);
      const principal = this.principalByAgent(agentId);
      if (principal && principal.access_state === "revoked") {
        unauthorized("ACCESS_REVOKED", "Access for this agent was explicitly revoked.");
      }
      if (
        session &&
        session.status === "active" &&
        session.provider_session_id === input.providerSessionId &&
        session.host_epoch === input.hostEpoch
      ) {
        throw this.alreadyIssued(session.host_session_id, null);
      }

      if (!session) {
        const taken = this.db
          .prepare(
            `SELECT host_session_id FROM identity_host_sessions
             WHERE agent_id = ? AND adapter = ? AND host_instance_id = ?`,
          )
          .get(agentId, input.adapter, input.hostInstanceId);
        if (taken) fail("AGENT_CONFLICT", `Agent ${agentId} is already bound on this host.`);
      }

      let parentAgentId: string | null;
      if (session) {
        if (input.parentAgentId !== undefined && input.parentAgentId !== session.parent_agent_id) {
          fail("AGENT_CONFLICT", "Spawn provenance is fixed at first enrollment.");
        }
        parentAgentId = session.parent_agent_id;
      } else if (intent !== null) {
        parentAgentId = intent.parentAgentId;
      } else {
        parentAgentId = input.parentAgentId ?? null;
        if (parentAgentId !== null) this.verifyParent(connector, parentAgentId, agentId);
      }

      const now = this.now();
      const agentExists = this.agentExists(agentId);
      if (agentExists && !principal && !aliased && intent === null) {
        fail("AGENT_CONFLICT", `Agent ${agentId} exists without a host identity.`);
      }
      if (!agentExists) {
        this.store.registerAgent({
          agentId,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          actorPrincipalId: connector.principal_id,
        });
      }
      if (!principal) {
        this.db
          .prepare(
            `INSERT INTO identity_principals (
               principal_id, agent_id, access_state, access_epoch, created_at, updated_at
             ) VALUES (?, ?, 'active', 1, ?, ?)`,
          )
          .run(principalId, agentId, now, now);
      }
      this.insertGrantIfMissing(principalId, agentId, "self", connector.principal_id, now);
      if (!session && parentAgentId !== null) {
        this.insertGrantIfMissing(
          principalIdForAgent(parentAgentId),
          agentId,
          "child",
          connector.principal_id,
          now,
        );
      }
      if (session)
        this.revokeSessionCredentials(session.host_session_id, "generation_replaced", now);

      const leaseExpiresAt = this.addSeconds(now, leaseSeconds);
      const binding = this.store.bindManagedAgent({
        agentId,
        adapter: input.adapter,
        hostInstanceId: input.hostInstanceId,
        externalId: input.externalId,
        providerSessionId: input.providerSessionId,
        state: "running",
        active: true,
        metadata: { hostEpoch: input.hostEpoch, hostSessionId },
        leaseExpiresAt,
        actorPrincipalId: connector.principal_id,
      });
      if (session) {
        this.db
          .prepare(
            `UPDATE identity_host_sessions
               SET provider_session_id = ?, host_epoch = ?, binding_id = ?, generation = ?,
                   status = 'active', lease_expires_at = ?, offline_reason = NULL, updated_at = ?
             WHERE host_session_id = ?`,
          )
          .run(
            input.providerSessionId,
            input.hostEpoch,
            binding.bindingId,
            binding.generation,
            leaseExpiresAt,
            now,
            hostSessionId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO identity_host_sessions (
               host_session_id, connector_id, adapter, host_instance_id, external_id, agent_id,
               principal_id, parent_agent_id, provider_session_id, host_epoch, binding_id,
               generation, status, lease_expires_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(
            hostSessionId,
            connector.connector_id,
            input.adapter,
            input.hostInstanceId,
            input.externalId,
            agentId,
            principalId,
            parentAgentId,
            input.providerSessionId,
            input.hostEpoch,
            binding.bindingId,
            binding.generation,
            leaseExpiresAt,
            now,
            now,
          );
      }

      const issued = this.issueCredential({
        principalId,
        agentId,
        hostSessionId,
        bindingId: binding.bindingId,
        generation: binding.generation,
        leaseExpiresAt,
        now,
      });
      this.recordOperation(
        connector.principal_id,
        "provision",
        idempotencyKey,
        requestHash,
        hostSessionId,
        issued.credentialId,
        now,
      );
      this.event(connector.principal_id, "identity.session.provisioned", "agent", agentId, now, {
        principalId,
        hostSessionId,
        bindingId: binding.bindingId,
        generation: binding.generation,
        credentialId: issued.credentialId,
        replacedSession: session !== undefined,
        ...(intent === null ? {} : { spawnOperationId: intent.spawnOperationId }),
      });
      return issued;
    });
  }

  /** Mints a fresh credential for a live session; the previous one is revoked atomically. */
  rotate(
    host: HostConnectorPrincipal,
    input: {
      readonly hostSessionId: string;
      readonly hostEpoch: string;
      readonly rotationId: string;
    },
  ): IssuedAgentAccess {
    validateIdentifier(input.rotationId, "rotationId");
    return this.tx(() => {
      const connector = this.requireConnector(host);
      const session = this.ownedSession(connector, input.hostSessionId);
      const now = this.now();
      this.requireLiveSession(session, input.hostEpoch, now);
      const rotateHash = sha256Hex(canonicalJson({ hostSessionId: session.host_session_id }));
      const prior = this.operation(connector.principal_id, "rotate", input.rotationId);
      if (prior) {
        if (prior.request_hash !== rotateHash) {
          fail("IDEMPOTENCY_CONFLICT", "rotationId was used for a different session.");
        }
        throw this.alreadyIssued(session.host_session_id, prior.credential_id);
      }

      this.revokeSessionCredentials(session.host_session_id, "rotated", now);
      const issued = this.issueCredential({
        principalId: session.principal_id,
        agentId: session.agent_id,
        hostSessionId: session.host_session_id,
        bindingId: session.binding_id,
        generation: session.generation,
        leaseExpiresAt: session.lease_expires_at,
        now,
      });
      this.recordOperation(
        connector.principal_id,
        "rotate",
        input.rotationId,
        rotateHash,
        session.host_session_id,
        issued.credentialId,
        now,
      );
      this.event(
        connector.principal_id,
        "identity.credential.rotated",
        "agent",
        session.agent_id,
        now,
        {
          hostSessionId: session.host_session_id,
          credentialId: issued.credentialId,
          rotationId: input.rotationId,
        },
      );
      return issued;
    });
  }

  heartbeat(
    host: HostConnectorPrincipal,
    input: {
      readonly hostSessionId: string;
      readonly hostEpoch: string;
      readonly leaseSeconds: number;
    },
  ): { readonly leaseExpiresAt: string } {
    const leaseSeconds = this.leaseSeconds(input.leaseSeconds);
    return this.tx(() => {
      const connector = this.requireConnector(host);
      const session = this.ownedSession(connector, input.hostSessionId);
      const now = this.now();
      if (session.status !== "active") {
        unauthorized("SESSION_NOT_ACTIVE", "The host session is offline; re-enroll it.");
      }
      if (session.host_epoch !== input.hostEpoch) {
        unauthorized("HOST_EPOCH_MISMATCH", "The host epoch is not current for this session.");
      }
      const principal = this.principalByAgent(session.agent_id);
      if (!principal || principal.access_state !== "active") {
        unauthorized("ACCESS_REVOKED", "Access for this agent was explicitly revoked.");
      }
      const leaseExpiresAt = this.addSeconds(now, leaseSeconds);
      this.db
        .prepare(
          "UPDATE identity_host_sessions SET lease_expires_at = ?, updated_at = ? WHERE host_session_id = ?",
        )
        .run(leaseExpiresAt, now, session.host_session_id);
      this.db
        .prepare("UPDATE bindings SET lease_expires_at = ?, updated_at = ? WHERE binding_id = ?")
        .run(leaseExpiresAt, now, session.binding_id);
      this.db
        .prepare(
          "UPDATE presence SET last_seen_at = ?, last_signal = 'host-heartbeat' WHERE agent_id = ?",
        )
        .run(now, session.agent_id);
      return { leaseExpiresAt };
    });
  }

  /** Normal stop: tokens and the binding go, identity, grants and mailboxes stay. */
  markOffline(
    host: HostConnectorPrincipal,
    input: { readonly hostSessionId: string; readonly reason: string },
    idempotencyKey: string,
  ): void {
    validateIdentifier(idempotencyKey, "idempotencyKey");
    validateText(input.reason, "reason", 512);
    this.tx(() => {
      const connector = this.requireConnector(host);
      const session = this.ownedSession(connector, input.hostSessionId);
      const requestHash = sha256Hex(canonicalJson(input));
      const prior = this.operation(connector.principal_id, "offline", idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) {
          fail("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request.");
        }
        return;
      }
      const now = this.now();
      this.takeSessionOffline(session, input.reason, now);
      this.recordOperation(
        connector.principal_id,
        "offline",
        idempotencyKey,
        requestHash,
        session.host_session_id,
        null,
        now,
      );
      this.event(
        connector.principal_id,
        "identity.session.offline",
        "agent",
        session.agent_id,
        now,
        {
          hostSessionId: session.host_session_id,
          reason: input.reason,
        },
      );
    });
  }

  /** Explicit access revocation for the session's logical identity. */
  revoke(
    host: HostConnectorPrincipal,
    input: { readonly hostSessionId: string; readonly reason: string },
    idempotencyKey: string,
  ): void {
    validateIdentifier(idempotencyKey, "idempotencyKey");
    validateText(input.reason, "reason", 512);
    this.tx(() => {
      const connector = this.requireConnector(host);
      const session = this.ownedSession(connector, input.hostSessionId);
      const requestHash = sha256Hex(canonicalJson(input));
      const prior = this.operation(connector.principal_id, "revoke", idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) {
          fail("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request.");
        }
        return;
      }
      const principal = this.principalByAgent(session.agent_id);
      if (principal) this.revokePrincipal(principal, input.reason, connector.principal_id);
      this.recordOperation(
        connector.principal_id,
        "revoke",
        idempotencyKey,
        requestHash,
        session.host_session_id,
        null,
        this.now(),
      );
    });
  }

  getHostSession(
    adapter: string,
    hostInstanceId: string,
    externalId: string,
  ): HostSessionRecord | null {
    const row = this.sessionRow(deriveHostSessionId(adapter, hostInstanceId, externalId));
    return row ? sessionRecord(row, this.now()) : null;
  }

  /**
   * Trusted, server-side only: the connector's own live session under its current host epoch.
   * Re-verifies the connector credential (revocation and rotation both fail), session ownership,
   * liveness, the lease, logical access and the active binding. Never routed to other connectors.
   */
  requireConnectorLiveSession(
    host: HostConnectorPrincipal,
    hostSessionId: string,
    hostEpoch: string,
  ): HostSessionRecord {
    const connector = this.requireConnector(host);
    const session = this.ownedSession(connector, hostSessionId);
    const now = this.now();
    this.requireLiveSession(session, hostEpoch, now);
    const binding = this.db
      .prepare("SELECT * FROM bindings WHERE binding_id = ?")
      .get(session.binding_id) as BindingRow | undefined;
    if (!binding || binding.active !== 1 || binding.generation !== session.generation) {
      unauthorized("SESSION_NOT_ACTIVE", "The host session has no active binding.");
    }
    return sessionRecord(session, now);
  }

  // ---------------------------------------------------------------------------
  // Runtime surface
  // ---------------------------------------------------------------------------

  /**
   * Authenticates an agent bearer. Returns null for anything unknown, expired,
   * revoked, offline, superseded by a newer generation, or whose logical
   * identity lost access.
   */
  resolveBearer(token: string): AuthenticatedAgent | null {
    if (typeof token !== "string" || !this.looksLikeToken(token, AGENT_TOKEN_PREFIX)) return null;
    const credential = this.db
      .prepare("SELECT * FROM identity_credentials WHERE token_hash = ?")
      .get(sha256Hex(token)) as (CredentialRow & { revoked_at: string | null }) | undefined;
    if (!credential) return null;
    return this.authenticatedFromCredential(credential);
  }

  authorizeSchedule(
    actor: AuthenticatedAgent | OperatorPrincipal,
    ownerPrincipalId: string,
    targetAgentId: string,
    action: ScheduleAction = "create",
  ): ScheduleAuthorization {
    const deny = (reason: string): ScheduleAuthorization => ({ allowed: false, action, reason });
    if (actor.kind === "operator") {
      if (!operatorPrincipals.has(actor)) return deny("operator principal is not trusted");
      if (action === "create") {
        if (ownerPrincipalId !== actor.principalId)
          return deny("operator may only own its own schedules");
        const targetDenied = this.targetUnavailable(targetAgentId);
        if (targetDenied) return deny(targetDenied);
      }
      return {
        allowed: true,
        action,
        ownerPrincipalId,
        ownerAgentId: this.principalById(ownerPrincipalId)?.agent_id ?? null,
        targetAgentId,
        grantId: null,
        grantEpoch: 0,
      };
    }

    const verified = this.verifyAgentActor(actor);
    if (!verified) return deny("credential is not live");
    const needed: AgentGrant =
      action === "create"
        ? "schedules:create"
        : action === "cancel"
          ? "schedules:cancel"
          : "schedules:read";
    if (!actor.grants.has(needed) || !verified.grants.has(needed)) {
      return deny(`missing ${needed} grant`);
    }

    const owned = ownerPrincipalId === verified.principalId;
    if (action === "read" ? !owned && targetAgentId !== verified.agentId : !owned) {
      return deny(action === "read" ? "not the owner or target" : "not the owner");
    }

    const grant = this.grantRow(ownerPrincipalId, targetAgentId);
    if (action === "create") {
      const targetDenied = this.targetUnavailable(targetAgentId);
      if (targetDenied) return deny(targetDenied);
      if (!grant || grant.revoked_at !== null) return deny("no active schedule grant for target");
    }
    return {
      allowed: true,
      action,
      ownerPrincipalId,
      ownerAgentId: this.principalById(ownerPrincipalId)?.agent_id ?? null,
      targetAgentId,
      grantId: grant && grant.revoked_at === null ? grant.grant_id : null,
      grantEpoch: grant && grant.revoked_at === null ? grant.epoch : 0,
    };
  }

  /**
   * Durable delivery authority for a schedule. Deliberately ignores tool-token
   * expiry: only explicit revoke, retirement, an invalid binding, or an
   * offline target changes the answer.
   */
  explainScheduleDelivery(
    ownerPrincipalId: string,
    targetAgentId: string,
    binding?: BindingReference,
    pinned?: PinnedScheduleAuthorization,
  ): ScheduleDeliveryDecision {
    const operatorOwner = this.options.operatorPrincipalIds.has(ownerPrincipalId);
    if (!operatorOwner) {
      const owner = this.principalById(ownerPrincipalId);
      if (!owner) return deliveryDecision("owner_unknown");
      if (this.agentLifecycle(owner.agent_id) !== "active")
        return deliveryDecision("owner_retired");
      if (owner.access_state !== "active") return deliveryDecision("owner_access_revoked");
    }

    const lifecycle = this.agentLifecycle(targetAgentId);
    if (lifecycle === null) return deliveryDecision("target_unknown");
    if (lifecycle !== "active") return deliveryDecision("target_retired");
    const targetPrincipal = this.principalByAgent(targetAgentId);
    if (targetPrincipal && targetPrincipal.access_state !== "active") {
      return deliveryDecision("target_access_revoked");
    }

    if (!operatorOwner) {
      const grant = this.grantRow(ownerPrincipalId, targetAgentId);
      if (!grant) return deliveryDecision("grant_missing");
      if (grant.revoked_at !== null) return deliveryDecision("grant_revoked");
      if (
        pinned &&
        pinned.grantId !== null &&
        (pinned.grantId !== grant.grant_id || pinned.grantEpoch !== grant.epoch)
      ) {
        return deliveryDecision("grant_epoch_changed");
      }
    }

    if (binding) return this.checkBinding(targetAgentId, binding);
    return deliveryDecision("ok");
  }

  canDeliverSchedule(
    ownerPrincipalId: string,
    targetAgentId: string,
    binding?: BindingReference,
    pinned?: PinnedScheduleAuthorization,
  ): boolean {
    return this.explainScheduleDelivery(ownerPrincipalId, targetAgentId, binding, pinned).allowed;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private checkBinding(
    targetAgentId: string,
    reference: BindingReference,
  ): ScheduleDeliveryDecision {
    const now = this.now();
    const row = this.db
      .prepare("SELECT * FROM bindings WHERE binding_id = ?")
      .get(reference.bindingId) as BindingRow | undefined;
    if (!row || row.agent_id !== targetAgentId || row.generation !== reference.generation) {
      return deliveryDecision("binding_invalid");
    }
    const session = this.db
      .prepare(
        `SELECT s.* FROM identity_host_sessions s
         JOIN bindings b ON b.adapter = s.adapter AND b.host_instance_id = s.host_instance_id
         WHERE s.agent_id = ? AND b.binding_id = ?`,
      )
      .get(targetAgentId, row.binding_id) as SessionRow | undefined;
    if (session) {
      if (session.binding_id !== row.binding_id || session.generation !== row.generation) {
        return deliveryDecision("binding_invalid");
      }
      if (session.status !== "active" || session.lease_expires_at <= now) {
        return deliveryDecision("target_offline", true);
      }
      return row.active === 1 ? deliveryDecision("ok") : deliveryDecision("binding_invalid");
    }
    if (row.active !== 1) return deliveryDecision("binding_invalid");
    if (row.lease_expires_at !== null && row.lease_expires_at <= now) {
      return deliveryDecision("target_offline", true);
    }
    return deliveryDecision("ok");
  }

  private authenticatedFromCredential(
    credential: CredentialRow & { revoked_at: string | null },
  ): AuthenticatedAgent | null {
    const live = this.liveCredential(credential);
    if (!live) return null;
    const { session } = live;
    const binding = this.db
      .prepare("SELECT adapter, host_instance_id, external_id FROM bindings WHERE binding_id = ?")
      .get(session.binding_id) as
      | { adapter: string; host_instance_id: string; external_id: string }
      | undefined;
    if (!binding) return null;
    const stored = JSON.parse(credential.grants_json) as AgentGrant[];
    return {
      kind: "agent",
      principalId: credential.principal_id,
      agentId: session.agent_id,
      credentialId: credential.credential_id,
      hostSessionId: session.host_session_id,
      bindingId: session.binding_id,
      generation: session.generation,
      adapter: binding.adapter,
      hostInstanceId: binding.host_instance_id,
      externalId: binding.external_id,
      grants: new Set(stored),
      accessEpoch: credential.access_epoch,
      expiresAt: credential.expires_at,
      leaseExpiresAt: session.lease_expires_at,
    };
  }

  private liveCredential(
    credential: CredentialRow & { revoked_at: string | null },
  ): LiveCredential | null {
    const now = this.now();
    if (credential.revoked_at !== null || credential.expires_at <= now) return null;
    const principal = this.principalById(credential.principal_id);
    if (
      !principal ||
      principal.access_state !== "active" ||
      principal.access_epoch !== credential.access_epoch ||
      this.agentLifecycle(principal.agent_id) !== "active"
    ) {
      return null;
    }
    const session = this.sessionRow(credential.host_session_id);
    if (
      !session ||
      session.status !== "active" ||
      session.lease_expires_at <= now ||
      session.binding_id !== credential.binding_id ||
      session.generation !== credential.generation
    ) {
      return null;
    }
    const binding = this.db
      .prepare("SELECT active FROM bindings WHERE binding_id = ?")
      .get(session.binding_id) as { active: number } | undefined;
    if (!binding || binding.active !== 1) return null;
    return { credential, session };
  }

  /** Re-checks an actor object against the database so copied or forged objects gain nothing. */
  private verifyAgentActor(actor: AuthenticatedAgent): AuthenticatedAgent | null {
    if (actor.kind !== "agent" || typeof actor.credentialId !== "string") return null;
    const credential = this.db
      .prepare("SELECT * FROM identity_credentials WHERE credential_id = ?")
      .get(actor.credentialId) as (CredentialRow & { revoked_at: string | null }) | undefined;
    if (!credential) return null;
    const live = this.authenticatedFromCredential(credential);
    if (
      !live ||
      live.principalId !== actor.principalId ||
      live.agentId !== actor.agentId ||
      live.hostSessionId !== actor.hostSessionId ||
      live.bindingId !== actor.bindingId ||
      live.generation !== actor.generation
    ) {
      return null;
    }
    return live;
  }

  private issueCredential(input: {
    principalId: string;
    agentId: string;
    hostSessionId: string;
    bindingId: string;
    generation: number;
    leaseExpiresAt: string;
    now: string;
  }): IssuedAgentAccess {
    const principal = this.principalById(input.principalId);
    if (!principal) fail("AGENT_NOT_FOUND", "Principal vanished during issuance.");
    const token = mintToken(AGENT_TOKEN_PREFIX, this.options.tokenBytes);
    const credentialId = `cred_${randomUUID()}`;
    const expiresAt = this.addSeconds(input.now, this.options.credentialTtlSeconds);
    this.db
      .prepare(
        `INSERT INTO identity_credentials (
           credential_id, principal_id, host_session_id, binding_id, generation, access_epoch,
           token_hash, grants_json, issued_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credentialId,
        input.principalId,
        input.hostSessionId,
        input.bindingId,
        input.generation,
        principal.access_epoch,
        sha256Hex(token),
        canonicalJson([...this.options.grants].sort()),
        input.now,
        expiresAt,
      );
    return {
      principalId: input.principalId,
      agentId: input.agentId,
      hostSessionId: input.hostSessionId,
      bindingId: input.bindingId,
      generation: input.generation,
      credentialId,
      token,
      expiresAt,
      leaseExpiresAt: input.leaseExpiresAt,
    };
  }

  private revokeSessionCredentials(hostSessionId: string, reason: string, now: string): void {
    this.db
      .prepare(
        `UPDATE identity_credentials SET revoked_at = ?, revoke_reason = ?
         WHERE host_session_id = ? AND revoked_at IS NULL`,
      )
      .run(now, reason, hostSessionId);
  }

  private takeSessionOffline(session: SessionRow, reason: string, now: string): void {
    this.revokeSessionCredentials(session.host_session_id, reason, now);
    this.db
      .prepare(
        `UPDATE identity_host_sessions
           SET status = 'offline', offline_reason = ?, updated_at = ?
         WHERE host_session_id = ?`,
      )
      .run(reason, now, session.host_session_id);
    this.db
      .prepare(
        "UPDATE bindings SET active = 0, state = 'stopped', updated_at = ? WHERE binding_id = ?",
      )
      .run(now, session.binding_id);
  }

  private revokePrincipal(principal: PrincipalRow, reason: string, actorPrincipalId: string): void {
    if (principal.access_state === "revoked") return;
    const now = this.now();
    this.db
      .prepare(
        `UPDATE identity_principals
           SET access_state = 'revoked', access_epoch = access_epoch + 1,
               revoked_at = ?, revoke_reason = ?, updated_at = ?
         WHERE principal_id = ?`,
      )
      .run(now, reason, now, principal.principal_id);
    this.db
      .prepare(
        `UPDATE identity_credentials SET revoked_at = ?, revoke_reason = ?
         WHERE principal_id = ? AND revoked_at IS NULL`,
      )
      .run(now, "access_revoked", principal.principal_id);
    this.db
      .prepare(
        `UPDATE identity_schedule_grants
           SET revoked_at = ?, revoke_reason = ?, epoch = epoch + 1, updated_at = ?
         WHERE owner_principal_id = ? AND revoked_at IS NULL`,
      )
      .run(now, "access_revoked", now, principal.principal_id);
    const sessions = this.db
      .prepare("SELECT * FROM identity_host_sessions WHERE principal_id = ?")
      .all(principal.principal_id) as SessionRow[];
    for (const session of sessions) this.takeSessionOffline(session, "access_revoked", now);
    this.event(actorPrincipalId, "identity.access.revoked", "agent", principal.agent_id, now, {
      principalId: principal.principal_id,
      reason,
    });
  }

  /**
   * Consumes the pending spawn intent for an enrolling tuple, in the enrollment transaction and
   * before the session insert. Null when Sideband never reserved the tuple.
   */
  private adoptSpawnIntent(input: HostSessionRegistration): SpawnIntent | null {
    // Without spawnIntents the service is unmanaged: tuples enroll exactly as they always did.
    if (this.intents === null) return null;
    const reserved = this.intents.findByTuple(input);
    if (reserved === null) return null;
    if (
      input.requestedAgentId !== undefined &&
      input.requestedAgentId !== reserved.intendedAgentId
    ) {
      unauthorized("ALIAS_NOT_PERMITTED", "A host tuple maps to exactly one logical agent.");
    }
    if (input.parentAgentId !== undefined && input.parentAgentId !== reserved.parentAgentId) {
      fail("AGENT_CONFLICT", "Spawn provenance is fixed by the spawn intent.");
    }
    return this.intents.adopt({
      adapter: input.adapter,
      hostInstanceId: input.hostInstanceId,
      externalId: input.externalId,
      agentId: reserved.intendedAgentId,
    });
  }

  /**
   * Turns a trusted spawner handle into the SpawnCaller the intent store requires. Only an
   * operator principal issued by this service, or a live agent credential that carries the
   * explicit agents:spawn grant, qualifies. Request fields and copied objects never do.
   */
  private spawnCaller(spawner: unknown): SpawnCaller {
    if (typeof spawner !== "object" || spawner === null) {
      unauthorized("SPAWNER_NOT_VERIFIED", "A trusted spawner is required.");
    }
    if (operatorPrincipals.has(spawner)) {
      const operator = spawner as OperatorPrincipal;
      if (!this.options.operatorPrincipalIds.has(operator.principalId)) {
        unauthorized("SPAWN_NOT_PERMITTED", "This operator is not configured to spawn agents.");
      }
      return createSpawnCaller({ principalId: operator.principalId, agentId: null });
    }
    if ((spawner as { kind?: unknown }).kind === "agent") {
      const verified = this.verifyAgentActor(spawner as AuthenticatedAgent);
      if (verified === null) {
        unauthorized("SPAWNER_NOT_VERIFIED", "The spawning agent credential is not live.");
      }
      if (!verified.grants.has("agents:spawn")) {
        unauthorized("SPAWN_NOT_PERMITTED", "This agent credential may not spawn agents.");
      }
      return createSpawnCaller({ principalId: verified.principalId, agentId: verified.agentId });
    }
    return unauthorized("SPAWNER_NOT_VERIFIED", "The spawner was not issued by this service.");
  }

  /** The spawn policy: runs inside the reservation transaction, so state cannot change under it. */
  private authorizeSpawnIntent(
    caller: SpawnCaller,
    request: SpawnIntentRequest,
  ): SpawnAuthorizationDecision {
    if (caller.agentId === null) {
      if (!this.options.operatorPrincipalIds.has(caller.principalId)) {
        return denySpawn("The caller is not a configured operator.");
      }
    } else {
      const principal = this.principalByAgent(caller.agentId);
      if (
        !principal ||
        principal.principal_id !== caller.principalId ||
        principal.access_state !== "active" ||
        this.agentLifecycle(caller.agentId) !== "active"
      ) {
        return denySpawn("The spawning agent has no live access.");
      }
      if (request.intendedAgentId === caller.agentId) {
        return denySpawn("An agent cannot spawn itself.");
      }
      // Agent spawners mint brand-new identities only; an existing one needs an operator.
      if (this.principalByAgent(request.intendedAgentId)) {
        return denySpawn("The intended agent already has an identity.");
      }
    }
    const target = this.principalByAgent(request.intendedAgentId);
    if (target && target.access_state !== "active") {
      return denySpawn("Access for the intended agent was revoked.");
    }
    return allowSpawn({
      spawnerPrincipalId: caller.principalId,
      parentAgentId: caller.agentId,
      adapter: request.adapter,
      hostInstanceId: request.hostInstanceId,
      externalId: request.externalId,
      intendedAgentId: request.intendedAgentId,
    });
  }

  private verifyParent(connector: ConnectorRow, parentAgentId: string, childAgentId: string): void {
    const fail_ = (): never =>
      unauthorized("PARENT_NOT_VERIFIED", "The parent has no live session on this host.");
    if (parentAgentId === childAgentId) fail_();
    const principal = this.principalByAgent(parentAgentId);
    if (
      !principal ||
      principal.access_state !== "active" ||
      this.agentLifecycle(parentAgentId) !== "active"
    ) {
      fail_();
    }
    const session = this.db
      .prepare(
        `SELECT 1 AS ok FROM identity_host_sessions
         WHERE agent_id = ? AND adapter = ? AND host_instance_id = ? AND status = 'active'`,
      )
      .get(parentAgentId, connector.adapter, connector.host_instance_id);
    if (!session) fail_();
  }

  private insertGrantIfMissing(
    ownerPrincipalId: string,
    targetAgentId: string,
    kind: GrantRow["kind"],
    createdBy: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO identity_schedule_grants (
           grant_id, owner_principal_id, target_agent_id, kind, epoch, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(`sgr_${randomUUID()}`, ownerPrincipalId, targetAgentId, kind, createdBy, now, now);
  }

  private upsertGrant(
    ownerPrincipalId: string,
    targetAgentId: string,
    kind: GrantRow["kind"],
    createdBy: string,
    now: string,
  ): void {
    this.insertGrantIfMissing(ownerPrincipalId, targetAgentId, kind, createdBy, now);
    this.db
      .prepare(
        `UPDATE identity_schedule_grants
           SET revoked_at = NULL, revoke_reason = NULL, epoch = epoch + 1, updated_at = ?
         WHERE owner_principal_id = ? AND target_agent_id = ? AND revoked_at IS NOT NULL`,
      )
      .run(now, ownerPrincipalId, targetAgentId);
  }

  private targetUnavailable(targetAgentId: string): string | null {
    const lifecycle = this.agentLifecycle(targetAgentId);
    if (lifecycle === null) return "target agent is not registered";
    if (lifecycle !== "active") return "target agent is retired";
    const principal = this.principalByAgent(targetAgentId);
    if (principal && principal.access_state !== "active") return "target access is revoked";
    return null;
  }

  private requireLiveSession(session: SessionRow, hostEpoch: string, now: string): void {
    if (session.status !== "active") {
      unauthorized("SESSION_NOT_ACTIVE", "The host session is offline; re-enroll it.");
    }
    if (session.host_epoch !== hostEpoch) {
      unauthorized("HOST_EPOCH_MISMATCH", "The host epoch is not current for this session.");
    }
    if (session.lease_expires_at <= now) {
      unauthorized("LEASE_EXPIRED", "The session lease lapsed; send a heartbeat first.");
    }
    const principal = this.principalByAgent(session.agent_id);
    if (!principal || principal.access_state !== "active") {
      unauthorized("ACCESS_REVOKED", "Access for this agent was explicitly revoked.");
    }
  }

  private requireOperator(operator: OperatorPrincipal): void {
    if (typeof operator !== "object" || operator === null || !operatorPrincipals.has(operator)) {
      unauthorized("OPERATOR_REQUIRED", "This operation requires a trusted operator principal.");
    }
  }

  private requireConnector(host: HostConnectorPrincipal): ConnectorRow {
    const issuedHash =
      typeof host === "object" && host !== null ? connectorCredentials.get(host) : undefined;
    if (issuedHash === undefined) {
      unauthorized("CONNECTOR_INVALID", "Connector principal was not issued by this service.");
    }
    const row = this.connectorRow(host.connectorId);
    if (!row || row.token_hash !== issuedHash || !this.connectorUsable(row)) {
      unauthorized("CONNECTOR_INVALID", "Connector credential is no longer valid.");
    }
    return row;
  }

  private connectorUsable(row: ConnectorRow): boolean {
    return row.status === "active" && (row.expires_at === null || row.expires_at > this.now());
  }

  private ownedSession(connector: ConnectorRow, hostSessionId: string): SessionRow {
    const session = this.sessionRow(hostSessionId);
    if (
      !session ||
      session.adapter !== connector.adapter ||
      session.host_instance_id !== connector.host_instance_id
    ) {
      unauthorized("SESSION_NOT_OWNED", "The host session is unknown to this connector.");
    }
    return session;
  }

  private alreadyIssued(hostSessionId: string | null, credentialId: string | null): SidebandError {
    const session = hostSessionId ? this.sessionRow(hostSessionId) : undefined;
    return new CredentialAlreadyIssuedError({
      hostSessionId,
      credentialId,
      ...(session
        ? {
            agentId: session.agent_id,
            principalId: session.principal_id,
            bindingId: session.binding_id,
            generation: session.generation,
          }
        : {}),
    });
  }

  private connectorRow(connectorId: string): ConnectorRow | undefined {
    return this.db
      .prepare("SELECT * FROM identity_connectors WHERE connector_id = ?")
      .get(connectorId) as ConnectorRow | undefined;
  }

  private connectorByHost(adapter: string, hostInstanceId: string): ConnectorRow | undefined {
    return this.connectorRow(deriveConnectorId(adapter, hostInstanceId));
  }

  private principalById(principalId: string): PrincipalRow | undefined {
    return this.db
      .prepare("SELECT * FROM identity_principals WHERE principal_id = ?")
      .get(principalId) as PrincipalRow | undefined;
  }

  private principalByAgent(agentId: string): PrincipalRow | undefined {
    return this.db.prepare("SELECT * FROM identity_principals WHERE agent_id = ?").get(agentId) as
      | PrincipalRow
      | undefined;
  }

  private sessionRow(hostSessionId: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM identity_host_sessions WHERE host_session_id = ?")
      .get(hostSessionId) as SessionRow | undefined;
  }

  private grantRow(ownerPrincipalId: string, targetAgentId: string): GrantRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM identity_schedule_grants WHERE owner_principal_id = ? AND target_agent_id = ?",
      )
      .get(ownerPrincipalId, targetAgentId) as GrantRow | undefined;
  }

  private agentLifecycle(agentId: string): "active" | "retired" | null {
    const row = this.db.prepare("SELECT lifecycle FROM agents WHERE agent_id = ?").get(agentId) as
      | { lifecycle: "active" | "retired" }
      | undefined;
    return row?.lifecycle ?? null;
  }

  private agentExists(agentId: string): boolean {
    return this.agentLifecycle(agentId) !== null;
  }

  private operation(
    principalId: string,
    kind: string,
    idempotencyKey: string,
  ): OperationRow | undefined {
    return this.db
      .prepare(
        `SELECT request_hash, host_session_id, credential_id FROM identity_operations
         WHERE principal_id = ? AND kind = ? AND idempotency_key = ?`,
      )
      .get(principalId, kind, idempotencyKey) as OperationRow | undefined;
  }

  private recordOperation(
    principalId: string,
    kind: string,
    idempotencyKey: string,
    requestHash: string,
    hostSessionId: string | null,
    credentialId: string | null,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO identity_operations (
           principal_id, kind, idempotency_key, request_hash, host_session_id, credential_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(principalId, kind, idempotencyKey, requestHash, hostSessionId, credentialId, now);
  }

  private event(
    actorPrincipalId: string,
    type: string,
    entityType: string,
    entityId: string,
    occurredAt: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (
           event_id, schema_version, type, entity_type, entity_id,
           actor_principal_id, correlation_id, causation_id, payload_json, occurred_at
         ) VALUES (?, 1, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        randomUUID(),
        type,
        entityType,
        entityId,
        actorPrincipalId,
        canonicalJson(payload),
        occurredAt,
      );
  }

  private looksLikeToken(token: string, prefix: string): boolean {
    return token.length === prefix.length + ENCODED_TOKEN_LENGTH && token.startsWith(prefix);
  }

  private leaseSeconds(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > this.options.maxLeaseSeconds) {
      fail(
        "INVALID_ARGUMENT",
        `leaseSeconds must be an integer from 1 to ${this.options.maxLeaseSeconds}.`,
      );
    }
    return value;
  }

  private optionalTimestamp(value: string | undefined, name: string): string | null {
    if (value === undefined) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) fail("INVALID_ARGUMENT", `${name} must be a timestamp.`);
    return date.toISOString();
  }

  private addSeconds(timestamp: string, seconds: number): string {
    return new Date(new Date(timestamp).getTime() + seconds * 1_000).toISOString();
  }

  private now(): string {
    const value = this.options.now();
    const date = typeof value === "string" ? new Date(value) : value;
    if (!Number.isFinite(date.getTime()))
      fail("INVALID_ARGUMENT", "Clock returned an invalid date.");
    return date.toISOString();
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
