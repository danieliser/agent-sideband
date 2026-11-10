import { SidebandError } from "../core/errors.js";
import type { AgentSideband, HostOperationResult } from "../core/sideband.js";
import type { AgentBinding } from "../core/types.js";
import type { SidebandStore } from "../store/store.js";
import { canonicalJson, sha256, validateIdentifier, validateText } from "../store/sqlite.js";
import type {
  ClaimedOccurrence,
  DeliveryMode,
  DispatchBindingRef,
  DispatchCommit,
  DispatchDecision,
  OccurrenceRecord,
  OccurrenceState,
  ScheduleRecord,
  SqliteScheduleStore,
} from "./store.js";
import { operationKeyFor } from "./store.js";
import { normalizeTrigger, parseRfc3339, toIso, type TimeTrigger } from "./triggers.js";

const DELIVERY_MODES: ReadonlySet<string> = new Set<DeliveryMode>(["wake", "context", "both"]);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_NAME_BYTES = 512;
/** Event payload and schedule context must both fit in one message's 64 KiB metadata. */
const MAX_EVENT_PAYLOAD_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_CONTEXT_DEPTH = 8;
const DEFAULT_LIMIT = 25;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_RETRY_BASE_SECONDS = 5;
const DEFAULT_RETRY_MAX_SECONDS = 300;

const needsWake = (mode: DeliveryMode): boolean => mode !== "context";
const needsContext = (mode: DeliveryMode): boolean => mode !== "wake";

type MaybePromise<T> = T | Promise<T>;

interface DispatchOutcome {
  readonly state: OccurrenceState;
  readonly operationId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryAt?: string | null;
  readonly nextAttempt?: boolean;
  readonly suspendReason?: string;
}

export interface ScheduleCreateAuthorizationRequest<TCaller> {
  /** The server-resolved credential. The scheduler passes it through without inspecting it. */
  readonly caller: TCaller;
  /** Authenticated principal stamped by the server, never by a payload. */
  readonly principalId: string;
  readonly targetAgentId: string;
  readonly deliveryMode: DeliveryMode;
}

export type ScheduleCreateDecision =
  | {
      readonly allowed: true;
      readonly ownerPrincipalId: string;
      /** Null for operator-owned schedules. */
      readonly ownerAgentId: string | null;
      readonly targetAgentId: string;
      /** Pinned on the schedule and re-checked at every dispatch. */
      readonly grantId: string | null;
      readonly grantEpoch: number;
    }
  | { readonly allowed: false; readonly reason: string };

export interface ScheduleDispatchAuthorizationRequest {
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly ownerPrincipalId: string;
  readonly ownerAgentId: string | null;
  readonly targetAgentId: string;
  /** The exact binding about to receive the effect, or null when the target is unbound. */
  readonly binding: DispatchBindingRef | null;
  readonly pinned: { readonly grantId: string | null; readonly grantEpoch: number };
  readonly deliveryMode: DeliveryMode;
}

/** retryable:false blocks the occurrence for good and suspends the schedule. */
export type ScheduleDispatchDecision = DispatchDecision;

export interface ScheduleCancelAuthorizationRequest<TCaller> {
  readonly caller: TCaller;
  readonly principalId: string;
  readonly scheduleId: string;
  readonly ownerPrincipalId: string;
  readonly ownerAgentId: string | null;
  readonly targetAgentId: string;
}

/** Trusted policy composed by the integrator. There is no default: callers never self-declare owners. */
export interface ScheduleAuthorizer<TCaller> {
  authorizeCreate(
    request: ScheduleCreateAuthorizationRequest<TCaller>,
  ): MaybePromise<ScheduleCreateDecision>;
  /** Synchronous decisions run inside the dispatch commit transaction (exact linearization). */
  authorizeDispatch(
    request: ScheduleDispatchAuthorizationRequest,
  ): MaybePromise<ScheduleDispatchDecision>;
  /** Defaults to: only the owning principal may cancel. Runs inside the cancel transaction. */
  authorizeCancel?(request: ScheduleCancelAuthorizationRequest<TCaller>): {
    readonly allowed: boolean;
    readonly reason?: string;
  };
}

export interface SchedulerRetryOptions {
  readonly baseSeconds?: number;
  readonly maxSeconds?: number;
  /** Jitter source in [0, 1). The delay is scaled by 0.8 + 0.4 * random(). */
  readonly random?: () => number;
}

export interface SchedulerOptions<TCaller> {
  readonly store: SidebandStore;
  readonly sideband: AgentSideband;
  readonly schedules: SqliteScheduleStore;
  readonly now: () => Date;
  readonly authorizer: ScheduleAuthorizer<TCaller>;
  readonly retry?: SchedulerRetryOptions;
}

export interface CreateScheduleInput<TCaller = unknown> {
  readonly caller: TCaller;
  readonly principalId: string;
  readonly idempotencyKey: string;
  /** Optional consistency check against the authorizer's owner; never a source of authority. */
  readonly ownerAgentId?: string;
  readonly targetAgentId: string;
  readonly name: string;
  readonly body: string;
  /** Untrusted coordination JSON, at most 16 KiB canonical and 8 levels deep. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly trigger: TimeTrigger;
  readonly deliveryMode: DeliveryMode;
}

export interface CancelScheduleInput<TCaller = unknown> {
  readonly caller: TCaller;
  readonly principalId: string;
  readonly scheduleId: string;
  readonly idempotencyKey: string;
}

export interface EmitEventInput {
  readonly principalId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RunDueResult {
  readonly occurrenceId: string;
  readonly state: OccurrenceState;
  readonly finished: boolean;
}

function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(jsonDepth));
  if (typeof value === "object" && value !== null) {
    return 1 + Math.max(0, ...Object.values(value).map(jsonDepth));
  }
  return 0;
}

function normalizeContext(
  context: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | null {
  if (context === undefined) return null;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw new SidebandError("INVALID_ARGUMENT", "context must be a JSON object.");
  }
  const json = canonicalJson(context);
  if (Buffer.byteLength(json, "utf8") > MAX_CONTEXT_BYTES) {
    throw new SidebandError("INVALID_ARGUMENT", "context is too large.");
  }
  const parsed = JSON.parse(json) as Readonly<Record<string, unknown>>;
  if (jsonDepth(parsed) > MAX_CONTEXT_DEPTH) {
    throw new SidebandError("INVALID_ARGUMENT", "context is nested too deeply.");
  }
  return parsed;
}

const unauthorized = (reason: string, message: string): SidebandError =>
  new SidebandError("UNAUTHORIZED", message, { reason });

export class Scheduler<TCaller = unknown> {
  constructor(private readonly options: SchedulerOptions<TCaller>) {
    const authorizer = options.authorizer as ScheduleAuthorizer<TCaller> | undefined;
    if (
      typeof authorizer?.authorizeCreate !== "function" ||
      typeof authorizer.authorizeDispatch !== "function"
    ) {
      throw new SidebandError(
        "INVALID_ARGUMENT",
        "Scheduler requires a trusted authorizer with authorizeCreate and authorizeDispatch.",
      );
    }
  }

  async createSchedule(
    input: CreateScheduleInput<TCaller>,
  ): Promise<{ schedule: ScheduleRecord; replayed: boolean }> {
    validateIdentifier(input.principalId, "principalId");
    validateIdentifier(input.idempotencyKey, "idempotencyKey");
    if (input.ownerAgentId !== undefined) validateIdentifier(input.ownerAgentId, "ownerAgentId");
    validateIdentifier(input.targetAgentId, "targetAgentId");
    validateText(input.name, "name", MAX_NAME_BYTES);
    validateText(input.body, "body", MAX_BODY_BYTES);
    if (!DELIVERY_MODES.has(input.deliveryMode)) {
      throw new SidebandError("INVALID_ARGUMENT", "deliveryMode must be wake, context, or both.");
    }
    const context = normalizeContext(input.context);
    const decision = await this.authorizeCreate(input);
    const normalized = normalizeTrigger(input.trigger, this.options.now().getTime());
    const requestHash = sha256(
      canonicalJson({
        targetAgentId: input.targetAgentId,
        name: input.name,
        body: input.body,
        context,
        trigger: input.trigger,
        deliveryMode: input.deliveryMode,
      }),
    );
    // Exact replays are re-authorized above but skip host preflight: the schedule already exists.
    const replay = this.options.schedules.findCreateReplay({
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    if (replay !== null) return { schedule: replay, replayed: true };
    await this.assertTargetCapabilities(input.targetAgentId, input.deliveryMode);
    return this.options.schedules.createSchedule({
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      ownerAgentId: decision.ownerAgentId,
      targetAgentId: input.targetAgentId,
      grantId: decision.grantId,
      grantEpoch: decision.grantEpoch,
      name: input.name,
      body: input.body,
      context,
      trigger: normalized.trigger,
      deliveryMode: input.deliveryMode,
      nextDueAt: normalized.firstDueMs === null ? null : toIso(normalized.firstDueMs),
    });
  }

  private async authorizeCreate(
    input: CreateScheduleInput<TCaller>,
  ): Promise<Extract<ScheduleCreateDecision, { allowed: true }>> {
    const decision = await this.options.authorizer.authorizeCreate({
      caller: input.caller,
      principalId: input.principalId,
      targetAgentId: input.targetAgentId,
      deliveryMode: input.deliveryMode,
    });
    if (!decision.allowed) {
      throw unauthorized(decision.reason, "Not authorized to schedule this target.");
    }
    // Fail closed on a decision about anything other than what was asked.
    if (
      decision.ownerPrincipalId !== input.principalId ||
      decision.targetAgentId !== input.targetAgentId ||
      (input.ownerAgentId !== undefined && decision.ownerAgentId !== input.ownerAgentId) ||
      !Number.isSafeInteger(decision.grantEpoch)
    ) {
      throw unauthorized("decision_mismatch", "Schedule authorization did not match the request.");
    }
    if (decision.ownerAgentId !== null) this.options.store.getAgent(decision.ownerAgentId);
    this.options.store.getAgent(input.targetAgentId);
    return decision;
  }

  private async assertTargetCapabilities(
    targetAgentId: string,
    deliveryMode: DeliveryMode,
  ): Promise<void> {
    let binding: AgentBinding;
    try {
      binding = this.options.store.getActiveBinding(targetAgentId);
    } catch (error) {
      if (error instanceof SidebandError) return;
      throw error;
    }
    const capabilities = await this.options.sideband.hostAdapter(binding.adapter).capabilities();
    if (needsContext(deliveryMode) && !capabilities.context) {
      throw new SidebandError(
        "CONTEXT_INJECTION_UNSUPPORTED",
        `Adapter ${binding.adapter} cannot inject context for this schedule.`,
        { adapter: binding.adapter, deliveryMode, context: false, wake: capabilities.wake },
      );
    }
    if (needsWake(deliveryMode) && !capabilities.wake) {
      throw new SidebandError(
        "ADAPTER_CAPABILITY_UNAVAILABLE",
        `Adapter ${binding.adapter} cannot wake an agent for this schedule.`,
        { adapter: binding.adapter, deliveryMode },
      );
    }
  }

  cancelSchedule(
    input: CancelScheduleInput<TCaller>,
  ): ReturnType<SqliteScheduleStore["cancelSchedule"]> {
    validateIdentifier(input.principalId, "principalId");
    validateIdentifier(input.scheduleId, "scheduleId");
    validateIdentifier(input.idempotencyKey, "idempotencyKey");
    const authorizeCancel = this.options.authorizer.authorizeCancel?.bind(this.options.authorizer);
    return this.options.schedules.cancelSchedule({
      principalId: input.principalId,
      scheduleId: input.scheduleId,
      idempotencyKey: input.idempotencyKey,
      requestHash: sha256(canonicalJson({ scheduleId: input.scheduleId })),
      authorize: (schedule) =>
        authorizeCancel
          ? authorizeCancel({
              caller: input.caller,
              principalId: input.principalId,
              scheduleId: schedule.scheduleId,
              ownerPrincipalId: schedule.ownerPrincipalId,
              ownerAgentId: schedule.ownerAgentId,
              targetAgentId: schedule.targetAgentId,
            })
          : { allowed: schedule.ownerPrincipalId === input.principalId, reason: "not_owner" },
    });
  }

  emitEvent(input: EmitEventInput): { matchedCount: number; replayed: boolean } {
    validateIdentifier(input.eventId, "eventId");
    validateIdentifier(input.eventName, "eventName");
    const occurredMs = parseRfc3339(input.occurredAt, "occurredAt");
    if (occurredMs > this.options.now().getTime()) {
      throw new SidebandError("INVALID_ARGUMENT", "occurredAt cannot be in the future.");
    }
    const payloadJson = canonicalJson(input.payload);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
      throw new SidebandError("INVALID_ARGUMENT", "Event payload is too large.");
    }
    const occurredAt = toIso(occurredMs);
    const payload = JSON.parse(payloadJson) as Readonly<Record<string, unknown>>;
    return this.options.schedules.emitEvent({
      principalId: input.principalId,
      eventId: input.eventId,
      eventName: input.eventName,
      occurredAt,
      payload,
      requestHash: sha256(canonicalJson({ eventName: input.eventName, occurredAt, payload })),
    });
  }

  private retryAt(attempts: number): string {
    const base = this.options.retry?.baseSeconds ?? DEFAULT_RETRY_BASE_SECONDS;
    const max = this.options.retry?.maxSeconds ?? DEFAULT_RETRY_MAX_SECONDS;
    const random = this.options.retry?.random ?? Math.random;
    const exponent = Math.min(Math.max(attempts - 1, 0), 30);
    const seconds = Math.min(max, base * 2 ** exponent) * (0.8 + 0.4 * random());
    return toIso(this.options.now().getTime() + Math.round(seconds * 1000));
  }

  private retryHorizonSeconds(): number {
    return (this.options.retry?.maxSeconds ?? DEFAULT_RETRY_MAX_SECONDS) * 1.2 + 1;
  }

  /**
   * Phase A claims due occurrences. Phase B resolves the route and evaluates the trusted
   * authorization inside the fenced commit that attaches the message (the linearization point).
   * Phase C dispatches to the host outside any transaction, keyed by a stable operation key.
   * Phase D finishes fenced by lease epoch.
   */
  async runDue(options: { limit?: number; leaseSeconds?: number } = {}): Promise<RunDueResult[]> {
    const claims = this.options.schedules.claimDue({
      limit: options.limit ?? DEFAULT_LIMIT,
      leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      retryHorizonSeconds: this.retryHorizonSeconds(),
    });
    const results: RunDueResult[] = [];
    for (const claim of claims) {
      let outcome: DispatchOutcome | null;
      try {
        outcome = await this.dispatch(claim);
      } catch (error) {
        if (!(error instanceof SidebandError)) {
          // Unknown failure before any recorded effect: leave the lease to expire and retry.
          continue;
        }
        if (error.code === "ADAPTER_NOT_FOUND") {
          results.push(this.finish(claim, this.blocked(claim, error.code, error.message)));
          continue;
        }
        outcome = {
          state: "failed",
          operationId: null,
          errorCode: error.code,
          errorMessage: error.message,
        };
      }
      if (outcome === null) continue;
      results.push(this.finish(claim, outcome));
    }
    return results;
  }

  /**
   * Explicitly resends an indeterminate occurrence's stored host request. Allowed only while the
   * schedule is still authorized and the adapter declared that exact request replay-safe.
   * Timers never call this.
   */
  async replayIndeterminate(input: {
    occurrenceId: string;
    leaseSeconds?: number;
  }): Promise<RunDueResult> {
    const claim = this.options.schedules.claimForReplay({
      occurrenceId: input.occurrenceId,
      leaseSeconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    });
    if (claim === null) {
      throw new SidebandError(
        "INVALID_ARGUMENT",
        "Only committed indeterminate occurrences replay.",
      );
    }
    const { occurrence, schedule } = claim;
    const restore = (error: SidebandError): never => {
      this.finish(claim, {
        state: "indeterminate",
        operationId: occurrence.operationId,
        errorCode: error.code,
        errorMessage: error.message,
      });
      throw error;
    };
    const decision = await this.authorizeDispatch(claim, {
      bindingId: occurrence.bindingId as string,
      agentId: schedule.targetAgentId,
      generation: occurrence.bindingGeneration as number,
    });
    if (!decision.allowed) {
      restore(unauthorized(decision.reason, "The schedule is no longer authorized to dispatch."));
    }
    let result: HostOperationResult;
    try {
      result = await this.options.sideband.sendMessageToHost({
        principalId: schedule.ownerPrincipalId,
        idempotencyKey: operationKeyFor(occurrence),
        bindingId: occurrence.bindingId as string,
        messageId: occurrence.messageId as string,
        mode: schedule.deliveryMode,
        replayIndeterminate: true,
      });
    } catch (error) {
      if (error instanceof SidebandError) return restore(error);
      throw error;
    }
    return this.finish(
      claim,
      this.outcomeFor(result) ?? {
        state: "indeterminate",
        operationId: result.operation.operationId,
        errorCode: "HOST_OUTCOME_INDETERMINATE",
        errorMessage: "Another dispatch owner holds the operation.",
      },
    );
  }

  private finish(claim: ClaimedOccurrence, outcome: DispatchOutcome): RunDueResult {
    const finished = this.options.schedules.finishOccurrence({
      occurrenceId: claim.occurrence.occurrenceId,
      leaseEpoch: claim.occurrence.leaseEpoch,
      ...outcome,
    });
    return { occurrenceId: claim.occurrence.occurrenceId, state: outcome.state, finished };
  }

  private async authorizeDispatch(
    { occurrence, schedule }: ClaimedOccurrence,
    binding: DispatchBindingRef | null,
  ): Promise<ScheduleDispatchDecision> {
    try {
      return await this.options.authorizer.authorizeDispatch(
        this.dispatchRequest(occurrence, schedule, binding),
      );
    } catch {
      return { allowed: false, reason: "SCHEDULE_AUTHORIZER_ERROR", retryable: true };
    }
  }

  private dispatchRequest(
    occurrence: OccurrenceRecord,
    schedule: ScheduleRecord,
    binding: DispatchBindingRef | null,
  ): ScheduleDispatchAuthorizationRequest {
    return {
      scheduleId: schedule.scheduleId,
      occurrenceId: occurrence.occurrenceId,
      ownerPrincipalId: schedule.ownerPrincipalId,
      ownerAgentId: schedule.ownerAgentId,
      targetAgentId: schedule.targetAgentId,
      binding,
      pinned: { grantId: schedule.grantId, grantEpoch: schedule.grantEpoch },
      deliveryMode: schedule.deliveryMode,
    };
  }

  private blocked(
    claim: ClaimedOccurrence,
    errorCode: string,
    errorMessage: string,
    retryable = true,
  ): DispatchOutcome {
    return {
      state: "blocked",
      operationId: null,
      errorCode,
      errorMessage,
      retryAt: retryable ? this.retryAt(claim.occurrence.attempts) : null,
      ...(retryable ? {} : { suspendReason: errorCode }),
    };
  }

  /** True when the stored operation for this key may already have reached the host. */
  private mayHaveSent(occurrence: OccurrenceRecord, schedule: ScheduleRecord): boolean {
    if (occurrence.committedAt === null || occurrence.bindingId === null) return false;
    try {
      const operation = this.options.store.findOperationByIdempotency({
        principalId: schedule.ownerPrincipalId,
        idempotencyKey: operationKeyFor(occurrence),
        kind: "send",
        request: {
          bindingId: occurrence.bindingId,
          messageId: occurrence.messageId,
          mode: schedule.deliveryMode,
        },
      });
      return operation !== null && operation.stage !== "queued";
    } catch {
      return true;
    }
  }

  private async dispatch(claim: ClaimedOccurrence): Promise<DispatchOutcome | null> {
    const { occurrence, schedule } = claim;
    // Past the linearization point and possibly sent: never re-authorize or retarget; the
    // idempotent send returns the recorded outcome (indeterminate after a crash).
    if (this.mayHaveSent(occurrence, schedule)) {
      return this.send(claim, occurrence.bindingId as string, operationKeyFor(occurrence));
    }
    let binding: AgentBinding | null = null;
    let unboundCode = "TARGET_UNBOUND";
    try {
      binding = this.options.store.getActiveBinding(schedule.targetAgentId);
    } catch (error) {
      if (!(error instanceof SidebandError)) throw error;
      if (error.code !== "BINDING_NOT_FOUND") unboundCode = error.code;
    }
    if (binding !== null) {
      const capabilities = await this.options.sideband.hostAdapter(binding.adapter).capabilities();
      if (needsContext(schedule.deliveryMode) && !capabilities.context) {
        return this.blocked(
          claim,
          "CONTEXT_INJECTION_UNSUPPORTED",
          `Adapter ${binding.adapter} cannot inject context; the wake was not sent.`,
        );
      }
      if (needsWake(schedule.deliveryMode) && !capabilities.wake) {
        return this.blocked(
          claim,
          "ADAPTER_CAPABILITY_UNAVAILABLE",
          `Adapter ${binding.adapter} cannot wake an agent.`,
        );
      }
    }
    const route: DispatchBindingRef | null =
      binding === null
        ? null
        : {
            bindingId: binding.bindingId,
            agentId: binding.agentId,
            generation: binding.generation,
          };
    const request = this.dispatchRequest(occurrence, schedule, route);
    const commit = (decide: () => MaybePromise<ScheduleDispatchDecision>): DispatchCommit =>
      this.options.schedules.commitDispatch({
        occurrenceId: occurrence.occurrenceId,
        leaseEpoch: occurrence.leaseEpoch,
        binding: route,
        unboundCode,
        decide,
      });
    let committed = commit(() => {
      try {
        const decision = this.options.authorizer.authorizeDispatch(request);
        return decision instanceof Promise
          ? decision.catch(() => ({
              allowed: false,
              reason: "SCHEDULE_AUTHORIZER_ERROR",
              retryable: true,
            }))
          : decision;
      } catch {
        return { allowed: false, reason: "SCHEDULE_AUTHORIZER_ERROR", retryable: true };
      }
    });
    if (committed.kind === "deferred") {
      const settled = await committed.decision;
      committed = commit(() => settled);
    }
    switch (committed.kind) {
      case "stale":
        return null;
      case "suppressed":
        return null;
      case "deferred":
        return null;
      case "denied":
        return this.blocked(
          claim,
          committed.decision.reason,
          committed.decision.retryable
            ? "Dispatch is not currently possible; it will be retried."
            : "Dispatch authorization was permanently denied; nothing was sent.",
          committed.decision.retryable,
        );
      case "committed":
        return this.send(claim, route?.bindingId as string, committed.operationKey);
    }
  }

  private async send(
    claim: ClaimedOccurrence,
    bindingId: string,
    operationKey: string,
  ): Promise<DispatchOutcome | null> {
    const { schedule } = claim;
    const occurrence = this.options.schedules.getOccurrenceRecord(claim.occurrence.occurrenceId);
    let result: HostOperationResult;
    try {
      result = await this.options.sideband.sendMessageToHost({
        principalId: schedule.ownerPrincipalId,
        idempotencyKey: operationKey,
        bindingId,
        messageId: occurrence.messageId as string,
        mode: schedule.deliveryMode,
      });
    } catch (error) {
      if (error instanceof SidebandError) {
        // These checks run before the operation begins, so nothing reached the host.
        if (
          error.code === "ADAPTER_CAPABILITY_UNAVAILABLE" ||
          error.code === "BINDING_CONFLICT" ||
          error.code === "BINDING_NOT_FOUND"
        ) {
          return this.blocked(claim, error.code, error.message);
        }
        return {
          state: "failed",
          operationId: null,
          errorCode: error.code,
          errorMessage: error.message,
        };
      }
      return {
        state: "indeterminate",
        operationId: null,
        errorCode: "HOST_OUTCOME_INDETERMINATE",
        errorMessage: "Host dispatch ended without a recorded receipt.",
      };
    }
    return this.outcomeFor(result, claim);
  }

  private outcomeFor(
    result: HostOperationResult,
    claim?: ClaimedOccurrence,
  ): DispatchOutcome | null {
    const operation = result.operation;
    const ok = (state: OccurrenceState): DispatchOutcome => ({
      state,
      operationId: operation.operationId,
      errorCode: null,
      errorMessage: null,
    });
    switch (operation.stage) {
      case "accepted":
        return ok("host_accepted");
      case "adopted":
        return ok("host_adopted");
      case "observed":
        return ok("observed");
      case "failed": {
        const errorCode = operation.errorCode ?? "HOST_REJECTED";
        const errorMessage = operation.errorMessage ?? "Host rejected the dispatch.";
        // A definitive no-effect failure the adapter marked retryable gets a fresh attempt later.
        if (claim !== undefined && operation.detail.retryable === true) {
          return {
            state: "queued",
            operationId: operation.operationId,
            errorCode,
            errorMessage,
            retryAt: this.retryAt(claim.occurrence.attempts),
            nextAttempt: true,
          };
        }
        return { state: "failed", operationId: operation.operationId, errorCode, errorMessage };
      }
      case "indeterminate":
        return {
          state: "indeterminate",
          operationId: operation.operationId,
          errorCode: operation.errorCode ?? "HOST_OUTCOME_INDETERMINATE",
          errorMessage: operation.errorMessage ?? "Host outcome is unknown.",
        };
      default:
        // Another owner holds the dispatch. Leave the lease to expire so a replay can resolve it.
        return null;
    }
  }
}
