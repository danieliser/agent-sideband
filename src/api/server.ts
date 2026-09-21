import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { SidebandError } from "../core/errors.js";
import { AgentSideband } from "../core/sideband.js";
import type { MessageClass, MessageTarget, PageRequest } from "../core/types.js";
import type { SidebandStore } from "../store/store.js";
import type { ApiGrant, AuthenticatedPrincipal, SidebandAuthenticator } from "./auth.js";

export interface AgentSidebandServerOptions {
  readonly sideband: AgentSideband;
  readonly store: SidebandStore;
  readonly authenticate: SidebandAuthenticator;
  readonly logger?: boolean;
}

type JsonObject = Record<string, unknown>;

function objectBody(request: FastifyRequest): JsonObject {
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new SidebandError("INVALID_ARGUMENT", "Request body must be a JSON object.");
  }
  return request.body as JsonObject;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SidebandError("INVALID_ARGUMENT", `${name} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, name);
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SidebandError("INVALID_ARGUMENT", `${name} must be a finite number.`);
  }
  return value;
}

function recordValue(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SidebandError("INVALID_ARGUMENT", `${name} must be a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (Array.isArray(value)) {
    throw new SidebandError("INVALID_ARGUMENT", "Idempotency-Key must have one value.");
  }
  return stringValue(value, "Idempotency-Key");
}

function pageRequest(query: Record<string, unknown>): PageRequest {
  const after = optionalString(query.after, "after");
  let limit: number | undefined;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new SidebandError("INVALID_ARGUMENT", "limit must be an integer from 1 to 200.");
    }
  }
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function targetValue(value: unknown): MessageTarget {
  const target = recordValue(value, "target");
  const type = stringValue(target.type, "target.type");
  const id = stringValue(target.id, "target.id");
  if (type !== "agent" && type !== "channel") {
    throw new SidebandError("INVALID_ARGUMENT", "target.type must be agent or channel.");
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
  if (!messageClasses.has(result)) {
    throw new SidebandError("INVALID_ARGUMENT", "Unknown messageClass.");
  }
  return result;
}

function statusFor(error: SidebandError): number {
  switch (error.code) {
    case "UNAUTHORIZED":
      return 401;
    case "AGENT_NOT_FOUND":
    case "TEAM_NOT_FOUND":
    case "CHANNEL_NOT_FOUND":
    case "MESSAGE_NOT_FOUND":
    case "BINDING_NOT_FOUND":
    case "OPERATION_NOT_FOUND":
    case "ADAPTER_NOT_FOUND":
      return 404;
    case "AGENT_CONFLICT":
    case "TEAM_CONFLICT":
    case "CHANNEL_CONFLICT":
    case "BINDING_CONFLICT":
    case "MESSAGE_CLAIM_CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    default:
      return 400;
  }
}

function sendError(error: unknown, reply: FastifyReply): void {
  if (error instanceof SidebandError) {
    void reply.status(statusFor(error)).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  throw error;
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

  function requirePrincipal(request: FastifyRequest, grant: ApiGrant): AuthenticatedPrincipal {
    const principal = principals.get(request);
    if (principal === undefined || !principal.grants.has(grant)) {
      throw new SidebandError("UNAUTHORIZED", `The ${grant} grant is required.`);
    }
    return principal;
  }

  function requireOwnAgent(request: FastifyRequest, agentId: string): AuthenticatedPrincipal {
    const principal = requirePrincipal(request, "messages:read");
    if (principal.agentId !== agentId && !principal.grants.has("admin")) {
      throw new SidebandError("UNAUTHORIZED", "Credentials are not bound to this agent.");
    }
    return principal;
  }

  app.addHook("onRequest", async (request) => {
    if (request.url === "/health") return;
    const principal = await options.authenticate(request);
    if (principal === null) {
      throw new SidebandError("UNAUTHORIZED", "A valid bearer credential is required.");
    }
    principals.set(request, principal);
  });

  app.setErrorHandler((error, _request, reply) => sendError(error, reply));
  app.get("/health", async () => ({ status: "ok", service: "agent-sideband", version: 1 }));

  app.put<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request) => {
    const principal = requirePrincipal(request, "agents:write");
    const body = objectBody(request);
    const displayName = optionalString(body.displayName, "displayName");
    return options.store.registerAgent({
      agentId: request.params.agentId,
      ...(displayName === undefined ? {} : { displayName }),
      actorPrincipalId: principal.principalId,
    });
  });

  app.get<{ Querystring: Record<string, unknown> }>("/v1/agents", async (request) => {
    requirePrincipal(request, "agents:read");
    return options.store.pageAgents(pageRequest(request.query));
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request) => {
    requirePrincipal(request, "agents:read");
    return options.store.getAgent(request.params.agentId);
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId/presence", async (request) => {
    requirePrincipal(request, "agents:read");
    return options.store.getPresence(request.params.agentId);
  });

  app.post("/v1/presence/heartbeat", async (request) => {
    const principal = requirePrincipal(request, "messages:read");
    if (principal.agentId === null) {
      throw new SidebandError("UNAUTHORIZED", "Credential is not bound to an agent.");
    }
    const body = objectBody(request);
    return options.store.touchPresence({
      agentId: principal.agentId,
      signal: stringValue(body.signal, "signal"),
      actorPrincipalId: principal.principalId,
    });
  });

  app.put<{ Params: { teamId: string } }>("/v1/teams/:teamId", async (request) => {
    const principal = requirePrincipal(request, "agents:write");
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
      const principal = requirePrincipal(request, "agents:write");
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
    requirePrincipal(request, "agents:read");
    return options.store.getTeam(request.params.teamId);
  });

  app.put<{ Params: { channelId: string } }>("/v1/channels/:channelId", async (request) => {
    const principal = requirePrincipal(request, "agents:write");
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
      const principal = requirePrincipal(request, "agents:write");
      return options.store.addChannelMember({
        channelId: request.params.channelId,
        agentId: request.params.agentId,
        actorPrincipalId: principal.principalId,
      });
    },
  );

  app.get<{ Params: { channelId: string } }>("/v1/channels/:channelId", async (request) => {
    requirePrincipal(request, "agents:read");
    return options.store.getChannel(request.params.channelId);
  });

  app.post("/v1/messages", async (request, reply) => {
    const principal = requirePrincipal(request, "messages:write");
    if (principal.agentId === null) {
      throw new SidebandError("UNAUTHORIZED", "Credential is not bound to an agent.");
    }
    const key = idempotencyKey(request);
    const body = objectBody(request);
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
    const principal = requirePrincipal(request, "messages:read");
    if (principal.agentId === null) {
      throw new SidebandError("UNAUTHORIZED", "Credential is not bound to an agent.");
    }
    return options.store.pageInbox(principal.agentId, pageRequest(request.query));
  });

  app.get<{ Params: { agentId: string }; Querystring: Record<string, unknown> }>(
    "/v1/agents/:agentId/inbox",
    async (request) => {
      requireOwnAgent(request, request.params.agentId);
      return options.store.pageInbox(request.params.agentId, pageRequest(request.query));
    },
  );

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
    const principal = requirePrincipal(request, "lifecycle:control");
    const body = objectBody(request);
    const result = await options.sideband.spawnAgent({
      principalId: principal.principalId,
      idempotencyKey: idempotencyKey(request),
      agentId: request.params.agentId,
      adapter: stringValue(body.adapter, "adapter"),
      parentAgentId: principal.agentId,
      prompt: stringValue(body.prompt, "prompt"),
      provider: stringValue(body.provider, "provider"),
      metadata: recordValue(body.metadata, "metadata"),
    });
    return reply.status(202).send(result);
  });

  app.post("/v1/bindings", async (request, reply) => {
    const principal = requirePrincipal(request, "lifecycle:control");
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
      const principal = requirePrincipal(request, "lifecycle:control");
      const body = objectBody(request);
      const mode = stringValue(body.mode, "mode");
      if (mode !== "wake" && mode !== "context" && mode !== "both") {
        throw new SidebandError("INVALID_ARGUMENT", "mode must be wake, context, or both.");
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
      const principal = requirePrincipal(request, "lifecycle:control");
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
    const principal = requirePrincipal(request, "lifecycle:control");
    return reply.status(202).send(
      await options.sideband.stopAgent({
        principalId: principal.principalId,
        agentId: request.params.agentId,
        idempotencyKey: idempotencyKey(request),
      }),
    );
  });

  app.get<{ Params: { operationId: string } }>("/v1/operations/:operationId", async (request) => {
    requirePrincipal(request, "lifecycle:control");
    return options.store.getOperation(request.params.operationId);
  });

  app.get<{ Querystring: Record<string, unknown> }>("/v1/events", async (request) => {
    requirePrincipal(request, "events:read");
    const afterSequence =
      request.query.after_sequence === undefined ? 0 : Number(request.query.after_sequence);
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new SidebandError("INVALID_ARGUMENT", "after_sequence must be non-negative.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new SidebandError("INVALID_ARGUMENT", "limit must be an integer from 1 to 1000.");
    }
    return {
      items: options.store.listEvents({ afterSequence, limit }),
      head: options.store.getEventHead(),
    };
  });

  return app;
}
