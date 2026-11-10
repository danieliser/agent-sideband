import { timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

import type { ProvenanceSource } from "../core/types.js";

export type ApiGrant =
  | "admin"
  | "agents:read"
  | "agents:write"
  | "messages:read"
  | "messages:write"
  | "lifecycle:control"
  | "events:read"
  // Narrow grants issued to provisioned agent credentials.
  | "identity:read"
  | "inbox:read"
  | "inbox:ack"
  | "messages:send"
  | "presence:write"
  | "schedules:create"
  | "schedules:read"
  | "schedules:cancel"
  // Trusted ingress and provisioning.
  | "schedules:events"
  | "hosts:manage"
  | "hosts:connect";

/**
 * operator: local management credential, never distributed to agent sessions.
 * agent: a provisioned per-session credential bound to one stable identity.
 * connector: a trusted host credential scoped to one adapter/host instance.
 */
export type PrincipalKind = "operator" | "agent" | "connector" | "service";

/** Non-secret description of the host session a provisioned credential is bound to. */
export interface PrincipalSession {
  readonly hostSessionId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
  readonly expiresAt?: string;
}

export interface AuthenticatedPrincipal {
  readonly principalId: string;
  readonly agentId: string | null;
  readonly source: ProvenanceSource;
  readonly sourceInstanceId: string | null;
  readonly grants: ReadonlySet<ApiGrant>;
  readonly kind?: PrincipalKind;
  readonly session?: PrincipalSession;
  /**
   * Opaque principal object issued by the identity service. Routes hand it back verbatim so the
   * service can re-verify it; it is never derived from request input.
   */
  readonly handle?: unknown;
}

export type SidebandAuthenticator = (
  request: FastifyRequest,
) => AuthenticatedPrincipal | null | Promise<AuthenticatedPrincipal | null>;

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length === 0 ? null : token;
}

export function staticBearerAuthenticator(input: {
  readonly token: string;
  readonly principal: AuthenticatedPrincipal;
}): SidebandAuthenticator {
  return (request) => {
    const token = bearerToken(request);
    return token !== null && equalSecret(token, input.token) ? input.principal : null;
  };
}

/** Tries each authenticator in order and returns the first principal. */
export function composeAuthenticators(
  ...authenticators: readonly SidebandAuthenticator[]
): SidebandAuthenticator {
  return async (request) => {
    for (const authenticate of authenticators) {
      const principal = await authenticate(request);
      if (principal !== null) return principal;
    }
    return null;
  };
}

export const allApiGrants: ReadonlySet<ApiGrant> = new Set<ApiGrant>([
  "admin",
  "agents:read",
  "agents:write",
  "messages:read",
  "messages:write",
  "lifecycle:control",
  "events:read",
  "identity:read",
  "inbox:read",
  "inbox:ack",
  "messages:send",
  "presence:write",
  "schedules:create",
  "schedules:read",
  "schedules:cancel",
  "schedules:events",
  "hosts:manage",
]);

/** The least-privilege set a provisioned agent session receives. */
export const agentApiGrants: ReadonlySet<ApiGrant> = new Set<ApiGrant>([
  "identity:read",
  "inbox:read",
  "inbox:ack",
  "messages:send",
  "presence:write",
  "schedules:create",
  "schedules:read",
  "schedules:cancel",
]);

/** A trusted host connector may provision its own sessions and publish named events. */
export const connectorApiGrants: ReadonlySet<ApiGrant> = new Set<ApiGrant>([
  "hosts:connect",
  "schedules:events",
]);
