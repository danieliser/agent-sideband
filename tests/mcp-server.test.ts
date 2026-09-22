import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAgentSidebandMcpServer, type SidebandMcpApiClient } from "../src/mcp/server.js";

const openConnections: Array<{
  client: Client;
  server: ReturnType<typeof buildAgentSidebandMcpServer>;
}> = [];

async function setup(response: unknown = { ok: true }) {
  const api: SidebandMcpApiClient = {
    request: vi.fn(async () => response),
  };
  const server = buildAgentSidebandMcpServer({ api });
  const client = new Client({ name: "agent-sideband-test", version: "0.2.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push({ client, server });
  return { api, client };
}

afterEach(async () => {
  for (const connection of openConnections.splice(0)) {
    await connection.client.close();
    await connection.server.close();
  }
});

describe("Agent Sideband MCP server", () => {
  it("exposes the standalone coordination and lifecycle toolset", async () => {
    const { client } = await setup();
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "sideband_agent_bind",
        "sideband_agent_interrupt",
        "sideband_agent_spawn",
        "sideband_agent_stop",
        "sideband_agents_list",
        "sideband_events_list",
        "sideband_host_message_send",
        "sideband_inbox_list",
        "sideband_message_ack",
        "sideband_message_claim",
        "sideband_message_release",
        "sideband_message_send",
        "sideband_presence_heartbeat",
      ].sort(),
    );
  });

  it("sends messages without accepting a caller-supplied sender identity", async () => {
    const { api, client } = await setup({ messageId: "message-1" });
    const result = await client.callTool({
      name: "sideband_message_send",
      arguments: {
        idempotencyKey: "send-1",
        targetType: "agent",
        targetId: "reviewer",
        correlationId: "work-1",
        body: "Review this.",
        messageClass: "request",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(api.request).toHaveBeenCalledWith("/v1/messages", {
      method: "POST",
      idempotencyKey: "send-1",
      body: {
        target: { type: "agent", id: "reviewer" },
        correlationId: "work-1",
        body: "Review this.",
        messageClass: "request",
        metadata: {},
      },
    });
  });

  it("uses credential-derived self-service routes for inbox claims and acknowledgements", async () => {
    const { api, client } = await setup({ status: "claimed" });

    await client.callTool({
      name: "sideband_message_claim",
      arguments: { messageId: "message-1", consumerId: "worker-1", leaseSeconds: 60 },
    });
    await client.callTool({
      name: "sideband_message_ack",
      arguments: {
        messageId: "message-1",
        claimToken: "claim-token",
        receiptId: "receipt-1",
      },
    });

    expect(api.request).toHaveBeenNthCalledWith(1, "/v1/inbox/message-1/claim", {
      method: "POST",
      body: { consumerId: "worker-1", leaseSeconds: 60 },
    });
    expect(api.request).toHaveBeenNthCalledWith(2, "/v1/inbox/message-1/ack", {
      method: "POST",
      body: { claimToken: "claim-token", receiptId: "receipt-1" },
    });
  });

  it("maps lifecycle tools to the authenticated daemon API", async () => {
    const { api, client } = await setup({ operation: { stage: "accepted" } });

    await client.callTool({
      name: "sideband_agent_spawn",
      arguments: {
        idempotencyKey: "spawn-1",
        agentId: "reviewer",
        adapter: "t3",
        provider: "provider-instance",
        prompt: "Review the change.",
        metadata: { projectId: "project-1", model: "model-1" },
      },
    });
    await client.callTool({
      name: "sideband_agent_stop",
      arguments: { idempotencyKey: "stop-1", agentId: "reviewer" },
    });

    expect(api.request).toHaveBeenNthCalledWith(1, "/v1/agents/reviewer/spawn", {
      method: "POST",
      idempotencyKey: "spawn-1",
      body: {
        adapter: "t3",
        provider: "provider-instance",
        prompt: "Review the change.",
        metadata: { projectId: "project-1", model: "model-1" },
      },
    });
    expect(api.request).toHaveBeenNthCalledWith(2, "/v1/agents/reviewer/stop", {
      method: "POST",
      idempotencyKey: "stop-1",
    });
  });

  it("maps the remaining read, release, presence, bind, and host tools", async () => {
    const { api, client } = await setup();

    await client.callTool({
      name: "sideband_agents_list",
      arguments: { after: "agent-1", limit: 20 },
    });
    await client.callTool({
      name: "sideband_inbox_list",
      arguments: { limit: 10 },
    });
    await client.callTool({
      name: "sideband_message_release",
      arguments: { messageId: "message/1", claimToken: "claim-token" },
    });
    await client.callTool({
      name: "sideband_presence_heartbeat",
      arguments: { signal: "working" },
    });
    await client.callTool({
      name: "sideband_events_list",
      arguments: { afterSequence: 4, limit: 50 },
    });
    await client.callTool({
      name: "sideband_agent_bind",
      arguments: {
        idempotencyKey: "bind-1",
        agentId: "reviewer",
        adapter: "t3",
        externalId: "thread-1",
        hostInstanceId: "environment-1",
        providerSessionId: "session-1",
        generation: 2,
        metadata: { projectId: "project-1" },
      },
    });
    await client.callTool({
      name: "sideband_host_message_send",
      arguments: {
        idempotencyKey: "host-send-1",
        bindingId: "binding-1",
        messageId: "message-1",
        mode: "wake",
      },
    });
    await client.callTool({
      name: "sideband_agent_interrupt",
      arguments: { idempotencyKey: "interrupt-1", agentId: "reviewer" },
    });

    expect(api.request).toHaveBeenNthCalledWith(1, "/v1/agents?after=agent-1&limit=20", undefined);
    expect(api.request).toHaveBeenNthCalledWith(2, "/v1/inbox?limit=10", undefined);
    expect(api.request).toHaveBeenNthCalledWith(3, "/v1/inbox/message%2F1/release", {
      method: "POST",
      body: { claimToken: "claim-token" },
    });
    expect(api.request).toHaveBeenNthCalledWith(4, "/v1/presence/heartbeat", {
      method: "POST",
      body: { signal: "working" },
    });
    expect(api.request).toHaveBeenNthCalledWith(
      5,
      "/v1/events?after_sequence=4&limit=50",
      undefined,
    );
    expect(api.request).toHaveBeenNthCalledWith(6, "/v1/bindings", {
      method: "POST",
      idempotencyKey: "bind-1",
      body: {
        agentId: "reviewer",
        adapter: "t3",
        externalId: "thread-1",
        hostInstanceId: "environment-1",
        providerSessionId: "session-1",
        generation: 2,
        metadata: { projectId: "project-1" },
      },
    });
    expect(api.request).toHaveBeenNthCalledWith(7, "/v1/bindings/binding-1/send", {
      method: "POST",
      idempotencyKey: "host-send-1",
      body: { messageId: "message-1", mode: "wake" },
    });
    expect(api.request).toHaveBeenNthCalledWith(8, "/v1/agents/reviewer/interrupt", {
      method: "POST",
      idempotencyKey: "interrupt-1",
    });
  });
});
