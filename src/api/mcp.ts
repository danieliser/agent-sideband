import type { FastifyInstance, FastifyRequest } from "fastify";

import { SidebandApiError, responseError, type SidebandMcpApiClient } from "../mcp/http-client.js";
import {
  invokeSidebandTool,
  sidebandToolCatalog,
  type SidebandToolAudience,
} from "../mcp/tools.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { ApiError, forbidden, invalidArgument } from "./errors.js";
import { rejectIdentityFields, requiredObjectBody } from "./request.js";

export const MCP_CATALOG_VERSION = 1;

/**
 * Arguments that would name an actor, session or credential. Strict tool schemas reject them
 * too, but refusing them up front means a forged identity never reaches a handler.
 */
const TOOL_IDENTITY_FIELDS: readonly string[] = [
  "agentId",
  "recipientAgentId",
  "hostSessionId",
  "bindingId",
  "generation",
  "providerSessionId",
  "adapter",
  "hostInstanceId",
  "externalId",
  "token",
  "authorization",
  "credential",
];

const LOCAL_ORIGIN = "http://sideband.local";

function isOperator(principal: AuthenticatedPrincipal): boolean {
  return (
    principal.kind === "operator" || (principal.kind === undefined && principal.grants.has("admin"))
  );
}

/**
 * Runs shared tool handlers against this daemon's own routes in-process. Each inner request
 * carries the caller's own Authorization header, so every route re-authenticates the same
 * credential and applies its own grants. Nothing leaves the process and no other credential
 * is ever substituted. The MCP routes themselves are unreachable from here.
 */
function inProcessApi(app: FastifyInstance, authorization: string): SidebandMcpApiClient {
  return {
    async request(path, options = {}) {
      const url = new URL(path, LOCAL_ORIGIN);
      if (
        url.origin !== LOCAL_ORIGIN ||
        `${url.pathname}${url.search}` !== path ||
        !url.pathname.startsWith("/v1/") ||
        url.pathname.startsWith("/v1/mcp/")
      ) {
        throw new SidebandApiError(
          "SIDEBAND_INVALID_REQUEST",
          "Agent Sideband request path is not a tool route.",
        );
      }
      const response = await app.inject({
        method: options.method ?? "GET",
        url: path,
        headers: {
          authorization,
          ...(options.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": options.idempotencyKey }),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
      });
      let value: unknown = null;
      if (response.body.length > 0) {
        try {
          value = JSON.parse(response.body) as unknown;
        } catch {
          throw new SidebandApiError(
            "SIDEBAND_INVALID_RESPONSE",
            "Agent Sideband returned invalid JSON.",
          );
        }
      }
      if (response.statusCode >= 400) throw responseError(value, response.statusCode);
      return value;
    },
  };
}

/**
 * The host MCP bridge: a trusted host lists the shared catalog with its connector credential
 * and forwards each model tool call with that thread's own agent credential.
 */
export function registerMcpBridgeRoutes(
  app: FastifyInstance,
  options: { readonly authenticated: (request: FastifyRequest) => AuthenticatedPrincipal },
): void {
  const catalogs: Readonly<Record<SidebandToolAudience, unknown>> = {
    agent: {
      catalogVersion: MCP_CATALOG_VERSION,
      tools: sidebandToolCatalog({ audiences: ["agent"] }),
    },
    operator: {
      catalogVersion: MCP_CATALOG_VERSION,
      tools: sidebandToolCatalog({ audiences: ["operator"] }),
    },
  };
  const agentTools = new Set(
    sidebandToolCatalog({ audiences: ["agent"] }).map((tool) => tool.name),
  );

  app.get<{ Querystring: Record<string, unknown> }>("/v1/mcp/catalog", async (request, reply) => {
    const principal = options.authenticated(request);
    const audience = request.query.audience;
    if (audience !== "agent" && audience !== "operator") {
      throw invalidArgument("audience must be agent or operator.", { field: "audience" });
    }
    if (audience === "operator" && !isOperator(principal)) {
      throw forbidden("Only the local operator may list operator tools.");
    }
    return reply.header("cache-control", "no-store").send(catalogs[audience]);
  });

  app.post<{ Params: { name: string } }>("/v1/mcp/tools/:name/call", async (request, reply) => {
    const principal = options.authenticated(request);
    const authorization = request.headers.authorization;
    if (
      principal.kind !== "agent" ||
      principal.agentId === null ||
      principal.session === undefined ||
      typeof authorization !== "string"
    ) {
      throw forbidden("MCP tool calls require a provisioned agent credential.");
    }
    const body = requiredObjectBody(request);
    const extra = Object.keys(body).find((key) => key !== "arguments");
    if (extra !== undefined) throw invalidArgument("Unknown field.", { field: extra });
    const args = body.arguments;
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw invalidArgument("arguments must be a JSON object.", { field: "arguments" });
    }
    if (!agentTools.has(request.params.name)) {
      throw new ApiError("TOOL_NOT_FOUND", 404, "Unknown Sideband tool.");
    }
    rejectIdentityFields(args as Record<string, unknown>, TOOL_IDENTITY_FIELDS);
    const result = await invokeSidebandTool(
      inProcessApi(app, authorization),
      request.params.name,
      args,
      { audiences: ["agent"] },
    );
    return reply.header("cache-control", "no-store").send(result);
  });
}
