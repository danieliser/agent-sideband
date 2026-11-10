import type { FastifyReply } from "fastify";

import { SidebandError } from "../core/errors.js";

/**
 * Error raised by the HTTP surface itself. Core and identity services keep throwing
 * SidebandError; both are rendered as `{ error: { code, message, details, retryable } }`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(
    code: string,
    status: number,
    message: string,
    options: { details?: Readonly<Record<string, unknown>>; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export function invalidArgument(message: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError("INVALID_ARGUMENT", 422, message, { details });
}

export function forbidden(message: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError("FORBIDDEN", 403, message, { details });
}

export function unauthenticated(): ApiError {
  return new ApiError("UNAUTHORIZED", 401, "A valid, unexpired bearer credential is required.");
}

const NOT_FOUND = new Set([
  "AGENT_NOT_FOUND",
  "TEAM_NOT_FOUND",
  "TEAM_PARENT_NOT_FOUND",
  "CHANNEL_NOT_FOUND",
  "MESSAGE_NOT_FOUND",
  "BINDING_NOT_FOUND",
  "OPERATION_NOT_FOUND",
  "ADAPTER_NOT_FOUND",
  "SCHEDULE_NOT_FOUND",
  "HOST_SESSION_NOT_FOUND",
  "CONNECTOR_NOT_FOUND",
]);

const CONFLICT = new Set([
  "AGENT_CONFLICT",
  "TEAM_CONFLICT",
  "TEAM_PARENT_CYCLE",
  "CHANNEL_CONFLICT",
  "BINDING_CONFLICT",
  "MESSAGE_CLAIM_CONFLICT",
  "MESSAGE_DELIVERY_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "CREDENTIAL_ALREADY_ISSUED",
  "STALE_GENERATION",
]);

const UNPROCESSABLE = new Set([
  "INVALID_ARGUMENT",
  "CONTEXT_INJECTION_UNSUPPORTED",
  "ADAPTER_CAPABILITY_UNAVAILABLE",
]);

interface RenderedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
}

/** Token-shaped strings are scrubbed from details as a last line of defense. */
const SECRET_PATTERN = /sb[act]t_[A-Za-z0-9_-]+/g;

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(SECRET_PATTERN, "[REDACTED]");
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrub(item, depth + 1)]),
  );
}

function statusForCode(code: string): number {
  if (code === "UNAUTHORIZED") return 403;
  if (NOT_FOUND.has(code)) return 404;
  if (CONFLICT.has(code)) return 409;
  if (UNPROCESSABLE.has(code)) return 422;
  if (code === "ADAPTER_UNAVAILABLE" || code === "SCHEDULER_UNAVAILABLE") return 503;
  return 400;
}

export function renderError(error: unknown): RenderedError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      retryable: error.retryable,
    };
  }
  if (error instanceof SidebandError) {
    const code: string = error.code;
    // A core authorization failure happens after authentication succeeded: the caller is known
    // but not permitted, so it is a 403 FORBIDDEN rather than a credential failure.
    const status = statusForCode(code);
    return {
      status,
      code: code === "UNAUTHORIZED" ? "FORBIDDEN" : code,
      message: error.message,
      details: error.details,
      retryable: status === 503,
    };
  }
  const fastifyError = error as { statusCode?: unknown; code?: unknown };
  if (
    typeof fastifyError.statusCode === "number" &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500
  ) {
    return {
      status: fastifyError.statusCode,
      code: fastifyError.statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
      message: "The request could not be parsed.",
      details: {},
      retryable: false,
    };
  }
  return {
    status: 500,
    code: "INTERNAL",
    message: "Agent Sideband hit an internal error.",
    details: {},
    retryable: true,
  };
}

export function sendError(error: unknown, reply: FastifyReply): FastifyReply {
  const rendered = renderError(error);
  return reply.status(rendered.status).send({
    error: {
      code: rendered.code,
      message: String(scrub(rendered.message)),
      details: scrub(rendered.details),
      retryable: rendered.retryable,
    },
  });
}
