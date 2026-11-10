import { SidebandError } from "../core/errors.js";
import { validateIdentifier } from "../store/sqlite.js";

export const MAX_DUE_MS = 8.64e15;
export const CRON_GRACE_MS = 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CRON_HORIZON_MINUTES = 8 * 366 * 24 * 60;

export type TimeTrigger =
  | { readonly type: "after"; readonly delaySeconds: number }
  | { readonly type: "at"; readonly at: string }
  | { readonly type: "interval"; readonly everySeconds: number; readonly startAt?: string }
  | { readonly type: "cron"; readonly expression: string; readonly timezone?: string }
  | { readonly type: "event"; readonly eventName: string };

export type NormalizedTrigger =
  | { readonly type: "at"; readonly at: string }
  | { readonly type: "interval"; readonly everySeconds: number; readonly startAt: string }
  | { readonly type: "cron"; readonly expression: string; readonly timezone: string }
  | { readonly type: "event"; readonly eventName: string };

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new SidebandError("INVALID_ARGUMENT", message, details);
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

export function parseRfc3339(value: string, name: string): number {
  const match = RFC3339.exec(value);
  if (!match) invalid(`${name} must be an RFC 3339 timestamp with Z or an offset.`);
  const [, y, mo, d, h, mi, s, fraction, zone] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const millis = fraction ? Number(fraction.slice(1, 4).padEnd(3, "0")) : 0;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    invalid(`${name} has an out-of-range calendar or clock field.`);
  }
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) {
    invalid(`${name} is not a real calendar date.`);
  }
  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMins > 59) invalid(`${name} has an out-of-range offset.`);
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  const ms =
    Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * MINUTE_MS;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DUE_MS)
    invalid(`${name} is outside the supported range.`);
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${name} must be a positive safe integer.`);
  }
  return value;
}

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface CronFieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  readonly nameOffset?: number;
}

const CRON_FIELDS: readonly CronFieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { name: "day-of-week", min: 0, max: 6, names: DAY_NAMES, nameOffset: 0 },
];

export interface CronMatcher {
  readonly fields: readonly ReadonlySet<number>[];
}

function cronValue(token: string, spec: CronFieldSpec): number {
  if (/^\d+$/.test(token)) return Number(token);
  const index = spec.names?.indexOf(token.toUpperCase()) ?? -1;
  if (index === -1) invalid(`Cron ${spec.name} has an unknown value: ${token}.`);
  return index + (spec.nameOffset ?? 0);
}

function parseCronField(text: string, spec: CronFieldSpec): ReadonlySet<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) invalid(`Cron ${spec.name} has an invalid element: ${part}.`);
    const [, range, stepText] = match as unknown as [string, string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) invalid(`Cron ${spec.name} step must be at least one.`);
    let low: number;
    let high: number;
    if (range === "*") {
      low = spec.min;
      high = spec.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-") as [string, string];
      low = cronValue(a, spec);
      high = cronValue(b, spec);
    } else {
      low = cronValue(range, spec);
      high = stepText === undefined ? low : spec.max;
    }
    if (low < spec.min || high > spec.max || low > high) {
      invalid(`Cron ${spec.name} is out of range.`, { field: spec.name });
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronMatcher {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) invalid("Cron expression must have exactly five fields.");
  return {
    fields: CRON_FIELDS.map((spec, index) => parseCronField(parts[index] as string, spec)),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export function validateTimezone(timezone: string): string {
  if (timezone === "UTC") return timezone;
  try {
    zoneFormatter(timezone);
  } catch {
    invalid(`Unknown IANA timezone: ${timezone}.`);
  }
  return timezone;
}

interface LocalParts {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
}

function localParts(ms: number, timezone: string): LocalParts {
  if (timezone === "UTC") {
    const date = new Date(ms);
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay(),
    };
  }
  const values: Record<string, number> = {};
  for (const part of zoneFormatter(timezone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const year = values.year as number;
  const month = values.month as number;
  const day = values.day as number;
  return {
    minute: values.minute as number,
    hour: values.hour as number,
    day,
    month,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function matchesCron(matcher: CronMatcher, parts: LocalParts): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = matcher.fields as [
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
  ];
  return (
    minute.has(parts.minute) &&
    hour.has(parts.hour) &&
    dayOfMonth.has(parts.day) &&
    month.has(parts.month) &&
    dayOfWeek.has(parts.weekday)
  );
}

/**
 * An IANA local date is within two calendar days of its UTC date (even across
 * historical date-line changes). If none of that deliberately wide window can
 * match the calendar fields, no minute in this UTC day can match. Only skip
 * whole UTC days; matching days still use the exact timezone-aware minute scan
 * so DST gaps, folds and fractional offsets retain their original semantics.
 */
function utcDayCouldMatch(matcher: CronMatcher, utcDay: number): boolean {
  const [, , days, months, weekdays] = matcher.fields;
  for (let offset = -2; offset <= 2; offset += 1) {
    const date = new Date(utcDay + offset * DAY_MS);
    if (
      days?.has(date.getUTCDate()) &&
      months?.has(date.getUTCMonth() + 1) &&
      weekdays?.has(date.getUTCDay())
    )
      return true;
  }
  return false;
}

/** First UTC minute strictly after `afterMs` whose local wall clock matches; null past the search horizon. */
export function nextCronMatch(
  matcher: CronMatcher,
  timezone: string,
  afterMs: number,
): number | null {
  let candidate = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = Math.min(MAX_DUE_MS, candidate + CRON_HORIZON_MINUTES * MINUTE_MS);
  let checkedDay = Number.NaN;
  while (candidate < end) {
    if (candidate > MAX_DUE_MS) return null;
    const utcDay = Math.floor(candidate / DAY_MS) * DAY_MS;
    if (utcDay !== checkedDay) {
      checkedDay = utcDay;
      if (!utcDayCouldMatch(matcher, utcDay)) {
        candidate = utcDay + DAY_MS;
        continue;
      }
    }
    if (matchesCron(matcher, localParts(candidate, timezone))) return candidate;
    candidate += MINUTE_MS;
  }
  return null;
}

export function normalizeTrigger(
  trigger: TimeTrigger,
  nowMs: number,
): {
  readonly trigger: NormalizedTrigger;
  readonly firstDueMs: number | null;
} {
  switch (trigger.type) {
    case "after": {
      const delaySeconds = positiveSafeInteger(trigger.delaySeconds, "delaySeconds");
      const dueMs = nowMs + delaySeconds * 1000;
      if (dueMs > MAX_DUE_MS) invalid("delaySeconds overflows the supported time range.");
      return { trigger: { type: "at", at: toIso(dueMs) }, firstDueMs: dueMs };
    }
    case "at": {
      const dueMs = parseRfc3339(trigger.at, "at");
      return { trigger: { type: "at", at: toIso(dueMs) }, firstDueMs: dueMs };
    }
    case "interval": {
      const everySeconds = positiveSafeInteger(trigger.everySeconds, "everySeconds");
      const anchorMs =
        trigger.startAt === undefined
          ? nowMs + everySeconds * 1000
          : parseRfc3339(trigger.startAt, "startAt");
      if (anchorMs > MAX_DUE_MS) invalid("startAt is outside the supported range.");
      return {
        trigger: { type: "interval", everySeconds, startAt: toIso(anchorMs) },
        firstDueMs: anchorMs,
      };
    }
    case "cron": {
      if (typeof trigger.expression !== "string") invalid("Cron expression must be a string.");
      const timezone = validateTimezone(trigger.timezone ?? "UTC");
      const expression = trigger.expression.trim().split(/\s+/).join(" ");
      const matcher = parseCron(expression);
      const firstDueMs = nextCronMatch(matcher, timezone, nowMs);
      if (firstDueMs === null)
        invalid("Cron expression has no matching time within the search horizon.");
      return { trigger: { type: "cron", expression, timezone }, firstDueMs };
    }
    case "event": {
      const eventName = validateIdentifier(trigger.eventName, "eventName");
      return { trigger: { type: "event", eventName }, firstDueMs: null };
    }
    default:
      invalid("Unsupported trigger type.");
  }
}

/** Next nominal slot strictly after `afterMs` for interval and cron triggers; null for others. */
export function nextSlotAfter(trigger: NormalizedTrigger, afterMs: number): number | null {
  if (trigger.type === "interval") {
    const anchor = parseRfc3339(trigger.startAt, "startAt");
    const everyMs = trigger.everySeconds * 1000;
    if (afterMs < anchor) return anchor;
    return anchor + (Math.floor((afterMs - anchor) / everyMs) + 1) * everyMs;
  }
  if (trigger.type === "cron") {
    return nextCronMatch(parseCron(trigger.expression), trigger.timezone, afterMs);
  }
  return null;
}
