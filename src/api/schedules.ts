import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Scheduler } from "../scheduling/scheduler.js";
import type {
  DeliveryMode,
  OccurrenceRecord,
  ScheduleRecord,
  SqliteScheduleStore,
} from "../scheduling/store.js";
import type { TimeTrigger } from "../scheduling/triggers.js";
import type { ApiGrant, AuthenticatedPrincipal } from "./auth.js";
import { ApiError, forbidden, invalidArgument } from "./errors.js";
import {
  idempotencyKey,
  objectBody,
  optionalString,
  pageItems,
  pageRequest,
  recordValue,
  rejectIdentityFields,
  requiredObjectBody,
  stringValue,
} from "./request.js";

export interface SchedulingSurface {
  /** The scheduler's authorizer receives the authenticated principal as its caller. */
  readonly scheduler: Scheduler<AuthenticatedPrincipal>;
  readonly schedules: SqliteScheduleStore;
}

/**
 * Named-event matching in the scheduler core is scoped to the principal that owns the schedule,
 * and agents may not publish events. Until the core can match trusted host events to agent
 * subscriptions, agent-created event schedules would never fire, so they are refused here and
 * advertised as unavailable.
 */
export const AGENT_EVENT_SUBSCRIPTIONS = false;

const DELIVERY_MODES: ReadonlySet<string> = new Set<DeliveryMode>(["wake", "context", "both"]);
const ACCEPTED_STATES = new Set(["host_accepted", "host_adopted", "observed"]);

export interface ScheduleView {
  readonly scheduleId: string;
  readonly name: string;
  /** Null for operator-owned schedules. */
  readonly ownerAgentId: string | null;
  readonly targetAgentId: string;
  readonly trigger: ScheduleRecord["trigger"];
  readonly deliveryMode: DeliveryMode;
  readonly status: ScheduleRecord["status"];
  readonly body: string;
  readonly acceptedAt: string;
  readonly nextDueAt: string | null;
  readonly cancelledAt: string | null;
  readonly lastOccurrenceId: string | null;
}

export function scheduleView(schedule: ScheduleRecord): ScheduleView {
  return {
    scheduleId: schedule.scheduleId,
    name: schedule.name,
    ownerAgentId: schedule.ownerAgentId,
    targetAgentId: schedule.targetAgentId,
    trigger: schedule.trigger,
    deliveryMode: schedule.deliveryMode,
    status: schedule.status,
    body: schedule.body,
    acceptedAt: schedule.acceptedAt,
    nextDueAt: schedule.nextDueAt,
    cancelledAt: schedule.cancelledAt,
    lastOccurrenceId: schedule.lastOccurrenceId,
  };
}

export function occurrenceView(occurrence: OccurrenceRecord) {
  const late = Date.parse(occurrence.materializedAt) - Date.parse(occurrence.nominalDueAt);
  return {
    occurrenceId: occurrence.occurrenceId,
    scheduleId: occurrence.scheduleId,
    occurrenceKey: occurrence.occurrenceKey,
    nominalDueAt: occurrence.nominalDueAt,
    materializedAt: occurrence.materializedAt,
    lateSeconds: Number.isFinite(late) && late > 0 ? Math.floor(late / 1000) : 0,
    state: occurrence.state,
    messageId: occurrence.messageId,
    operationId: occurrence.operationId,
    attempts: occurrence.attempts,
    skippedSlots: occurrence.skippedSlots,
    error:
      occurrence.errorCode === null
        ? null
        : { code: occurrence.errorCode, message: occurrence.errorMessage },
  };
}

function triggerValue(value: unknown, principal: AuthenticatedPrincipal): TimeTrigger {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument(
      "trigger must be an object such as {type:'after',delaySeconds:1800} or {type:'at',at:'2026-10-09T13:00:00Z'}.",
      { field: "trigger" },
    );
  }
  const trigger = value as Record<string, unknown>;
  const needNumber = (field: string): number => {
    if (typeof trigger[field] !== "number") {
      throw invalidArgument(`trigger.${field} must be a number.`, { field: `trigger.${field}` });
    }
    return trigger[field];
  };
  switch (trigger.type) {
    case "after":
      return { type: "after", delaySeconds: needNumber("delaySeconds") };
    case "at":
      return { type: "at", at: stringValue(trigger.at, "trigger.at") };
    case "interval": {
      const startAt = optionalString(trigger.startAt, "trigger.startAt");
      return {
        type: "interval",
        everySeconds: needNumber("everySeconds"),
        ...(startAt === undefined ? {} : { startAt }),
      };
    }
    case "cron": {
      const timezone = optionalString(trigger.timezone, "trigger.timezone");
      return {
        type: "cron",
        expression: stringValue(trigger.expression, "trigger.expression"),
        ...(timezone === undefined ? {} : { timezone }),
      };
    }
    case "event":
      if (!AGENT_EVENT_SUBSCRIPTIONS && !principal.grants.has("schedules:events")) {
        throw invalidArgument("Named-event schedules are not available to agent credentials.", {
          field: "trigger.type",
          reason: "EVENT_SUBSCRIPTIONS_UNAVAILABLE",
        });
      }
      return { type: "event", eventName: stringValue(trigger.eventName, "trigger.eventName") };
    default:
      throw invalidArgument("trigger.type must be after, at, interval or cron.", {
        field: "trigger.type",
      });
  }
}

function canView(principal: AuthenticatedPrincipal, schedule: ScheduleRecord): boolean {
  return (
    principal.grants.has("admin") ||
    schedule.ownerPrincipalId === principal.principalId ||
    (principal.agentId !== null && schedule.targetAgentId === principal.agentId)
  );
}

export function registerScheduleRoutes(
  app: FastifyInstance,
  surface: SchedulingSurface,
  requireGrant: (request: FastifyRequest, ...grants: ApiGrant[]) => AuthenticatedPrincipal,
): void {
  const { scheduler, schedules } = surface;

  function visibleSchedule(principal: AuthenticatedPrincipal, scheduleId: string): ScheduleRecord {
    const notFound = () =>
      new ApiError("SCHEDULE_NOT_FOUND", 404, `Schedule not found: ${scheduleId}`);
    let schedule: ScheduleRecord;
    try {
      schedule = schedules.getSchedule(scheduleId);
    } catch {
      throw notFound();
    }
    // Schedules outside the caller's scope are indistinguishable from missing ones.
    if (!canView(principal, schedule)) throw notFound();
    return schedule;
  }

  app.post("/v1/schedules", async (request, reply) => {
    const principal = requireGrant(request, "schedules:create");
    if (principal.kind !== "agent" && principal.kind !== "operator") {
      throw forbidden("Only agent and operator credentials can create schedules.");
    }
    if (principal.kind === "agent" && principal.agentId === null) {
      throw forbidden("Schedules need a credential bound to an agent identity.");
    }
    const key = idempotencyKey(request);
    const body = requiredObjectBody(request);
    rejectIdentityFields(body);
    const deliveryMode = body.deliveryMode ?? "wake";
    if (typeof deliveryMode !== "string" || !DELIVERY_MODES.has(deliveryMode)) {
      throw invalidArgument("deliveryMode must be wake, context or both.", {
        field: "deliveryMode",
      });
    }
    const requestedTrigger = triggerValue(body.trigger, principal);
    const requestedTargetAgentId = optionalString(body.targetAgentId, "targetAgentId");
    if (principal.kind === "operator" && requestedTargetAgentId === undefined) {
      throw forbidden("Operator schedules need an explicit target agent.");
    }
    const targetAgentId = requestedTargetAgentId ?? principal.agentId!;
    const context = body.context === undefined ? undefined : recordValue(body.context, "context");
    const result = await scheduler.createSchedule({
      caller: principal,
      principalId: principal.principalId,
      idempotencyKey: key,
      ...(context === undefined ? {} : { context }),
      targetAgentId,
      name: optionalString(body.name, "name") ?? "Reminder",
      body: stringValue(body.body, "body"),
      trigger: requestedTrigger,
      deliveryMode: deliveryMode as DeliveryMode,
    });
    return reply.status(result.replayed ? 200 : 201).send({
      schedule: scheduleView(result.schedule),
      replayed: result.replayed,
      requestedTrigger,
      // Creation is a durable acceptance. Each due occurrence carries its own host receipt.
      receiptLevel: "scheduled",
    });
  });

  app.get<{ Querystring: Record<string, unknown> }>("/v1/schedules", async (request) => {
    const principal = requireGrant(request, "schedules:read");
    const status = optionalString(request.query.status, "status");
    const targetAgentId = optionalString(request.query.targetAgentId, "targetAgentId");
    const triggerType = optionalString(request.query.triggerType, "triggerType");
    const visible = schedules
      .listSchedules()
      .filter((schedule) => canView(principal, schedule))
      .filter((schedule) => status === undefined || schedule.status === status)
      .filter((schedule) => targetAgentId === undefined || schedule.targetAgentId === targetAgentId)
      .filter((schedule) => triggerType === undefined || schedule.trigger.type === triggerType);
    const page = pageItems(visible, (schedule) => schedule.scheduleId, pageRequest(request.query));
    return { items: page.items.map(scheduleView), next: page.next };
  });

  app.get<{ Params: { scheduleId: string } }>("/v1/schedules/:scheduleId", async (request) => {
    const principal = requireGrant(request, "schedules:read");
    const schedule = visibleSchedule(principal, request.params.scheduleId);
    const occurrences = schedules.listOccurrences(schedule.scheduleId);
    const latest =
      occurrences.find((occurrence) => occurrence.occurrenceId === schedule.lastOccurrenceId) ??
      occurrences.at(-1) ??
      null;
    return {
      ...scheduleView(schedule),
      latestOccurrence: latest === null ? null : occurrenceView(latest),
    };
  });

  app.get<{ Params: { scheduleId: string }; Querystring: Record<string, unknown> }>(
    "/v1/schedules/:scheduleId/occurrences",
    async (request) => {
      const principal = requireGrant(request, "schedules:read");
      const schedule = visibleSchedule(principal, request.params.scheduleId);
      const page = pageItems(
        schedules.listOccurrences(schedule.scheduleId),
        (occurrence) => occurrence.occurrenceId,
        pageRequest(request.query),
      );
      return { items: page.items.map(occurrenceView), next: page.next };
    },
  );

  app.post<{ Params: { scheduleId: string } }>(
    "/v1/schedules/:scheduleId/cancel",
    async (request) => {
      const principal = requireGrant(request, "schedules:cancel");
      const key = idempotencyKey(request);
      rejectIdentityFields(objectBody(request));
      visibleSchedule(principal, request.params.scheduleId);
      const result = scheduler.cancelSchedule({
        caller: principal,
        principalId: principal.principalId,
        scheduleId: request.params.scheduleId,
        idempotencyKey: key,
      });
      const ids = (predicate: (occurrence: OccurrenceRecord) => boolean) =>
        result.occurrences.filter(predicate).map((occurrence) => occurrence.occurrenceId);
      return {
        schedule: scheduleView(result.schedule),
        replayed: result.replayed,
        suppressedOccurrenceIds: ids(
          (occurrence) =>
            occurrence.state === "cancelled" && occurrence.errorCode === "SCHEDULE_CANCELLED",
        ),
        inFlightOccurrenceIds: ids((occurrence) => occurrence.state === "dispatching"),
        alreadyAcceptedOccurrenceIds: ids((occurrence) => ACCEPTED_STATES.has(occurrence.state)),
      };
    },
  );

  app.post("/v1/schedule-events", async (request, reply) => {
    const principal = requireGrant(request, "schedules:events");
    const eventId = idempotencyKey(request);
    const body = requiredObjectBody(request);
    rejectIdentityFields(body);
    const eventName = stringValue(body.eventName, "eventName");
    const result = scheduler.emitEvent({
      principalId: principal.principalId,
      eventId,
      eventName,
      occurredAt: stringValue(body.occurredAt, "occurredAt"),
      payload: recordValue(body.payload, "payload"),
    });
    return reply.status(202).send({ eventId, eventName, ...result });
  });
}
