import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

import { SidebandError, type SidebandErrorCode } from "../core/errors.js";
import {
  validateIdentifier,
  type SchemaMigration,
  type SqliteSidebandStore,
} from "../store/sqlite.js";
import { deriveHostSessionId } from "./ids.js";

/**
 * Durable spawn intents.
 *
 * A spawn intent names the exact host tuple (adapter, hostInstanceId, externalId) a
 * Sideband-initiated spawn is expected to produce, the agent identity it is meant to become and
 * the provenance of the spawner. It is reserved BEFORE any host I/O so that later enrollment of
 * that tuple can be adopted instead of minting a second identity.
 *
 * Trust boundary: a reservation needs (1) a SpawnCaller minted by trusted server code from an
 * authenticated principal, and (2) a decision from the synchronous policy callback supplied at
 * attach time. There is no default policy. The callback is where the real identity service is
 * consulted; this module only proves the decision is genuine, is about this exact request, and
 * agrees with the identity derived from the caller. Request fields, model output and metadata
 * never grant anything.
 *
 * All methods run on the store's own SQLite connection, so they join a caller's open transaction
 * (a savepoint) and roll back with it. That lets a caller reserve an intent and claim a dispatch
 * in one transaction before touching the host.
 */

export type SpawnIntentStatus = "pending" | "adopted" | "abandoned";

export interface SpawnIntentTuple {
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
}

/** The authenticated spawner. Only trusted server code may mint one; never expose it to a model. */
export interface SpawnCaller {
  readonly kind: "spawn-caller";
  readonly principalId: string;
  /** The spawning agent, or null for an operator or service. Becomes the intent's parent. */
  readonly agentId: string | null;
}

export interface SpawnIntentRequest extends SpawnIntentTuple {
  readonly spawnOperationId: string;
  readonly intendedAgentId: string;
  /** Optional assertions by the requester. They are never trusted, only compared. */
  readonly declaredParentAgentId?: string | null;
  readonly declaredSpawnerPrincipalId?: string;
}

export interface SpawnAuthorizationGrant extends SpawnIntentTuple {
  readonly spawnerPrincipalId: string;
  readonly parentAgentId: string | null;
  readonly intendedAgentId: string;
}

export type SpawnAuthorizationDecision =
  | (SpawnAuthorizationGrant & { readonly allowed: true })
  | { readonly allowed: false; readonly reason: string };

export interface SpawnIntentPolicy {
  /** Must decide synchronously and fail closed. Build the result with allowSpawn or denySpawn. */
  authorize(caller: SpawnCaller, request: SpawnIntentRequest): SpawnAuthorizationDecision;
}

export interface SpawnIntentStoreOptions {
  readonly authorize: SpawnIntentPolicy["authorize"];
  readonly now?: () => string | Date;
}

export interface SpawnIntent extends SpawnIntentTuple {
  readonly spawnOperationId: string;
  readonly hostSessionId: string;
  readonly intendedAgentId: string;
  readonly parentAgentId: string | null;
  readonly spawnerPrincipalId: string;
  readonly status: SpawnIntentStatus;
  readonly statusReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly adoptedAt: string | null;
  readonly abandonedAt: string | null;
}

/** What an enrolling connector presents. The intended agent must match exactly. */
export interface SpawnIntentClaim extends SpawnIntentTuple {
  readonly agentId: string;
}

interface IntentRow {
  spawn_operation_id: string;
  host_session_id: string;
  adapter: string;
  host_instance_id: string;
  external_id: string;
  intended_agent_id: string;
  parent_agent_id: string | null;
  spawner_principal_id: string;
  status: SpawnIntentStatus;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
  adopted_at: string | null;
  abandoned_at: string | null;
}

/** Objects minted by this module. Plain JSON that merely looks like one is refused. */
const spawnCallers = new WeakSet<object>();
const spawnDecisions = new WeakSet<object>();

const REQUEST_KEYS = new Set([
  "spawnOperationId",
  "adapter",
  "hostInstanceId",
  "externalId",
  "intendedAgentId",
  "declaredParentAgentId",
  "declaredSpawnerPrincipalId",
]);
const CLAIM_KEYS = new Set(["adapter", "hostInstanceId", "externalId", "agentId"]);
const MAX_REASON_LENGTH = 512;

function fail(
  code: SidebandErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new SidebandError(code, message, details);
}

function denied(reason: string, message: string): never {
  return fail("UNAUTHORIZED", message, { reason });
}

export function createSpawnCaller(input: {
  readonly principalId: string;
  readonly agentId: string | null;
}): SpawnCaller {
  validateIdentifier(input.principalId, "principalId");
  if (input.agentId !== null) validateIdentifier(input.agentId, "agentId");
  const caller: SpawnCaller = Object.freeze({
    kind: "spawn-caller",
    principalId: input.principalId,
    agentId: input.agentId,
  });
  spawnCallers.add(caller);
  return caller;
}

export function allowSpawn(grant: SpawnAuthorizationGrant): SpawnAuthorizationDecision {
  const decision = Object.freeze({ ...grant, allowed: true as const });
  spawnDecisions.add(decision);
  return decision;
}

export function denySpawn(reason: string): SpawnAuthorizationDecision {
  const decision = Object.freeze({ allowed: false as const, reason });
  spawnDecisions.add(decision);
  return decision;
}

/** Migration 4. Applied by SpawnIntentStore.attach, never by core open. */
export function spawnIntentMigration(): SchemaMigration {
  return {
    version: 4,
    name: "spawn_intents",
    sql: readFileSync(new URL("../../migrations/0004_spawn_intents.sql", import.meta.url), "utf8"),
  };
}

function intentFromRow(row: IntentRow): SpawnIntent {
  return {
    spawnOperationId: row.spawn_operation_id,
    hostSessionId: row.host_session_id,
    adapter: row.adapter,
    hostInstanceId: row.host_instance_id,
    externalId: row.external_id,
    intendedAgentId: row.intended_agent_id,
    parentAgentId: row.parent_agent_id,
    spawnerPrincipalId: row.spawner_principal_id,
    status: row.status,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    adoptedAt: row.adopted_at,
    abandonedAt: row.abandoned_at,
  };
}

function requireCaller(caller: SpawnCaller): void {
  if (typeof caller !== "object" || caller === null || !spawnCallers.has(caller)) {
    denied("CALLER_NOT_TRUSTED", "A trusted spawn caller is required.");
  }
}

function assertKnownKeys(value: object, allowed: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_ARGUMENT", `Unknown ${name} field: ${key}.`);
  }
}

function validateTuple(input: SpawnIntentTuple): void {
  validateIdentifier(input.adapter, "adapter");
  validateIdentifier(input.hostInstanceId, "hostInstanceId");
  validateIdentifier(input.externalId, "externalId");
}

function validateRequest(request: SpawnIntentRequest): void {
  assertKnownKeys(request, REQUEST_KEYS, "spawn intent request");
  validateIdentifier(request.spawnOperationId, "spawnOperationId");
  validateTuple(request);
  validateIdentifier(request.intendedAgentId, "intendedAgentId");
  if (request.declaredParentAgentId !== undefined && request.declaredParentAgentId !== null) {
    validateIdentifier(request.declaredParentAgentId, "declaredParentAgentId");
  }
  if (request.declaredSpawnerPrincipalId !== undefined) {
    validateIdentifier(request.declaredSpawnerPrincipalId, "declaredSpawnerPrincipalId");
  }
}

function sameTuple(left: SpawnIntentTuple, right: SpawnIntentTuple): boolean {
  return (
    left.adapter === right.adapter &&
    left.hostInstanceId === right.hostInstanceId &&
    left.externalId === right.externalId
  );
}

export class SpawnIntentStore {
  private readonly db: Database.Database;

  private constructor(
    store: SqliteSidebandStore,
    private readonly authorize: SpawnIntentPolicy["authorize"],
    private readonly clock: () => string | Date,
  ) {
    this.db = store.database;
  }

  /**
   * Applies migration 4 through the store's ledger on its own connection. It refuses to run until
   * the identity schema (migration 3) exists, so ordering cannot be inverted.
   */
  static attach(store: SqliteSidebandStore, options: SpawnIntentStoreOptions): SpawnIntentStore {
    if (typeof options?.authorize !== "function") {
      fail("INVALID_ARGUMENT", "A spawn authorization policy callback is required.");
    }
    const identity = store.database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'identity_host_sessions'",
      )
      .get();
    if (!identity) {
      fail("MIGRATION_CONFLICT", "Spawn intents require the identity schema (migration 3) first.");
    }
    store.applyMigrations([spawnIntentMigration()]);
    return new SpawnIntentStore(store, options.authorize, options.now ?? (() => new Date()));
  }

  /**
   * Reserves the tuple for the request. Authorization runs first, on every call including replays,
   * and nothing is written unless the trusted policy allows exactly this request.
   */
  reserve(caller: SpawnCaller, request: SpawnIntentRequest): SpawnIntent {
    requireCaller(caller);
    validateRequest(request);
    return this.db
      .transaction(() => {
        this.authorizeRequest(caller, request);
        return this.reserveAuthorized(caller, request);
      })
      .immediate();
  }

  find(spawnOperationId: string): SpawnIntent | null {
    const row = this.db
      .prepare("SELECT * FROM identity_spawn_intents WHERE spawn_operation_id = ?")
      .get(spawnOperationId) as IntentRow | undefined;
    return row ? intentFromRow(row) : null;
  }

  findByTuple(tuple: SpawnIntentTuple): SpawnIntent | null {
    const row = this.tupleRow(tuple);
    return row ? intentFromRow(row) : null;
  }

  /**
   * Consumes the pending intent for an enrolling connector tuple, exactly once. Returns null when
   * the tuple was never reserved (not a Sideband spawn). Call it in the same transaction as the
   * session insert and BEFORE that insert: an existing managed session is never overwritten.
   */
  adopt(claim: SpawnIntentClaim): SpawnIntent | null {
    assertKnownKeys(claim, CLAIM_KEYS, "spawn intent claim");
    validateTuple(claim);
    validateIdentifier(claim.agentId, "agentId");
    return this.db
      .transaction(() => {
        const row = this.tupleRow(claim);
        if (!row) return null;
        if (row.intended_agent_id !== claim.agentId) {
          fail("AGENT_CONFLICT", "The spawn intent is for a different agent.", {
            spawnOperationId: row.spawn_operation_id,
          });
        }
        if (row.status !== "pending") {
          fail("AGENT_CONFLICT", `The spawn intent is already ${row.status}.`, {
            spawnOperationId: row.spawn_operation_id,
          });
        }
        if (this.hostSessionForTuple(claim)) {
          fail("AGENT_CONFLICT", "The tuple already has a managed host session.", {
            spawnOperationId: row.spawn_operation_id,
          });
        }
        const now = this.now();
        this.db
          .prepare(
            `UPDATE identity_spawn_intents
               SET status = 'adopted', adopted_at = ?, updated_at = ?
             WHERE spawn_operation_id = ? AND status = 'pending'`,
          )
          .run(now, now, row.spawn_operation_id);
        return this.requireIntent(row.spawn_operation_id);
      })
      .immediate();
  }

  /**
   * Gives up a pending intent after a DEFINITE host failure. Terminal: the tuple stays reserved
   * because the host may still have created it. An indeterminate outcome must stay pending.
   */
  abandon(caller: SpawnCaller, spawnOperationId: string, reason: string): SpawnIntent {
    requireCaller(caller);
    validateIdentifier(spawnOperationId, "spawnOperationId");
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      fail("INVALID_ARGUMENT", `reason must be 1-${MAX_REASON_LENGTH} characters.`);
    }
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare("SELECT * FROM identity_spawn_intents WHERE spawn_operation_id = ?")
          .get(spawnOperationId) as IntentRow | undefined;
        if (!row) fail("OPERATION_NOT_FOUND", `No spawn intent ${spawnOperationId}.`);
        if (row.spawner_principal_id !== caller.principalId) {
          denied("SPAWNER_MISMATCH", "Only the recorded spawner may abandon a spawn intent.");
        }
        if (row.status === "abandoned") return intentFromRow(row);
        if (row.status === "adopted") {
          fail("AGENT_CONFLICT", "An adopted spawn intent cannot be abandoned.", {
            spawnOperationId,
          });
        }
        const now = this.now();
        this.db
          .prepare(
            `UPDATE identity_spawn_intents
               SET status = 'abandoned', status_reason = ?, abandoned_at = ?, updated_at = ?
             WHERE spawn_operation_id = ? AND status = 'pending'`,
          )
          .run(reason, now, now, spawnOperationId);
        return this.requireIntent(spawnOperationId);
      })
      .immediate();
  }

  private authorizeRequest(caller: SpawnCaller, request: SpawnIntentRequest): void {
    if (
      request.declaredParentAgentId !== undefined &&
      request.declaredParentAgentId !== caller.agentId
    ) {
      denied("PARENT_MISMATCH", "Declared parent differs from the authenticated spawner.");
    }
    if (
      request.declaredSpawnerPrincipalId !== undefined &&
      request.declaredSpawnerPrincipalId !== caller.principalId
    ) {
      denied("SPAWNER_MISMATCH", "Declared spawner differs from the authenticated spawner.");
    }
    const decision = this.authorize(caller, Object.freeze({ ...request }));
    if (typeof decision !== "object" || decision === null || !spawnDecisions.has(decision)) {
      denied("DECISION_NOT_TRUSTED", "The spawn policy returned an untrusted decision.");
    }
    if (!decision.allowed) denied("SPAWN_DENIED", "The spawn policy denied this request.");
    if (
      decision.spawnerPrincipalId !== caller.principalId ||
      decision.parentAgentId !== caller.agentId ||
      decision.intendedAgentId !== request.intendedAgentId ||
      !sameTuple(decision, request)
    ) {
      denied("DECISION_MISMATCH", "The spawn decision does not match the request.");
    }
  }

  private reserveAuthorized(caller: SpawnCaller, request: SpawnIntentRequest): SpawnIntent {
    const existing = this.db
      .prepare("SELECT * FROM identity_spawn_intents WHERE spawn_operation_id = ?")
      .get(request.spawnOperationId) as IntentRow | undefined;
    if (existing) {
      if (
        existing.intended_agent_id !== request.intendedAgentId ||
        existing.spawner_principal_id !== caller.principalId ||
        existing.parent_agent_id !== caller.agentId ||
        existing.adapter !== request.adapter ||
        existing.host_instance_id !== request.hostInstanceId ||
        existing.external_id !== request.externalId
      ) {
        fail("IDEMPOTENCY_CONFLICT", "Spawn operation id reused with a different request.", {
          spawnOperationId: request.spawnOperationId,
        });
      }
      if (existing.status === "abandoned") {
        fail("AGENT_CONFLICT", "The spawn intent was abandoned; its tuple is not reusable.", {
          spawnOperationId: request.spawnOperationId,
        });
      }
      return intentFromRow(existing);
    }

    if (caller.agentId !== null) {
      const parent = this.db.prepare("SELECT 1 FROM agents WHERE agent_id = ?").get(caller.agentId);
      if (!parent) fail("AGENT_NOT_FOUND", `Spawning agent ${caller.agentId} is not registered.`);
    }
    if (this.tupleRow(request)) {
      fail("AGENT_CONFLICT", "The host tuple is already reserved by another spawn.");
    }
    if (this.hostSessionForTuple(request)) {
      fail("AGENT_CONFLICT", "The host tuple already has a managed host session.");
    }
    const agentBusy = this.db
      .prepare(
        `SELECT 1 FROM identity_host_sessions WHERE agent_id = ? AND adapter = ? AND host_instance_id = ?
         UNION ALL
         SELECT 1 FROM identity_spawn_intents
          WHERE intended_agent_id = ? AND adapter = ? AND host_instance_id = ? AND status = 'pending'`,
      )
      .get(
        request.intendedAgentId,
        request.adapter,
        request.hostInstanceId,
        request.intendedAgentId,
        request.adapter,
        request.hostInstanceId,
      );
    if (agentBusy) {
      fail("AGENT_CONFLICT", "The intended agent already has a session or spawn on this host.");
    }

    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO identity_spawn_intents (
           spawn_operation_id, host_session_id, adapter, host_instance_id, external_id,
           intended_agent_id, parent_agent_id, spawner_principal_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        request.spawnOperationId,
        deriveHostSessionId(request.adapter, request.hostInstanceId, request.externalId),
        request.adapter,
        request.hostInstanceId,
        request.externalId,
        request.intendedAgentId,
        caller.agentId,
        caller.principalId,
        now,
        now,
      );
    return this.requireIntent(request.spawnOperationId);
  }

  private tupleRow(tuple: SpawnIntentTuple): IntentRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM identity_spawn_intents
          WHERE adapter = ? AND host_instance_id = ? AND external_id = ?`,
      )
      .get(tuple.adapter, tuple.hostInstanceId, tuple.externalId) as IntentRow | undefined;
  }

  private hostSessionForTuple(tuple: SpawnIntentTuple): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM identity_host_sessions
            WHERE adapter = ? AND host_instance_id = ? AND external_id = ?`,
        )
        .get(tuple.adapter, tuple.hostInstanceId, tuple.externalId) !== undefined
    );
  }

  private requireIntent(spawnOperationId: string): SpawnIntent {
    const intent = this.find(spawnOperationId);
    if (!intent) fail("OPERATION_NOT_FOUND", `No spawn intent ${spawnOperationId}.`);
    return intent;
  }

  private now(): string {
    const value = this.clock();
    const date = typeof value === "string" ? new Date(value) : value;
    if (!Number.isFinite(date.getTime()))
      fail("INVALID_ARGUMENT", "Clock returned an invalid date.");
    return date.toISOString();
  }
}
