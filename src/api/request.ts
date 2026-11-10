import type { FastifyRequest } from "fastify";

import type { PageRequest } from "../core/types.js";
import { ApiError, invalidArgument } from "./errors.js";

export type JsonObject = Record<string, unknown>;

/**
 * Identity is always stamped from the credential. A payload that tries to name the sender,
 * actor or owner is rejected outright rather than silently ignored, so a confused or hostile
 * caller learns that the field has no effect.
 */
export const IDENTITY_FIELDS: readonly string[] = [
  "fromAgentId",
  "senderAgentId",
  "actorAgentId",
  "actorPrincipalId",
  "principalId",
  "ownerAgentId",
  "ownerPrincipalId",
  "authenticatedPrincipalId",
  "provenance",
  "source",
  "sourceInstanceId",
  "trust",
];

export function rejectIdentityFields(body: JsonObject, extra: readonly string[] = []): void {
  for (const field of [...IDENTITY_FIELDS, ...extra]) {
    if (Object.hasOwn(body, field)) {
      throw new ApiError(
        "IDENTITY_FIELD_REJECTED",
        422,
        `${field} is derived from the credential and cannot be supplied.`,
        { details: { field } },
      );
    }
  }
}

export function objectBody(request: FastifyRequest): JsonObject {
  if (request.body === undefined || request.body === null) return {};
  if (typeof request.body !== "object" || Array.isArray(request.body)) {
    throw invalidArgument("Request body must be a JSON object.");
  }
  return request.body as JsonObject;
}

export function requiredObjectBody(request: FastifyRequest): JsonObject {
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw invalidArgument("Request body must be a JSON object.");
  }
  return request.body as JsonObject;
}

export function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidArgument(`${name} must be a non-empty string.`, { field: name });
  }
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, name);
}

export function numberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidArgument(`${name} must be a finite number.`, { field: name });
  }
  return value;
}

export function integerValue(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalidArgument(`${name} must be an integer from ${min} to ${max}.`, { field: name });
  }
  return value;
}

export function recordValue(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument(`${name} must be a JSON object.`, { field: name });
  }
  return value as Readonly<Record<string, unknown>>;
}

export function stringArray(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw invalidArgument(`${name} must be an array of non-empty strings.`, { field: name });
  }
  return value as string[];
}

export function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (Array.isArray(value)) throw invalidArgument("Idempotency-Key must have one value.");
  if (typeof value !== "string" || value.length === 0) {
    throw invalidArgument("An Idempotency-Key header is required for this mutation.", {
      field: "Idempotency-Key",
    });
  }
  return value;
}

export function pageRequest(query: Record<string, unknown>): PageRequest {
  const after = optionalString(query.after, "after");
  let limit: number | undefined;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw invalidArgument("limit must be an integer from 1 to 200.");
    }
  }
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Cursor pagination over an already-ordered list keyed by a stable id. */
export function pageItems<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  page: PageRequest,
  defaultLimit = 50,
): { items: T[]; next: string | null } {
  let start = 0;
  if (page.after !== undefined) {
    const index = items.findIndex((item) => idOf(item) === page.after);
    if (index === -1) throw invalidArgument("after does not name an item in this collection.");
    start = index + 1;
  }
  const limit = page.limit ?? defaultLimit;
  const slice = items.slice(start, start + limit);
  const hasMore = start + limit < items.length;
  const last = slice.at(-1);
  return { items: slice, next: hasMore && last !== undefined ? idOf(last) : null };
}
