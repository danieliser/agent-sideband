import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  agentApiGrants,
  bearerToken,
  connectorApiGrants,
  type ApiGrant,
  type AuthenticatedPrincipal,
  type SidebandAuthenticator,
} from "./auth.js";
import {
  registerDeliveryCredentialRoutes,
  type DeliveryCredentialVault,
} from "./delivery-credentials.js";
import { forbidden } from "./errors.js";
import {
  idempotencyKey,
  integerValue,
  objectBody,
  optionalString,
  rejectIdentityFields,
  requiredObjectBody,
  stringArray,
  stringValue,
} from "./request.js";

/** Non-secret view of a provisioned agent credential, as resolved by the identity service. */
export interface ResolvedAgentAccess {
  readonly principalId: string;
  readonly agentId: string;
  readonly hostSessionId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
  readonly grants: ReadonlySet<string>;
  readonly expiresAt?: string;
}

export interface ResolvedConnector {
  readonly kind?: string;
  readonly principalId?: string;
  readonly adapter: string;
  readonly hostInstanceId: string;
}

/** A once-returned credential. Other non-secret fields are passed through untouched. */
export interface IssuedSecret {
  readonly token: string;
}

export interface HostSessionRegistrationInput {
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
  readonly providerSessionId: string;
  readonly hostEpoch: string;
  readonly leaseSeconds: number;
  readonly requestedAgentId?: string;
  readonly parentAgentId?: string;
  readonly displayName?: string;
}

/**
 * The slice of the durable identity service the HTTP surface needs. Principal handles are
 * opaque: they are produced by the service and handed back to it unchanged for re-verification.
 */
export interface SidebandIdentityApi {
  resolveBearer(token: string): ResolvedAgentAccess | null;
  resolveConnector(token: string): ResolvedConnector | null;
  enrollConnector(
    operator: unknown,
    input: {
      adapter: string;
      hostInstanceId: string;
      allowedAgentIds?: readonly string[];
      expiresAt?: string;
    },
  ): IssuedSecret;
  rotateConnector(
    operator: unknown,
    input: { adapter: string; hostInstanceId: string; rotationId: string },
  ): IssuedSecret;
  revokeConnector(
    operator: unknown,
    input: { adapter: string; hostInstanceId: string; reason: string },
  ): unknown;
  restoreAccess(operator: unknown, input: { agentId: string }): unknown;
  revokeAccess(operator: unknown, input: { agentId: string; reason: string }): unknown;
  grantScheduleTarget(
    operator: unknown,
    input: { ownerAgentId: string; targetAgentId: string },
  ): unknown;
  revokeScheduleGrant(
    operator: unknown,
    input: { ownerAgentId: string; targetAgentId: string; reason?: string },
  ): unknown;
  provision(connector: unknown, input: HostSessionRegistrationInput, key: string): IssuedSecret;
  heartbeat(
    connector: unknown,
    input: { hostSessionId: string; hostEpoch: string; leaseSeconds: number },
  ): unknown;
  rotate(
    connector: unknown,
    input: { hostSessionId: string; hostEpoch: string; rotationId: string },
  ): IssuedSecret;
  revoke(
    connector: unknown,
    input: { hostSessionId: string; reason: string },
    key: string,
  ): unknown;
  markOffline(
    connector: unknown,
    input: { hostSessionId: string; reason: string },
    key: string,
  ): unknown;
}

export const AGENT_TOKEN_PREFIX = "sbat_";
export const CONNECTOR_TOKEN_PREFIX = "sbct_";
const KNOWN_GRANTS: ReadonlySet<string> = new Set<ApiGrant>([...agentApiGrants]);

/**
 * Resolves provisioned agent (`sbat_`) and host connector (`sbct_`) credentials. Agent grants are
 * intersected with the agent grant set, so the identity service can never widen API authority.
 */
export function identityAuthenticator(
  identity: Pick<SidebandIdentityApi, "resolveBearer" | "resolveConnector">,
): SidebandAuthenticator {
  return (request) => {
    const token = bearerToken(request);
    if (token === null) return null;
    if (token.startsWith(AGENT_TOKEN_PREFIX)) {
      const access = identity.resolveBearer(token);
      if (access === null) return null;
      return {
        kind: "agent",
        principalId: access.principalId,
        agentId: access.agentId,
        source: "http",
        sourceInstanceId: `${access.adapter}:${access.hostInstanceId}`,
        grants: new Set(
          [...access.grants].filter((grant) => KNOWN_GRANTS.has(grant)),
        ) as Set<ApiGrant>,
        session: {
          hostSessionId: access.hostSessionId,
          bindingId: access.bindingId,
          generation: access.generation,
          adapter: access.adapter,
          hostInstanceId: access.hostInstanceId,
          externalId: access.externalId,
          ...(access.expiresAt === undefined ? {} : { expiresAt: access.expiresAt }),
        },
        handle: access,
      } satisfies AuthenticatedPrincipal;
    }
    if (token.startsWith(CONNECTOR_TOKEN_PREFIX)) {
      const connector = identity.resolveConnector(token);
      if (connector === null) return null;
      return {
        kind: "connector",
        principalId:
          connector.principalId ?? `connector:${connector.adapter}:${connector.hostInstanceId}`,
        agentId: null,
        source: "http",
        sourceInstanceId: `${connector.adapter}:${connector.hostInstanceId}`,
        grants: connectorApiGrants,
        handle: connector,
      } satisfies AuthenticatedPrincipal;
    }
    return null;
  };
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store");
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  identity: SidebandIdentityApi,
  options: {
    readonly publicUrl?: string;
    /** In-memory host delivery credentials, dropped whenever their session changes. */
    readonly deliveryCredentials?: DeliveryCredentialVault;
    readonly requireGrant: (
      request: FastifyRequest,
      ...grants: ApiGrant[]
    ) => AuthenticatedPrincipal;
  },
): void {
  const apiUrl = options.publicUrl === undefined ? {} : { apiUrl: options.publicUrl };
  const vault = options.deliveryCredentials;

  function connector(request: FastifyRequest): unknown {
    const principal = options.requireGrant(request, "hosts:connect");
    if (principal.kind !== "connector" || principal.handle === undefined) {
      throw forbidden("Host session routes require a trusted host connector credential.");
    }
    return principal.handle;
  }

  function operator(request: FastifyRequest): unknown {
    const principal = options.requireGrant(request, "hosts:manage");
    if (principal.kind !== "operator" || principal.handle === undefined) {
      throw forbidden("Connector management requires the local operator credential.");
    }
    return principal.handle;
  }

  app.post("/v1/host-sessions", async (request, reply) => {
    const handle = connector(request);
    const scope = handle as ResolvedConnector;
    const key = idempotencyKey(request);
    const body = requiredObjectBody(request);
    rejectIdentityFields(body, ["agentId", "token", "grants"]);
    const requestedAgentId = optionalString(body.requestedAgentId, "requestedAgentId");
    const parentAgentId = optionalString(body.parentAgentId, "parentAgentId");
    const displayName = optionalString(body.displayName, "displayName");
    const issued = identity.provision(
      handle,
      {
        // The connector's own scope is the default; a mismatching value is refused by the service.
        adapter: optionalString(body.adapter, "adapter") ?? scope.adapter,
        hostInstanceId:
          optionalString(body.hostInstanceId, "hostInstanceId") ?? scope.hostInstanceId,
        externalId: stringValue(body.externalId, "externalId"),
        providerSessionId: stringValue(body.providerSessionId, "providerSessionId"),
        hostEpoch: stringValue(body.hostEpoch, "hostEpoch"),
        leaseSeconds:
          body.leaseSeconds === undefined
            ? 60
            : integerValue(body.leaseSeconds, "leaseSeconds", 10, 3600),
        ...(requestedAgentId === undefined ? {} : { requestedAgentId }),
        ...(parentAgentId === undefined ? {} : { parentAgentId }),
        ...(displayName === undefined ? {} : { displayName }),
      },
      key,
    );
    // A new generation for the tuple never inherits the previous generation's delivery secret.
    const issuedSessionId = (issued as { hostSessionId?: unknown }).hostSessionId;
    if (typeof issuedSessionId === "string") vault?.drop(issuedSessionId);
    return noStore(reply)
      .status(201)
      .send({ ...issued, ...apiUrl });
  });

  if (vault !== undefined) registerDeliveryCredentialRoutes(app, vault, connector);

  app.post<{ Params: { hostSessionId: string } }>(
    "/v1/host-sessions/:hostSessionId/heartbeat",
    async (request) => {
      const handle = connector(request);
      const body = requiredObjectBody(request);
      const lease = identity.heartbeat(handle, {
        hostSessionId: request.params.hostSessionId,
        hostEpoch: stringValue(body.hostEpoch, "hostEpoch"),
        leaseSeconds:
          body.leaseSeconds === undefined
            ? 60
            : integerValue(body.leaseSeconds, "leaseSeconds", 10, 3600),
      });
      if (vault === undefined || !vault.supported) return lease;
      // Lets the host re-push after a daemon restart instead of waiting for credential expiry.
      return {
        ...(lease as Record<string, unknown>),
        deliveryCredential: vault.isHeld(request.params.hostSessionId) ? "held" : "missing",
      };
    },
  );

  app.post<{ Params: { hostSessionId: string } }>(
    "/v1/host-sessions/:hostSessionId/rotate",
    async (request, reply) => {
      const handle = connector(request);
      const body = requiredObjectBody(request);
      const issued = identity.rotate(handle, {
        hostSessionId: request.params.hostSessionId,
        hostEpoch: stringValue(body.hostEpoch, "hostEpoch"),
        rotationId: stringValue(body.rotationId, "rotationId"),
      });
      return noStore(reply)
        .status(201)
        .send({ ...issued, ...apiUrl });
    },
  );

  for (const action of ["revoke", "offline"] as const) {
    app.post<{ Params: { hostSessionId: string } }>(
      `/v1/host-sessions/:hostSessionId/${action}`,
      async (request) => {
        const handle = connector(request);
        const key = idempotencyKey(request);
        const body = objectBody(request);
        const input = {
          hostSessionId: request.params.hostSessionId,
          reason:
            optionalString(body.reason, "reason") ?? (action === "revoke" ? "revoked" : "offline"),
        };
        const result =
          action === "revoke"
            ? identity.revoke(handle, input, key)
            : identity.markOffline(handle, input, key);
        vault?.drop(input.hostSessionId);
        return (
          result ?? {
            hostSessionId: input.hostSessionId,
            status: action === "revoke" ? "revoked" : "offline",
          }
        );
      },
    );
  }

  app.post("/v1/connectors", async (request, reply) => {
    const handle = operator(request);
    const body = requiredObjectBody(request);
    const allowedAgentIds = stringArray(body.allowedAgentIds, "allowedAgentIds");
    const expiresAt = optionalString(body.expiresAt, "expiresAt");
    const issued = identity.enrollConnector(handle, {
      adapter: stringValue(body.adapter, "adapter"),
      hostInstanceId: stringValue(body.hostInstanceId, "hostInstanceId"),
      ...(allowedAgentIds === undefined ? {} : { allowedAgentIds }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return noStore(reply).status(201).send(issued);
  });

  app.post("/v1/connectors/rotate", async (request, reply) => {
    const handle = operator(request);
    const body = requiredObjectBody(request);
    const issued = identity.rotateConnector(handle, {
      adapter: stringValue(body.adapter, "adapter"),
      hostInstanceId: stringValue(body.hostInstanceId, "hostInstanceId"),
      rotationId: stringValue(body.rotationId, "rotationId"),
    });
    vault?.sweep();
    return noStore(reply).status(201).send(issued);
  });

  app.post("/v1/connectors/revoke", async (request) => {
    const handle = operator(request);
    const body = requiredObjectBody(request);
    const input = {
      adapter: stringValue(body.adapter, "adapter"),
      hostInstanceId: stringValue(body.hostInstanceId, "hostInstanceId"),
      reason: optionalString(body.reason, "reason") ?? "revoked",
    };
    identity.revokeConnector(handle, input);
    vault?.sweep();
    return { adapter: input.adapter, hostInstanceId: input.hostInstanceId, status: "revoked" };
  });

  app.post<{ Params: { agentId: string } }>(
    "/v1/agents/:agentId/access/restore",
    async (request) => {
      const handle = operator(request);
      identity.restoreAccess(handle, { agentId: request.params.agentId });
      return { agentId: request.params.agentId, status: "restored" };
    },
  );

  app.post<{ Params: { agentId: string } }>(
    "/v1/agents/:agentId/access/revoke",
    async (request) => {
      const handle = operator(request);
      const body = objectBody(request);
      identity.revokeAccess(handle, {
        agentId: request.params.agentId,
        reason: optionalString(body.reason, "reason") ?? "revoked by operator",
      });
      vault?.sweep();
      return { agentId: request.params.agentId, status: "revoked" };
    },
  );

  // Explicit owner-to-target schedule authority, e.g. a lead waking a child agent.
  for (const action of ["grant", "revoke"] as const) {
    app.post(`/v1/schedule-grants${action === "grant" ? "" : "/revoke"}`, async (request) => {
      const handle = operator(request);
      const body = requiredObjectBody(request);
      const input = {
        ownerAgentId: stringValue(body.ownerAgentId, "ownerAgentId"),
        targetAgentId: stringValue(body.targetAgentId, "targetAgentId"),
      };
      if (action === "grant") {
        identity.grantScheduleTarget(handle, input);
      } else {
        const reason = optionalString(body.reason, "reason");
        identity.revokeScheduleGrant(handle, {
          ...input,
          ...(reason === undefined ? {} : { reason }),
        });
      }
      return { ...input, status: action === "grant" ? "granted" : "revoked" };
    });
  }
}
