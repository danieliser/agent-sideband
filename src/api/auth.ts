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
  | "events:read";

export interface AuthenticatedPrincipal {
  readonly principalId: string;
  readonly agentId: string | null;
  readonly source: ProvenanceSource;
  readonly sourceInstanceId: string | null;
  readonly grants: ReadonlySet<ApiGrant>;
}

export type SidebandAuthenticator = (
  request: FastifyRequest,
) => AuthenticatedPrincipal | null | Promise<AuthenticatedPrincipal | null>;

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function staticBearerAuthenticator(input: {
  readonly token: string;
  readonly principal: AuthenticatedPrincipal;
}): SidebandAuthenticator {
  return (request) => {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return null;
    return equalSecret(header.slice("Bearer ".length), input.token) ? input.principal : null;
  };
}

export const allApiGrants: ReadonlySet<ApiGrant> = new Set([
  "admin",
  "agents:read",
  "agents:write",
  "messages:read",
  "messages:write",
  "lifecycle:control",
  "events:read",
]);
