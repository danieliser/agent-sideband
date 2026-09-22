import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { SidebandMcpApiClient, SidebandMcpRequestOptions } from "./http-client.js";

export type { SidebandMcpApiClient, SidebandMcpRequestOptions } from "./http-client.js";

export interface AgentSidebandMcpServerOptions {
  readonly api: SidebandMcpApiClient;
}

const metadataSchema = z.record(z.string(), z.unknown()).default({});
const pageSchema = z.object({
  after: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

function resourcePath(segment: string): string {
  return encodeURIComponent(segment);
}

function pagePath(
  path: string,
  input: { after?: string | undefined; limit?: number | undefined },
): string {
  const query = new URLSearchParams();
  if (input.after !== undefined) query.set("after", input.after);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  const suffix = query.toString();
  return suffix.length === 0 ? path : `${path}?${suffix}`;
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) ?? "null" }],
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Agent Sideband request failed.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function call(api: SidebandMcpApiClient, path: string, options?: SidebandMcpRequestOptions) {
  try {
    return result(await api.request(path, options));
  } catch (error) {
    return failure(error);
  }
}

export function buildAgentSidebandMcpServer(options: AgentSidebandMcpServerOptions): McpServer {
  const server = new McpServer({ name: "agent-sideband", version: "0.2.0" });

  server.registerTool(
    "sideband_agents_list",
    {
      description: "List agents registered with Agent Sideband.",
      inputSchema: pageSchema,
    },
    (input) => call(options.api, pagePath("/v1/agents", input)),
  );

  server.registerTool(
    "sideband_message_send",
    {
      description:
        "Send a durable direct or channel message. Sender identity comes from the credential.",
      inputSchema: z.object({
        idempotencyKey: z.string().min(1),
        targetType: z.enum(["agent", "channel"]),
        targetId: z.string().min(1),
        correlationId: z.string().min(1),
        body: z.string().min(1),
        messageClass: z.enum([
          "request",
          "informational",
          "completion",
          "steering",
          "reaction",
          "system",
        ]),
        metadata: metadataSchema,
      }),
    },
    (input) =>
      call(options.api, "/v1/messages", {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          target: { type: input.targetType, id: input.targetId },
          correlationId: input.correlationId,
          body: input.body,
          messageClass: input.messageClass,
          metadata: input.metadata,
        },
      }),
  );

  server.registerTool(
    "sideband_inbox_list",
    {
      description: "List durable inbox messages for the credential-bound agent.",
      inputSchema: pageSchema,
    },
    (input) => call(options.api, pagePath("/v1/inbox", input)),
  );

  server.registerTool(
    "sideband_message_claim",
    {
      description: "Claim an inbox message under a bounded lease.",
      inputSchema: z.object({
        messageId: z.string().min(1),
        consumerId: z.string().min(1),
        leaseSeconds: z.number().int().min(1).max(300),
      }),
    },
    (input) =>
      call(options.api, `/v1/inbox/${resourcePath(input.messageId)}/claim`, {
        method: "POST",
        body: { consumerId: input.consumerId, leaseSeconds: input.leaseSeconds },
      }),
  );

  server.registerTool(
    "sideband_message_ack",
    {
      description: "Acknowledge a claimed inbox message as delivered.",
      inputSchema: z.object({
        messageId: z.string().min(1),
        claimToken: z.string().min(1),
        receiptId: z.string().min(1).optional(),
      }),
    },
    (input) =>
      call(options.api, `/v1/inbox/${resourcePath(input.messageId)}/ack`, {
        method: "POST",
        body: {
          claimToken: input.claimToken,
          ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
        },
      }),
  );

  server.registerTool(
    "sideband_message_release",
    {
      description: "Release a claimed inbox message back to pending.",
      inputSchema: z.object({
        messageId: z.string().min(1),
        claimToken: z.string().min(1),
      }),
    },
    (input) =>
      call(options.api, `/v1/inbox/${resourcePath(input.messageId)}/release`, {
        method: "POST",
        body: { claimToken: input.claimToken },
      }),
  );

  server.registerTool(
    "sideband_host_message_send",
    {
      description:
        "Notify a bound host about an existing durable message without acknowledging its inbox delivery.",
      inputSchema: z.object({
        idempotencyKey: z.string().min(1),
        bindingId: z.string().min(1),
        messageId: z.string().min(1),
        mode: z.enum(["wake", "context", "both"]),
      }),
    },
    (input) =>
      call(options.api, `/v1/bindings/${resourcePath(input.bindingId)}/send`, {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: { messageId: input.messageId, mode: input.mode },
      }),
  );

  server.registerTool(
    "sideband_agent_spawn",
    {
      description: "Spawn an agent through a configured host adapter.",
      inputSchema: z.object({
        idempotencyKey: z.string().min(1),
        agentId: z.string().min(1),
        adapter: z.string().min(1),
        provider: z.string().min(1),
        prompt: z.string().min(1),
        metadata: metadataSchema,
      }),
    },
    (input) =>
      call(options.api, `/v1/agents/${resourcePath(input.agentId)}/spawn`, {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          adapter: input.adapter,
          provider: input.provider,
          prompt: input.prompt,
          metadata: input.metadata,
        },
      }),
  );

  server.registerTool(
    "sideband_agent_bind",
    {
      description: "Bind an existing host session to a Sideband agent.",
      inputSchema: z.object({
        idempotencyKey: z.string().min(1),
        agentId: z.string().min(1),
        adapter: z.string().min(1),
        externalId: z.string().min(1),
        hostInstanceId: z.string().min(1),
        providerSessionId: z.string().min(1).optional(),
        generation: z.number().int().min(1).optional(),
        metadata: metadataSchema,
      }),
    },
    (input) =>
      call(options.api, "/v1/bindings", {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          agentId: input.agentId,
          adapter: input.adapter,
          externalId: input.externalId,
          hostInstanceId: input.hostInstanceId,
          ...(input.providerSessionId === undefined
            ? {}
            : { providerSessionId: input.providerSessionId }),
          ...(input.generation === undefined ? {} : { generation: input.generation }),
          metadata: input.metadata,
        },
      }),
  );

  for (const action of ["interrupt", "stop"] as const) {
    server.registerTool(
      `sideband_agent_${action}`,
      {
        description: `${action === "stop" ? "Stop" : "Interrupt"} an agent through its active host binding.`,
        inputSchema: z.object({
          idempotencyKey: z.string().min(1),
          agentId: z.string().min(1),
        }),
      },
      (input) =>
        call(options.api, `/v1/agents/${resourcePath(input.agentId)}/${action}`, {
          method: "POST",
          idempotencyKey: input.idempotencyKey,
        }),
    );
  }

  server.registerTool(
    "sideband_events_list",
    {
      description: "Read the ordered durable Sideband event log.",
      inputSchema: z.object({
        afterSequence: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(100),
      }),
    },
    (input) => {
      const query = new URLSearchParams({
        after_sequence: String(input.afterSequence),
        limit: String(input.limit),
      });
      return call(options.api, `/v1/events?${query.toString()}`);
    },
  );

  server.registerTool(
    "sideband_presence_heartbeat",
    {
      description: "Refresh presence for the credential-bound agent.",
      inputSchema: z.object({ signal: z.string().min(1) }),
    },
    (input) =>
      call(options.api, "/v1/presence/heartbeat", {
        method: "POST",
        body: { signal: input.signal },
      }),
  );

  return server;
}
