import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { HostAdapter } from "../core/host-adapter.js";
import { AgentSideband } from "../core/sideband.js";
import type { MessageClass, MessageTarget } from "../core/types.js";
import type { SidebandStore } from "../store/store.js";
import type { ApiGrant, AuthenticatedPrincipal, SidebandAuthenticator } from "./auth.js";
import { describeCapabilities, describePrincipal } from "./capabilities.js";
import type { DeliveryCredentialVault } from "./delivery-credentials.js";
import { forbidden, invalidArgument, renderError, sendError, unauthenticated } from "./errors.js";
import { registerIdentityRoutes, type SidebandIdentityApi } from "./identity.js";
import { registerMcpBridgeRoutes } from "./mcp.js";
import {
  idempotencyKey,
  numberValue,
  optionalString,
  pageRequest,
  recordValue,
  rejectIdentityFields,
  requiredObjectBody as objectBody,
  stringValue,
} from "./request.js";
import { registerScheduleRoutes, type SchedulingSurface } from "./schedules.js";

export interface AgentSidebandServerOptions {
  readonly sideband: AgentSideband;
  readonly store: SidebandStore;
  readonly authenticate: SidebandAuthenticator;
  readonly logger?: boolean;
  /** Enables the /v1/schedules surface. */
  readonly scheduling?: SchedulingSurface;
  /** Enables connector-only host-session provisioning and operator connector management. */
  readonly identity?: SidebandIdentityApi;
  /** In-memory host delivery credentials; enables the connector-only upload route. */
  readonly deliveryCredentials?: DeliveryCredentialVault;
  /** Adapters reported by /v1/capabilities. Reporting never requires an adapter to be online. */
  readonly adapters?: readonly HostAdapter[];
  /** Origin returned to provisioned sessions as apiUrl. */
  readonly publicUrl?: string;
  /** Extra non-secret status merged into /health. */
  readonly health?: () => Readonly<Record<string, unknown>>;
  /** Observes unexpected failures; clients only ever see a generic INTERNAL error. */
  readonly onInternalError?: (error: unknown) => void;
}

function targetValue(value: unknown): MessageTarget {
  const target = recordValue(value, "target");
  const type = stringValue(target.type, "target.type");
  const id = stringValue(target.id, "target.id");
  if (type !== "agent" && type !== "channel") {
    throw invalidArgument("target.type must be agent or channel.");
  }
  return { type, id };
}

const messageClasses = new Set<MessageClass>([
  "request",
  "informational",
  "completion",
  "steering",
  "reaction",
  "system",
]);

function messageClassValue(value: unknown): MessageClass {
  const result = stringValue(value, "messageClass") as MessageClass;
  if (!messageClasses.has(result)) throw invalidArgument("Unknown messageClass.");
  return result;
}

export function buildAgentSidebandServer(options: AgentSidebandServerOptions): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === true
        ? {
            redact: {
              paths: ["req.headers.authorization", "headers.authorization"],
              censor: "[REDACTED]",
            },
          }
        : false,
    bodyLimit: 1_100_000,
  });
  const principals = new WeakMap<FastifyRequest, AuthenticatedPrincipal>();

  function authenticated(request: FastifyRequest): AuthenticatedPrincipal {
    const principal = principals.get(request);
    if (principal === undefined) throw unauthenticated();
    return principal;
  }

  /** Passes when the credential holds any one of the listed grants. */
  function requireGrant(request: FastifyRequest, ...grants: ApiGrant[]): AuthenticatedPrincipal {
    const principal = authenticated(request);
    if (!grants.some((grant) => principal.grants.has(grant))) {
      throw forbidden(`This credential lacks the ${grants.join(" or ")} grant.`, { grants });
    }
    return principal;
  }

  function requireAgent(request: FastifyRequest, ...grants: ApiGrant[]) {
    const principal = requireGrant(request, ...grants);
    if (principal.agentId === null) throw forbidden("Credential is not bound to an agent.");
    return { ...principal, agentId: principal.agentId };
  }

  function requireOwnAgent(request: FastifyRequest, agentId: string): AuthenticatedPrincipal {
    const principal = requireGrant(request, "messages:read", "inbox:read");
    if (principal.agentId !== agentId && !principal.grants.has("admin")) {
      throw forbidden("Credentials are not bound to this agent.");
    }
    return principal;
  }

  const capabilityContext = {
    sideband: options.sideband,
    store: options.store,
    adapters: options.adapters ?? [],
    schedulingAvailable: options.scheduling !== undefined,
    identityAvailable: options.identity !== undefined,
  };

  app.addHook("onRequest", async (request) => {
    if (request.url === "/health") return;
    const principal = await options.authenticate(request);
    if (principal === null) throw unauthenticated();
    principals.set(request, principal);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (renderError(error).status >= 500) options.onInternalError?.(error);
    return sendError(error, reply);
  });
  app.get("/health", async () => ({
    status: "ok",
    service: "agent-sideband",
    version: 1,
    ...(options.health?.() ?? {}),
  }));

  app.get("/v1/capabilities", async (request) =>
    describeCapabilities(capabilityContext, authenticated(request)),
  );
  app.get("/v1/me", async (request) =>
    describePrincipal(capabilityContext, authenticated(request)),
  );
  if (options.scheduling !== undefined) {
    registerScheduleRoutes(app, options.scheduling, requireGrant);
  }
  if (options.identity !== undefined) {
    registerIdentityRoutes(app, options.identity, {
      requireGrant,
      ...(options.deliveryCredentials === undefined
        ? {}
        : { deliveryCredentials: options.deliveryCredentials }),
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
  }

  registerMcpBridgeRoutes(app, { authenticated });

  app.put<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request) => {
    const principal = requireGrant(request, "agents:write");
    const body = objectBody(request);
    const displayName = optionalString(body.displayName, "displayName");
    return options.store.registerAgent({
      agentId: request.params.agentId,
      ...(displayName === undefined ? {} : { displayName }),
      actorPrincipalId: principal.principalId,
    });
  });

  app.get<{ Querystring: Record<string, unknown> }>("/v1/agents", async (request) => {
    requireGrant(request, "agents:read", "identity:read");
    return options.store.pageAgents(pageRequest(request.query));
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request) => {
    requireGrant(request, "agents:read", "identity:read");
    return options.store.getAgent(request.params.agentId);
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId/presence", async (request) => {
    requireGrant(request, "agents:read", "identity:read");
    return options.store.getPresence(request.params.agentId);
  });

  app.post("/v1/presence/heartbeat", async (request) => {
    const principal = requireAgent(request, "messages:read", "presence:write");
    const body = objectBody(request);
    rejectIdentityFields(body, ["agentId"]);
    return options.store.touchPresence({
      agentId: principal.agentId,
      signal: stringValue(body.signal, "signal"),
      actorPrincipalId: principal.principalId,
    });
  });

  app.put<{ Params: { teamId: string } }>("/v1/teams/:teamId", async (request) => {
    const principal = requireGrant(request, "agents:write");
    const body = objectBody(request);
    const displayName = optionalString(body.displayName, "displayName");
    return options.store.createTeam({
      teamId: request.params.teamId,
      ...(displayName === undefined ? {} : { displayName }),
      actorPrincipalId: principal.principalId,
    });
  });

  app.put<{ Params: { teamId: string; agentId: string } }>(
    "/v1/teams/:teamId/members/:agentId",
    async (request) => {
      const principal = requireGrant(request, "agents:write");
      const body = objectBody(request);
      const parentAgentId = optionalString(body.parentAgentId, "parentAgentId");
      return options.store.addTeamMember({
        teamId: request.params.teamId,
        agentId: request.params.agentId,
        role: stringValue(body.role, "role"),
        ...(parentAgentId === undefined ? {} : { parentAgentId }),
        actorPrincipalId: principal.principalId,
      });
    },
  );

  app.get<{ Params: { teamId: string } }>("/v1/teams/:teamId", async (request) => {
    requireGrant(request, "agents:read");
    return options.store.getTeam(request.params.teamId);
  });

  app.put<{ Params: { channelId: string } }>("/v1/channels/:channelId", async (request) => {
    const principal = requireGrant(request, "agents:write");
    const body = objectBody(request);
    const displayName = optionalString(body.displayName, "displayName");
    const teamId = optionalString(body.teamId, "teamId");
    const leadAgentId = optionalString(body.leadAgentId, "leadAgentId");
    return options.store.createChannel({
      channelId: request.params.channelId,
      ...(displayName === undefined ? {} : { displayName }),
      ...(teamId === undefined ? {} : { teamId }),
      ...(leadAgentId === undefined ? {} : { leadAgentId }),
      actorPrincipalId: principal.principalId,
    });
  });

  app.put<{ Params: { channelId: string; agentId: string } }>(
    "/v1/channels/:channelId/members/:agentId",
    async (request) => {
      const principal = requireGrant(request, "agents:write");
      return options.store.addChannelMember({
        channelId: request.params.channelId,
        agentId: request.params.agentId,
        actorPrincipalId: principal.principalId,
      });
    },
  );

  app.get<{ Params: { channelId: string } }>("/v1/channels/:channelId", async (request) => {
    requireGrant(request, "agents:read");
    return options.store.getChannel(request.params.channelId);
  });

  app.post("/v1/messages", async (request, reply) => {
    const principal = requireAgent(request, "messages:write", "messages:send");
    const key = idempotencyKey(request);
    const body = objectBody(request);
    rejectIdentityFields(body);
    const message = options.store.sendMessage({
      idempotencyKey: key,
      fromAgentId: principal.agentId,
      target: targetValue(body.target),
      correlationId: stringValue(body.correlationId, "correlationId"),
      body: stringValue(body.body, "body"),
      messageClass: messageClassValue(body.messageClass),
      metadata: recordValue(body.metadata, "metadata"),
      provenance: {
        authenticatedPrincipalId: principal.principalId,
        source: principal.source,
        sourceInstanceId: principal.sourceInstanceId,
        sourceOperationId: key,
        trust: "untrusted",
      },
    });
    return reply.status(201).send(message);
  });

  app.get<{ Querystring: Record<string, unknown> }>("/v1/inbox", async (request) => {
    const principal = requireAgent(request, "messages:read", "inbox:read");
    return options.store.pageInbox(principal.agentId, pageRequest(request.query));
  });

  app.get<{ Params: { agentId: string }; Querystring: Record<string, unknown> }>(
    "/v1/agents/:agentId/inbox",
    async (request) => {
      requireOwnAgent(request, request.params.agentId);
      return options.store.pageInbox(request.params.agentId, pageRequest(request.query));
    },
  );

  app.post<{ Params: { messageId: string } }>("/v1/inbox/:messageId/claim", async (request) => {
    const principal = requireAgent(request, "messages:read", "inbox:ack");
    const body = objectBody(request);
    rejectIdentityFields(body, ["recipientAgentId"]);
    return options.store.claimMessage({
      messageId: request.params.messageId,
      recipientAgentId: principal.agentId,
      consumerId: stringValue(body.consumerId, "consumerId"),
      leaseSeconds: numberValue(body.leaseSeconds, "leaseSeconds"),
      actorPrincipalId: principal.principalId,
    });
  });

  app.post<{ Params: { messageId: string } }>("/v1/inbox/:messageId/ack", async (request) => {
    const principal = requireAgent(request, "messages:read", "inbox:ack");
    const body = objectBody(request);
    rejectIdentityFields(body, ["recipientAgentId"]);
    const receiptId = optionalString(body.receiptId, "receiptId");
    return options.store.acknowledgeMessage({
      messageId: request.params.messageId,
      recipientAgentId: principal.agentId,
      claimToken: stringValue(body.claimToken, "claimToken"),
      ...(receiptId === undefined ? {} : { receiptId }),
      actorPrincipalId: principal.principalId,
    });
  });

  app.post<{ Params: { messageId: string } }>("/v1/inbox/:messageId/release", async (request) => {
    const principal = requireAgent(request, "messages:read", "inbox:ack");
    const body = objectBody(request);
    rejectIdentityFields(body, ["recipientAgentId"]);
    return options.store.releaseMessage({
      messageId: request.params.messageId,
      recipientAgentId: principal.agentId,
      claimToken: stringValue(body.claimToken, "claimToken"),
      actorPrincipalId: principal.principalId,
    });
  });

  app.post<{ Params: { messageId: string } }>("/v1/messages/:messageId/claim", async (request) => {
    const body = objectBody(request);
    const recipientAgentId = stringValue(body.recipientAgentId, "recipientAgentId");
    const principal = requireOwnAgent(request, recipientAgentId);
    return options.store.claimMessage({
      messageId: request.params.messageId,
      recipientAgentId,
      consumerId: stringValue(body.consumerId, "consumerId"),
      leaseSeconds: numberValue(body.leaseSeconds, "leaseSeconds"),
      actorPrincipalId: principal.principalId,
    });
  });

  app.post<{ Params: { messageId: string } }>("/v1/messages/:messageId/ack", async (request) => {
    const body = objectBody(request);
    const recipientAgentId = stringValue(body.recipientAgentId, "recipientAgentId");
    const principal = requireOwnAgent(request, recipientAgentId);
    const receiptId = optionalString(body.receiptId, "receiptId");
    return options.store.acknowledgeMessage({
      messageId: request.params.messageId,
      recipientAgentId,
      claimToken: stringValue(body.claimToken, "claimToken"),
      ...(receiptId === undefined ? {} : { receiptId }),
      actorPrincipalId: principal.principalId,
    });
  });

  app.post<{ Params: { messageId: string } }>(
    "/v1/messages/:messageId/release",
    async (request) => {
      const body = objectBody(request);
      const recipientAgentId = stringValue(body.recipientAgentId, "recipientAgentId");
      const principal = requireOwnAgent(request, recipientAgentId);
      return options.store.releaseMessage({
        messageId: request.params.messageId,
        recipientAgentId,
        claimToken: stringValue(body.claimToken, "claimToken"),
        actorPrincipalId: principal.principalId,
      });
    },
  );

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/spawn", async (request, reply) => {
    const principal = requireGrant(request, "lifecycle:control");
    const body = objectBody(request);
    const adapter = stringValue(body.adapter, "adapter");
    // A managed spawn derives provenance from the authenticated handle: an operator is not a
    // parent agent. Unmanaged adapters keep the historical parent.
    const managed = options.sideband.managesSpawnIdentity(adapter);
    const result = await options.sideband.spawnAgent({
      principalId: principal.principalId,
      idempotencyKey: idempotencyKey(request),
      agentId: request.params.agentId,
      adapter,
      parentAgentId: managed && principal.kind === "operator" ? null : principal.agentId,
      ...(managed ? { spawner: principal.handle } : {}),
      prompt: stringValue(body.prompt, "prompt"),
      provider: stringValue(body.provider, "provider"),
      metadata: recordValue(body.metadata, "metadata"),
    });
    return reply.status(202).send(result);
  });

  app.post("/v1/bindings", async (request, reply) => {
    const principal = requireGrant(request, "lifecycle:control");
    const body = objectBody(request);
    const providerSessionId = optionalString(body.providerSessionId, "providerSessionId");
    const result = await options.sideband.bindAgent({
      principalId: principal.principalId,
      idempotencyKey: idempotencyKey(request),
      agentId: stringValue(body.agentId, "agentId"),
      adapter: stringValue(body.adapter, "adapter"),
      externalId: stringValue(body.externalId, "externalId"),
      hostInstanceId: stringValue(body.hostInstanceId, "hostInstanceId"),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(body.generation === undefined
        ? {}
        : { generation: numberValue(body.generation, "generation") }),
      metadata: recordValue(body.metadata, "metadata"),
    });
    return reply.status(202).send(result);
  });

  app.post<{ Params: { bindingId: string } }>(
    "/v1/bindings/:bindingId/send",
    async (request, reply) => {
      const principal = requireGrant(request, "lifecycle:control");
      const body = objectBody(request);
      const mode = stringValue(body.mode, "mode");
      if (mode !== "wake" && mode !== "context" && mode !== "both") {
        throw invalidArgument("mode must be wake, context, or both.");
      }
      const result = await options.sideband.sendMessageToHost({
        principalId: principal.principalId,
        idempotencyKey: idempotencyKey(request),
        bindingId: request.params.bindingId,
        messageId: stringValue(body.messageId, "messageId"),
        mode,
      });
      return reply.status(202).send(result);
    },
  );

  app.post<{ Params: { agentId: string } }>(
    "/v1/agents/:agentId/interrupt",
    async (request, reply) => {
      const principal = requireGrant(request, "lifecycle:control");
      return reply.status(202).send(
        await options.sideband.interruptAgent({
          principalId: principal.principalId,
          agentId: request.params.agentId,
          idempotencyKey: idempotencyKey(request),
        }),
      );
    },
  );

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/stop", async (request, reply) => {
    const principal = requireGrant(request, "lifecycle:control");
    return reply.status(202).send(
      await options.sideband.stopAgent({
        principalId: principal.principalId,
        agentId: request.params.agentId,
        idempotencyKey: idempotencyKey(request),
      }),
    );
  });

  app.get<{ Params: { operationId: string } }>("/v1/operations/:operationId", async (request) => {
    requireGrant(request, "lifecycle:control");
    return options.store.getOperation(request.params.operationId);
  });

  app.get<{ Querystring: Record<string, unknown> }>("/v1/events", async (request) => {
    requireGrant(request, "events:read");
    const afterSequence =
      request.query.after_sequence === undefined ? 0 : Number(request.query.after_sequence);
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw invalidArgument("after_sequence must be non-negative.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw invalidArgument("limit must be an integer from 1 to 1000.");
    }
    return {
      items: options.store.listEvents({ afterSequence, limit }),
      head: options.store.getEventHead(),
    };
  });

  return app;
}
