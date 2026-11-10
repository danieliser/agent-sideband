import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { SidebandError } from "../core/errors.js";
import type { SqliteSidebandStore } from "../store/sqlite.js";
import { canonicalJson, coreMigrations } from "../store/sqlite.js";
import { CRON_GRACE_MS, nextSlotAfter, toIso, type NormalizedTrigger } from "./triggers.js";

/**
 * Registered sender for schedules with no owning agent (operator-owned). The real owner stays in
 * the message provenance and schedule metadata; the target is never used as the sender.
 */
export const SCHEDULER_SENDER_AGENT_ID = "system-scheduler";
const SCHEDULER_SENDER_DISPLAY_NAME = "System scheduler";

/** suspended: a dispatch authorization was permanently denied; nothing further fires. */
export type ScheduleStatus = "active" | "completed" | "cancelled" | "blocked" | "suspended";
export type DeliveryMode = "wake" | "context" | "both";
export type OccurrenceState =
  | "queued"
  | "dispatching"
  | "host_accepted"
  | "host_adopted"
  | "observed"
  | "blocked"
  | "indeterminate"
  | "cancelled"
  | "failed";

export interface ScheduleRecord {
  readonly scheduleId: string;
  readonly ownerPrincipalId: string;
  /** Null for operator-owned schedules. */
  readonly ownerAgentId: string | null;
  readonly targetAgentId: string;
  readonly grantId: string | null;
  readonly grantEpoch: number;
  readonly name: string;
  readonly body: string;
  /** Untrusted caller-supplied JSON carried to the target as coordination data. */
  readonly context: Readonly<Record<string, unknown>> | null;
  readonly trigger: NormalizedTrigger;
  readonly deliveryMode: DeliveryMode;
  readonly status: ScheduleStatus;
  readonly statusReason: string | null;
  readonly nextDueAt: string | null;
  readonly acceptedAt: string;
  readonly cancelledAt: string | null;
  readonly lastOccurrenceId: string | null;
  readonly revision: number;
}

export interface OccurrenceRecord {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly occurrenceKey: string;
  readonly nominalDueAt: string;
  readonly materializedAt: string;
  readonly state: OccurrenceState;
  readonly messageId: string | null;
  readonly operationId: string | null;
  readonly leaseEpoch: number;
  readonly claimExpiresAt: string | null;
  readonly attempts: number;
  readonly skippedSlots: number;
  readonly payload: unknown;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryAt: string | null;
  readonly dispatchAttempt: number;
  readonly committedAt: string | null;
  readonly bindingId: string | null;
  readonly bindingGeneration: number | null;
}

export interface ClaimedOccurrence {
  readonly occurrence: OccurrenceRecord;
  readonly schedule: ScheduleRecord;
}

export interface NewSchedule {
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly ownerAgentId: string | null;
  readonly targetAgentId: string;
  readonly grantId: string | null;
  readonly grantEpoch: number;
  readonly name: string;
  readonly body: string;
  readonly context: Readonly<Record<string, unknown>> | null;
  readonly trigger: NormalizedTrigger;
  readonly deliveryMode: DeliveryMode;
  readonly nextDueAt: string | null;
}

export interface OccurrenceFinish {
  readonly occurrenceId: string;
  readonly leaseEpoch: number;
  readonly state: OccurrenceState;
  readonly operationId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Persisted UTC retry instant for a queued or blocked occurrence; null means never retried. */
  readonly retryAt?: string | null;
  /** The last host operation definitely had no effect; the next attempt uses a fresh operation. */
  readonly nextAttempt?: boolean;
  /** Authorization was permanently denied: the schedule is suspended with this reason. */
  readonly suspendReason?: string;
}

export interface DispatchBindingRef {
  readonly bindingId: string;
  readonly agentId: string;
  readonly generation: number;
}

export interface DispatchDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly retryable: boolean;
}

export type DispatchCommit =
  | {
      readonly kind: "committed";
      readonly messageId: string;
      readonly operationKey: string;
      readonly occurrence: OccurrenceRecord;
    }
  | { readonly kind: "denied"; readonly decision: DispatchDecision }
  | { readonly kind: "deferred"; readonly decision: Promise<DispatchDecision> }
  /** Cancellation won before the final authorization: no message, no host effect. */
  | { readonly kind: "suppressed" }
  /** The lease was lost to another claim. */
  | { readonly kind: "stale" };

interface ScheduleRow {
  readonly schedule_id: string;
  readonly owner_principal_id: string;
  readonly owner_agent_id: string | null;
  readonly target_agent_id: string;
  readonly grant_id: string | null;
  readonly grant_epoch: number;
  readonly name: string;
  readonly body: string;
  readonly context_json: string | null;
  readonly status_reason: string | null;
  readonly trigger_type: string;
  readonly trigger_json: string;
  readonly delivery_mode: DeliveryMode;
  readonly status: ScheduleStatus;
  readonly next_due_at: string | null;
  readonly accepted_at: string;
  readonly cancelled_at: string | null;
  readonly last_occurrence_id: string | null;
  readonly revision: number;
}

interface OccurrenceRow {
  readonly occurrence_id: string;
  readonly schedule_id: string;
  readonly occurrence_key: string;
  readonly nominal_due_at: string;
  readonly materialized_at: string;
  readonly state: OccurrenceState;
  readonly message_id: string | null;
  readonly operation_id: string | null;
  readonly lease_epoch: number;
  readonly claim_expires_at: string | null;
  readonly attempts: number;
  readonly skipped_slots: number;
  readonly payload_json: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly retry_at: string | null;
  readonly dispatch_attempt: number;
  readonly committed_at: string | null;
  readonly binding_id: string | null;
  readonly binding_generation: number | null;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly schedule_id: string;
}

const SCHEDULE_OCCURRENCE_ACTIVE_STATES = ["queued", "dispatching", "blocked"] as const;

function scheduleFromRow(row: ScheduleRow): ScheduleRecord {
  return {
    scheduleId: row.schedule_id,
    ownerPrincipalId: row.owner_principal_id,
    ownerAgentId: row.owner_agent_id,
    targetAgentId: row.target_agent_id,
    grantId: row.grant_id,
    grantEpoch: row.grant_epoch,
    name: row.name,
    body: row.body,
    context:
      row.context_json === null
        ? null
        : (JSON.parse(row.context_json) as Readonly<Record<string, unknown>>),
    trigger: JSON.parse(row.trigger_json) as NormalizedTrigger,
    deliveryMode: row.delivery_mode,
    status: row.status,
    statusReason: row.status_reason,
    nextDueAt: row.next_due_at,
    acceptedAt: row.accepted_at,
    cancelledAt: row.cancelled_at,
    lastOccurrenceId: row.last_occurrence_id,
    revision: row.revision,
  };
}

function occurrenceFromRow(row: OccurrenceRow): OccurrenceRecord {
  return {
    occurrenceId: row.occurrence_id,
    scheduleId: row.schedule_id,
    occurrenceKey: row.occurrence_key,
    nominalDueAt: row.nominal_due_at,
    materializedAt: row.materialized_at,
    state: row.state,
    messageId: row.message_id,
    operationId: row.operation_id,
    leaseEpoch: row.lease_epoch,
    claimExpiresAt: row.claim_expires_at,
    attempts: row.attempts,
    skippedSlots: row.skipped_slots,
    payload: row.payload_json === null ? null : (JSON.parse(row.payload_json) as unknown),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryAt: row.retry_at,
    dispatchAttempt: row.dispatch_attempt,
    committedAt: row.committed_at,
    bindingId: row.binding_id,
    bindingGeneration: row.binding_generation,
  };
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function nextScheduleStatus(triggerType: string, state: OccurrenceState): ScheduleStatus {
  if (state === "blocked") return "blocked";
  if (triggerType === "at" && state !== "queued" && state !== "dispatching") return "completed";
  return "active";
}

/** Stable per occurrence and attempt; a new attempt follows only a definitive no-effect failure. */
export function operationKeyFor(
  occurrence: Pick<OccurrenceRecord, "occurrenceId" | "dispatchAttempt">,
): string {
  return `schedule:${occurrence.occurrenceId}:${occurrence.dispatchAttempt}`;
}

/**
 * Shares the sideband store's connection so claims, cursor advancement, and message
 * attachment commit in one SQLite transaction. Host dispatch runs outside it, and
 * finishOccurrence is fenced by lease epoch.
 */
export class SqliteScheduleStore {
  private constructor(
    private readonly sideband: SqliteSidebandStore,
    private readonly clock: () => Date,
  ) {}

  static attach(
    sideband: SqliteSidebandStore,
    options: { readonly now?: () => Date } = {},
  ): SqliteScheduleStore {
    // Opening the sideband store already applies core migrations; this is an idempotent guard.
    sideband.applyMigrations(coreMigrations());
    return new SqliteScheduleStore(sideband, options.now ?? (() => new Date()));
  }

  private get database(): Database.Database {
    return this.sideband.database;
  }

  private transaction<T>(work: () => T): T {
    return this.database.transaction(work).immediate();
  }

  private nowDate(): Date {
    const date = this.clock();
    if (!Number.isFinite(date.getTime())) {
      throw new SidebandError("INVALID_ARGUMENT", "Clock returned an invalid date.");
    }
    return date;
  }

  private findIdempotency(
    principalId: string,
    operation: "create" | "cancel",
    key: string,
  ): IdempotencyRow | undefined {
    return this.database
      .prepare(
        "SELECT request_hash, schedule_id FROM schedule_idempotency WHERE principal_id = ? AND operation = ? AND idempotency_key = ?",
      )
      .get(principalId, operation, key) as IdempotencyRow | undefined;
  }

  private appendEvent(input: {
    type: string;
    entityId: string;
    actorPrincipalId: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: string;
  }): void {
    this.sideband.appendEvent({
      type: input.type,
      entityType: "schedule",
      entityId: input.entityId,
      actorPrincipalId: input.actorPrincipalId,
      payload: input.payload,
      occurredAt: input.occurredAt,
    });
  }

  createSchedule(input: NewSchedule): { schedule: ScheduleRecord; replayed: boolean } {
    return this.transaction(() => {
      const prior = this.findIdempotency(input.principalId, "create", input.idempotencyKey);
      if (prior) {
        if (prior.request_hash !== input.requestHash) {
          throw new SidebandError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used with another request.",
          );
        }
        return { schedule: this.getSchedule(prior.schedule_id), replayed: true };
      }
      const scheduleId = randomUUID();
      const now = this.nowDate().toISOString();
      this.database
        .prepare(
          `INSERT INTO schedules (
            schedule_id, owner_principal_id, owner_agent_id, target_agent_id, grant_id,
            grant_epoch, name, body, context_json, trigger_type, trigger_json, delivery_mode,
            status, next_due_at, accepted_at, cancelled_at, last_occurrence_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
        )
        .run(
          scheduleId,
          input.principalId,
          input.ownerAgentId,
          input.targetAgentId,
          input.grantId,
          input.grantEpoch,
          input.name,
          input.body,
          input.context === null ? null : canonicalJson(input.context),
          input.trigger.type,
          canonicalJson(input.trigger),
          input.deliveryMode,
          input.nextDueAt,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO schedule_idempotency
            (principal_id, operation, idempotency_key, request_hash, schedule_id, created_at)
           VALUES (?, 'create', ?, ?, ?, ?)`,
        )
        .run(input.principalId, input.idempotencyKey, input.requestHash, scheduleId, now);
      this.appendEvent({
        type: "schedule.created",
        entityId: scheduleId,
        actorPrincipalId: input.principalId,
        payload: {
          triggerType: input.trigger.type,
          ownerAgentId: input.ownerAgentId,
          targetAgentId: input.targetAgentId,
          grantId: input.grantId,
          grantEpoch: input.grantEpoch,
          deliveryMode: input.deliveryMode,
          nextDueAt: input.nextDueAt,
        },
        occurredAt: now,
      });
      return { schedule: this.getSchedule(scheduleId), replayed: false };
    });
  }

  /** Exact replay lookup for a create key; a different request under the key conflicts. */
  findCreateReplay(input: {
    principalId: string;
    idempotencyKey: string;
    requestHash: string;
  }): ScheduleRecord | null {
    const prior = this.findIdempotency(input.principalId, "create", input.idempotencyKey);
    if (!prior) return null;
    if (prior.request_hash !== input.requestHash) {
      throw new SidebandError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with another request.",
      );
    }
    return this.getSchedule(prior.schedule_id);
  }

  getSchedule(scheduleId: string): ScheduleRecord {
    const row = this.database
      .prepare("SELECT * FROM schedules WHERE schedule_id = ?")
      .get(scheduleId) as ScheduleRow | undefined;
    if (!row) throw new SidebandError("SCHEDULE_NOT_FOUND", `Schedule not found: ${scheduleId}`);
    return scheduleFromRow(row);
  }

  listOccurrences(scheduleId: string): OccurrenceRecord[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM schedule_occurrences WHERE schedule_id = ? ORDER BY nominal_due_at, occurrence_id",
        )
        .all(scheduleId) as OccurrenceRow[]
    ).map(occurrenceFromRow);
  }

  /**
   * Tombstones the schedule. Occurrences not yet past the fenced dispatch authorization
   * (committed_at IS NULL) are suppressed, even when a runner already holds their claim.
   * Committed ones are reported as in flight: their host effect may already be accepted.
   */
  cancelSchedule(input: {
    principalId: string;
    scheduleId: string;
    idempotencyKey: string;
    requestHash: string;
    authorize: (schedule: ScheduleRecord) => {
      readonly allowed: boolean;
      readonly reason?: string;
    };
  }): { schedule: ScheduleRecord; replayed: boolean; occurrences: OccurrenceRecord[] } {
    return this.transaction(() => {
      const prior = this.findIdempotency(input.principalId, "cancel", input.idempotencyKey);
      if (prior) {
        // A replay is not a bypass: authority is re-checked before anything about the earlier
        // request (conflict or result) is revealed.
        const decision = input.authorize(this.getSchedule(prior.schedule_id));
        if (!decision.allowed) {
          throw new SidebandError("UNAUTHORIZED", "Not authorized to cancel this schedule.", {
            reason: decision.reason ?? "not_owner",
          });
        }
        if (prior.request_hash !== input.requestHash) {
          throw new SidebandError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used with another request.",
          );
        }
        return {
          schedule: this.getSchedule(prior.schedule_id),
          replayed: true,
          occurrences: this.listOccurrences(prior.schedule_id),
        };
      }
      const schedule = this.getSchedule(input.scheduleId);
      const decision = input.authorize(schedule);
      if (!decision.allowed) {
        throw new SidebandError("UNAUTHORIZED", "Not authorized to cancel this schedule.", {
          reason: decision.reason ?? "not_owner",
        });
      }
      const now = this.nowDate().toISOString();
      if (schedule.status !== "cancelled") {
        this.database
          .prepare(
            `UPDATE schedules SET status = 'cancelled', cancelled_at = ?, next_due_at = NULL,
               revision = revision + 1 WHERE schedule_id = ?`,
          )
          .run(now, schedule.scheduleId);
      }
      this.database
        .prepare(
          `UPDATE schedule_occurrences SET state = 'cancelled', error_code = 'SCHEDULE_CANCELLED',
             error_message = NULL, claim_expires_at = NULL, retry_at = NULL
           WHERE schedule_id = ?
             AND (state IN ('queued', 'blocked')
               OR (state = 'dispatching' AND committed_at IS NULL))`,
        )
        .run(schedule.scheduleId);
      this.database
        .prepare(
          `INSERT INTO schedule_idempotency
            (principal_id, operation, idempotency_key, request_hash, schedule_id, created_at)
           VALUES (?, 'cancel', ?, ?, ?, ?)`,
        )
        .run(input.principalId, input.idempotencyKey, input.requestHash, schedule.scheduleId, now);
      const occurrences = this.listOccurrences(schedule.scheduleId);
      this.appendEvent({
        type: "schedule.cancelled",
        entityId: schedule.scheduleId,
        actorPrincipalId: input.principalId,
        payload: {
          inFlightOccurrenceIds: occurrences
            .filter((occurrence) => occurrence.state === "dispatching")
            .map((occurrence) => occurrence.occurrenceId),
        },
        occurredAt: now,
      });
      return { schedule: this.getSchedule(schedule.scheduleId), replayed: false, occurrences };
    });
  }

  emitEvent(input: {
    principalId: string;
    eventId: string;
    eventName: string;
    occurredAt: string;
    payload: unknown;
    requestHash: string;
  }): { matchedCount: number; replayed: boolean } {
    return this.transaction(() => {
      const prior = this.database
        .prepare(
          "SELECT request_hash, matched_count FROM schedule_event_ingress WHERE principal_id = ? AND event_id = ?",
        )
        .get(input.principalId, input.eventId) as
        | { request_hash: string; matched_count: number }
        | undefined;
      if (prior) {
        if (prior.request_hash !== input.requestHash) {
          throw new SidebandError(
            "IDEMPOTENCY_CONFLICT",
            "Event id was already used with another event.",
          );
        }
        return { matchedCount: prior.matched_count, replayed: true };
      }
      const now = this.nowDate().toISOString();
      const matches = this.database
        .prepare(
          `SELECT schedule_id FROM schedules
           WHERE owner_principal_id = ? AND trigger_type = 'event' AND status IN ('active', 'blocked')
             AND json_extract(trigger_json, '$.eventName') = ?
           ORDER BY schedule_id`,
        )
        .all(input.principalId, input.eventName) as Array<{ schedule_id: string }>;
      const insertOccurrence = this.database.prepare(
        `INSERT OR IGNORE INTO schedule_occurrences (
          occurrence_id, schedule_id, occurrence_key, nominal_due_at, materialized_at,
          state, lease_epoch, attempts, skipped_slots, payload_json
        ) VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, 0, ?)`,
      );
      const payloadJson = canonicalJson(input.payload);
      for (const { schedule_id } of matches) {
        insertOccurrence.run(
          randomUUID(),
          schedule_id,
          `event:${input.eventId}`,
          input.occurredAt,
          now,
          payloadJson,
        );
      }
      this.database
        .prepare(
          `INSERT INTO schedule_event_ingress
            (principal_id, event_id, event_name, occurred_at, request_hash, matched_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.principalId,
          input.eventId,
          input.eventName,
          input.occurredAt,
          input.requestHash,
          matches.length,
          now,
        );
      this.sideband.appendEvent({
        type: "schedule.event-received",
        entityType: "event",
        entityId: input.eventId,
        actorPrincipalId: input.principalId,
        payload: { eventName: input.eventName, matchedCount: matches.length },
        occurredAt: now,
      });
      return { matchedCount: matches.length, replayed: false };
    });
  }

  /**
   * Materializes due slots and claims runnable occurrences. Persisted UTC instants further in
   * the future than any value this process could have written (retryHorizonSeconds,
   * leaseSeconds) mean the clock moved backwards, and are treated as due rather than stalled.
   */
  claimDue(input: {
    limit: number;
    leaseSeconds: number;
    retryHorizonSeconds?: number;
  }): ClaimedOccurrence[] {
    return this.transaction(() => {
      const nowMs = this.nowDate().getTime();
      const now = toIso(nowMs);
      const retryHorizon = toIso(nowMs + (input.retryHorizonSeconds ?? 3_600) * 1000);
      const leaseHorizon = toIso(nowMs + input.leaseSeconds * 1000);
      this.materializeDue(nowMs, input.limit);
      const candidates = this.database
        .prepare(
          `SELECT o.* FROM schedule_occurrences o
           JOIN schedules s ON s.schedule_id = o.schedule_id
           WHERE s.status IN ('active', 'blocked')
             AND ((o.state = 'queued'
                   AND (o.retry_at IS NULL OR o.retry_at <= ? OR o.retry_at > ?))
               OR (o.state = 'blocked' AND o.retry_at IS NOT NULL
                   AND (o.retry_at <= ? OR o.retry_at > ?))
               OR (o.state = 'dispatching'
                   AND (o.claim_expires_at <= ? OR o.claim_expires_at > ?)))
           ORDER BY o.nominal_due_at, o.occurrence_id
           LIMIT ?`,
        )
        .all(
          now,
          retryHorizon,
          now,
          retryHorizon,
          now,
          leaseHorizon,
          input.limit,
        ) as OccurrenceRow[];
      return candidates.map((row) => this.claimOccurrence(row, nowMs, input.leaseSeconds));
    });
  }

  private materializeDue(nowMs: number, limit: number): void {
    const now = toIso(nowMs);
    const due = this.database
      .prepare(
        `SELECT * FROM schedules
         WHERE status IN ('active', 'blocked') AND trigger_type IN ('at', 'interval', 'cron')
           AND next_due_at IS NOT NULL AND next_due_at <= ?
         ORDER BY next_due_at, schedule_id
         LIMIT ?`,
      )
      .all(now, limit) as ScheduleRow[];
    for (const row of due) {
      const schedule = scheduleFromRow(row);
      const nominal = schedule.nextDueAt as string;
      const trigger = schedule.trigger;
      if (trigger.type === "at") {
        this.insertOccurrence(schedule.scheduleId, `once:${nominal}`, nominal, nowMs, "queued", 0);
        this.advanceCursor(schedule.scheduleId, nominal, null);
        continue;
      }
      if (trigger.type !== "interval" && trigger.type !== "cron") continue;
      const late = nowMs - Date.parse(nominal);
      const next = nextSlotAfter(trigger, nowMs);
      if (trigger.type === "cron" && late > CRON_GRACE_MS) {
        this.insertOccurrence(
          schedule.scheduleId,
          `cron:${nominal}`,
          nominal,
          nowMs,
          "cancelled",
          0,
          {
            errorCode: "CRON_SLOT_EXPIRED",
            errorMessage: "The slot passed the grace window while the scheduler was not running.",
          },
        );
      } else {
        const outstanding = this.database
          .prepare(
            `SELECT occurrence_id FROM schedule_occurrences
             WHERE schedule_id = ? AND state IN (${SCHEDULE_OCCURRENCE_ACTIVE_STATES.map(() => "?").join(", ")})
             LIMIT 1`,
          )
          .get(schedule.scheduleId, ...SCHEDULE_OCCURRENCE_ACTIVE_STATES) as
          | { occurrence_id: string }
          | undefined;
        if (outstanding) {
          this.database
            .prepare(
              "UPDATE schedule_occurrences SET skipped_slots = skipped_slots + 1 WHERE occurrence_id = ?",
            )
            .run(outstanding.occurrence_id);
        } else {
          const skipped =
            trigger.type === "interval"
              ? Math.max(0, Math.floor(late / (trigger.everySeconds * 1000)))
              : 0;
          this.insertOccurrence(
            schedule.scheduleId,
            `${trigger.type}:${nominal}`,
            nominal,
            nowMs,
            "queued",
            skipped,
          );
        }
      }
      this.advanceCursor(schedule.scheduleId, nominal, next === null ? null : toIso(next));
    }
  }

  private insertOccurrence(
    scheduleId: string,
    occurrenceKey: string,
    nominal: string,
    nowMs: number,
    state: OccurrenceState,
    skippedSlots: number,
    error: { errorCode: string; errorMessage: string } | null = null,
  ): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO schedule_occurrences (
          occurrence_id, schedule_id, occurrence_key, nominal_due_at, materialized_at,
          state, lease_epoch, attempts, skipped_slots, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        scheduleId,
        occurrenceKey,
        nominal,
        toIso(nowMs),
        state,
        skippedSlots,
        error?.errorCode ?? null,
        error?.errorMessage ?? null,
      );
  }

  private advanceCursor(scheduleId: string, expectedDueAt: string, nextDueAt: string | null): void {
    this.database
      .prepare(
        `UPDATE schedules SET next_due_at = ?, revision = revision + 1
         WHERE schedule_id = ? AND next_due_at = ?`,
      )
      .run(nextDueAt, scheduleId, expectedDueAt);
  }

  private claimOccurrence(
    row: OccurrenceRow,
    nowMs: number,
    leaseSeconds: number,
  ): ClaimedOccurrence {
    this.database
      .prepare(
        `UPDATE schedule_occurrences
         SET state = 'dispatching', lease_epoch = lease_epoch + 1, claim_expires_at = ?,
             attempts = attempts + 1, retry_at = NULL
         WHERE occurrence_id = ?`,
      )
      .run(toIso(nowMs + leaseSeconds * 1000), row.occurrence_id);
    return {
      occurrence: this.getOccurrence(row.occurrence_id),
      schedule: this.getSchedule(row.schedule_id),
    };
  }

  /** Claims an indeterminate occurrence for an explicit replay of its stored host request. */
  claimForReplay(input: { occurrenceId: string; leaseSeconds: number }): ClaimedOccurrence | null {
    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM schedule_occurrences WHERE occurrence_id = ?")
        .get(input.occurrenceId) as OccurrenceRow | undefined;
      if (!row) throw new SidebandError("SCHEDULE_NOT_FOUND", "Occurrence not found.");
      if (row.state !== "indeterminate" || row.committed_at === null) return null;
      this.database
        .prepare(
          `UPDATE schedule_occurrences
           SET state = 'dispatching', lease_epoch = lease_epoch + 1, claim_expires_at = ?
           WHERE occurrence_id = ? AND state = 'indeterminate'`,
        )
        .run(toIso(this.nowDate().getTime() + input.leaseSeconds * 1000), input.occurrenceId);
      return {
        occurrence: this.getOccurrence(input.occurrenceId),
        schedule: this.getSchedule(row.schedule_id),
      };
    });
  }

  /**
   * The linearization point. In one transaction: re-check the lease fence and cancellation,
   * evaluate the trusted dispatch authorization, then attach the mailbox message and pin the
   * binding. A synchronous decision is evaluated inside the transaction; an async one is
   * returned as deferred so the caller can await it and commit again with the settled value.
   */
  commitDispatch(input: {
    occurrenceId: string;
    leaseEpoch: number;
    binding: DispatchBindingRef | null;
    unboundCode: string;
    decide: () => DispatchDecision | Promise<DispatchDecision>;
  }): DispatchCommit {
    return this.transaction((): DispatchCommit => {
      const row = this.database
        .prepare("SELECT * FROM schedule_occurrences WHERE occurrence_id = ?")
        .get(input.occurrenceId) as OccurrenceRow | undefined;
      if (!row) return { kind: "stale" };
      if (row.state === "cancelled") return { kind: "suppressed" };
      if (row.state !== "dispatching" || row.lease_epoch !== input.leaseEpoch) {
        return { kind: "stale" };
      }
      const schedule = this.getSchedule(row.schedule_id);
      if (schedule.status === "cancelled") {
        this.database
          .prepare(
            `UPDATE schedule_occurrences SET state = 'cancelled', error_code = 'SCHEDULE_CANCELLED',
               claim_expires_at = NULL WHERE occurrence_id = ?`,
          )
          .run(input.occurrenceId);
        return { kind: "suppressed" };
      }
      const decision = input.decide();
      if (isThenable(decision)) return { kind: "deferred", decision };
      if (!decision.allowed) return { kind: "denied", decision };
      if (input.binding === null) {
        return {
          kind: "denied",
          decision: { allowed: false, reason: input.unboundCode, retryable: true },
        };
      }
      const payload =
        row.payload_json === null ? undefined : (JSON.parse(row.payload_json) as unknown);
      if (schedule.ownerAgentId === null) {
        this.sideband.registerAgent({
          agentId: SCHEDULER_SENDER_AGENT_ID,
          displayName: SCHEDULER_SENDER_DISPLAY_NAME,
          actorPrincipalId: schedule.ownerPrincipalId,
        });
      }
      const message = this.sideband.sendMessage({
        idempotencyKey: `schedule:${row.occurrence_id}`,
        fromAgentId: schedule.ownerAgentId ?? SCHEDULER_SENDER_AGENT_ID,
        target: { type: "agent", id: schedule.targetAgentId },
        correlationId: `schedule:${schedule.scheduleId}`,
        body: schedule.body,
        messageClass: "system",
        metadata: {
          schedule: {
            scheduleId: schedule.scheduleId,
            occurrenceId: row.occurrence_id,
            occurrenceKey: row.occurrence_key,
            name: schedule.name,
            ownerPrincipalId: schedule.ownerPrincipalId,
            ownerAgentId: schedule.ownerAgentId,
          },
          ...(schedule.context === null ? {} : { scheduleContext: schedule.context }),
          ...(payload === undefined ? {} : { event: payload }),
        },
        provenance: {
          authenticatedPrincipalId: schedule.ownerPrincipalId,
          source: "internal",
          sourceInstanceId: null,
          sourceOperationId: null,
          trust: "untrusted",
        },
      });
      // An unsent commit that now routes to another binding takes a fresh operation key, so the
      // stored request for the old binding can never be reused against the new one.
      const rebound = row.binding_id !== null && row.binding_id !== input.binding.bindingId;
      const now = this.nowDate().toISOString();
      this.database
        .prepare(
          `UPDATE schedule_occurrences
           SET message_id = ?, committed_at = ?, binding_id = ?, binding_generation = ?,
               dispatch_attempt = dispatch_attempt + ?
           WHERE occurrence_id = ?`,
        )
        .run(
          message.messageId,
          now,
          input.binding.bindingId,
          input.binding.generation,
          rebound ? 1 : 0,
          input.occurrenceId,
        );
      const occurrence = this.getOccurrence(input.occurrenceId);
      return {
        kind: "committed",
        messageId: message.messageId,
        operationKey: operationKeyFor(occurrence),
        occurrence,
      };
    });
  }

  private getOccurrence(occurrenceId: string): OccurrenceRecord {
    return occurrenceFromRow(
      this.database
        .prepare("SELECT * FROM schedule_occurrences WHERE occurrence_id = ?")
        .get(occurrenceId) as OccurrenceRow,
    );
  }

  finishOccurrence(input: OccurrenceFinish): boolean {
    return this.transaction(() => {
      // Queued (retry) and blocked outcomes are pre-effect: clear the commit so the next attempt
      // re-runs the fenced authorization and stays cancellable.
      const uncommit = input.state === "queued" || input.state === "blocked";
      const result = this.database
        .prepare(
          `UPDATE schedule_occurrences
           SET state = ?, operation_id = COALESCE(?, operation_id), error_code = ?,
               error_message = ?, claim_expires_at = NULL, retry_at = ?,
               dispatch_attempt = dispatch_attempt + ?,
               committed_at = CASE WHEN ? = 1 THEN NULL ELSE committed_at END
           WHERE occurrence_id = ? AND lease_epoch = ? AND state = 'dispatching'`,
        )
        .run(
          input.state,
          input.operationId,
          input.errorCode,
          input.errorMessage,
          input.retryAt ?? null,
          input.nextAttempt ? 1 : 0,
          uncommit ? 1 : 0,
          input.occurrenceId,
          input.leaseEpoch,
        );
      if (result.changes === 0) return false;
      const occurrence = this.getOccurrence(input.occurrenceId);
      const schedule = this.getSchedule(occurrence.scheduleId);
      const status =
        input.suspendReason !== undefined
          ? "suspended"
          : nextScheduleStatus(schedule.trigger.type, input.state);
      this.database
        .prepare(
          `UPDATE schedules SET status = ?, status_reason = ?, last_occurrence_id = ?,
             revision = revision + 1
           WHERE schedule_id = ? AND status IN ('active', 'blocked')`,
        )
        .run(
          status,
          input.suspendReason ?? (status === "blocked" ? input.errorCode : null),
          input.occurrenceId,
          schedule.scheduleId,
        );
      this.appendEvent({
        type: `schedule.occurrence.${input.state}`,
        entityId: schedule.scheduleId,
        actorPrincipalId: schedule.ownerPrincipalId,
        payload: {
          occurrenceId: input.occurrenceId,
          state: input.state,
          errorCode: input.errorCode,
          retryAt: input.retryAt ?? null,
          ...(input.suspendReason === undefined ? {} : { suspendReason: input.suspendReason }),
        },
        occurredAt: this.nowDate().toISOString(),
      });
      return true;
    });
  }

  getOccurrenceRecord(occurrenceId: string): OccurrenceRecord {
    const row = this.database
      .prepare("SELECT * FROM schedule_occurrences WHERE occurrence_id = ?")
      .get(occurrenceId) as OccurrenceRow | undefined;
    if (!row)
      throw new SidebandError("SCHEDULE_NOT_FOUND", `Occurrence not found: ${occurrenceId}`);
    return occurrenceFromRow(row);
  }

  listSchedules(ownerPrincipalId?: string): ScheduleRecord[] {
    const rows =
      ownerPrincipalId === undefined
        ? (this.database
            .prepare("SELECT * FROM schedules ORDER BY accepted_at, schedule_id")
            .all() as ScheduleRow[])
        : (this.database
            .prepare(
              "SELECT * FROM schedules WHERE owner_principal_id = ? ORDER BY accepted_at, schedule_id",
            )
            .all(ownerPrincipalId) as ScheduleRow[]);
    return rows.map(scheduleFromRow);
  }
}
