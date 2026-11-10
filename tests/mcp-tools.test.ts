import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidebandApiError, type SidebandMcpApiClient } from "../src/mcp/http-client.js";
import {
  invokeSidebandTool,
  registerSidebandTools,
  sidebandToolCatalog,
} from "../src/mcp/tools.js";

const connections: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.client.close();
    await connection.server.close();
  }
});

function fakeApi(response: unknown = { ok: true }) {
  return { request: vi.fn(async () => response) } satisfies SidebandMcpApiClient;
}

async function connect(api: SidebandMcpApiClient, audiences?: readonly ("agent" | "operator")[]) {
  const server = new McpServer({ name: "host-bridge", version: "1.0.0" });
  registerSidebandTools(server, api, audiences === undefined ? {} : { audiences });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

describe("shared Sideband tool catalog", () => {
  it("describes every tool once with SDK-neutral JSON Schema and annotations", () => {
    const catalog = sidebandToolCatalog();
    const names = catalog.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of [
      "sideband_capabilities_get",
      "sideband_identity_get",
      "sideband_schedule_create",
      "sideband_schedules_list",
      "sideband_schedule_get",
      "sideband_schedule_occurrences_list",
      "sideband_schedule_cancel",
    ]) {
      expect(names).toContain(name);
    }
    for (const tool of catalog) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
    }
    const create = catalog.find((tool) => tool.name === "sideband_schedule_create");
    expect(create?.inputSchema.required).toEqual(
      expect.arrayContaining(["idempotencyKey", "body", "trigger"]),
    );
    expect(JSON.stringify(create?.inputSchema)).not.toMatch(/ownerAgentId|fromAgentId|principalId/);
  });

  it("keeps lifecycle, raw event and ingress tools out of the agent audience", () => {
    const agentNames = sidebandToolCatalog({ audiences: ["agent"] }).map((tool) => tool.name);
    for (const name of [
      "sideband_agent_spawn",
      "sideband_agent_bind",
      "sideband_agent_stop",
      "sideband_events_list",
      "sideband_schedule_event_emit",
      "sideband_host_message_send",
    ]) {
      expect(agentNames).not.toContain(name);
    }
    expect(agentNames).toContain("sideband_schedule_create");
  });

  it("registers identical tools on a host's own MCP server", async () => {
    const client = await connect(fakeApi(), ["agent"]);
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(listed).toEqual(
      sidebandToolCatalog({ audiences: ["agent"] })
        .map((tool) => tool.name)
        .sort(),
    );
  });

  it("converts a human delay losslessly and defaults to self and wake", async () => {
    const api = fakeApi({ schedule: { scheduleId: "s-1" } });
    const client = await connect(api);
    const result = await client.callTool({
      name: "sideband_schedule_create",
      arguments: {
        idempotencyKey: "remind-30m",
        body: "Review the checkpoint.",
        trigger: { type: "after", delay: { value: 30, unit: "minutes" } },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ schedule: { scheduleId: "s-1" } });
    expect(api.request).toHaveBeenCalledWith("/v1/schedules", {
      method: "POST",
      idempotencyKey: "remind-30m",
      body: {
        body: "Review the checkpoint.",
        trigger: { type: "after", delaySeconds: 1800 },
      },
    });
  });

  it("passes absolute, cron and cancel requests through with idempotency keys", async () => {
    const api = fakeApi();
    await invokeSidebandTool(api, "sideband_schedule_create", {
      idempotencyKey: "weekday",
      name: "Weekday review",
      body: "Review.",
      deliveryMode: "wake",
      trigger: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
    });
    expect(api.request).toHaveBeenLastCalledWith("/v1/schedules", {
      method: "POST",
      idempotencyKey: "weekday",
      body: {
        name: "Weekday review",
        body: "Review.",
        deliveryMode: "wake",
        trigger: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
      },
    });
    await invokeSidebandTool(api, "sideband_schedule_cancel", {
      idempotencyKey: "cancel-1",
      scheduleId: "a/b",
    });
    expect(api.request).toHaveBeenLastCalledWith("/v1/schedules/a%2Fb/cancel", {
      method: "POST",
      idempotencyKey: "cancel-1",
    });
    await invokeSidebandTool(api, "sideband_schedules_list", { status: "active", limit: 5 });
    expect(api.request).toHaveBeenLastCalledWith("/v1/schedules?status=active&limit=5", undefined);
  });

  it("returns structured validation errors without calling the daemon", async () => {
    const api = fakeApi();
    const ambiguous = await invokeSidebandTool(api, "sideband_schedule_create", {
      idempotencyKey: "x",
      body: "x",
      trigger: { type: "after", delaySeconds: 60, delay: { value: 1, unit: "minutes" } },
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.structuredContent.error).toMatchObject({ code: "INVALID_ARGUMENT" });
    const fractional = await invokeSidebandTool(api, "sideband_schedule_create", {
      idempotencyKey: "x",
      body: "x",
      trigger: { type: "after", delay: { value: 0.25, unit: "seconds" } },
    });
    expect(fractional.structuredContent.error).toMatchObject({ code: "INVALID_ARGUMENT" });
    const unknown = await invokeSidebandTool(api, "sideband_nope", {});
    expect(unknown.structuredContent.error).toMatchObject({ code: "TOOL_NOT_FOUND" });
    const spoof = await invokeSidebandTool(api, "sideband_schedule_create", {
      idempotencyKey: "x",
      body: "x",
      ownerAgentId: "someone-else",
      trigger: { type: "after", delaySeconds: 60 },
    });
    expect(spoof.structuredContent.error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(api.request).not.toHaveBeenCalled();
  });

  it("propagates daemon error codes as structured MCP errors without secrets", async () => {
    const api: SidebandMcpApiClient = {
      request: vi.fn(async () => {
        throw new SidebandApiError("SIDEBAND_HTTP_ERROR", "Schedules may only target self.", {
          status: 403,
          remoteCode: "FORBIDDEN",
          details: { grants: ["schedules:create"] },
          retryable: false,
        });
      }),
    };
    const client = await connect(api);
    const result = await client.callTool({
      name: "sideband_schedule_get",
      arguments: { scheduleId: "s-1" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Schedules may only target self.",
        status: 403,
        details: { grants: ["schedules:create"] },
        retryable: false,
      },
    });

    const leaky: SidebandMcpApiClient = {
      request: vi.fn(async () => {
        throw new Error("socket closed while sending Bearer sbat_secretsecret");
      }),
    };
    const failed = await invokeSidebandTool(leaky, "sideband_identity_get", {});
    expect(JSON.stringify(failed)).not.toContain("sbat_");
    expect(failed.structuredContent.error).toMatchObject({ code: "SIDEBAND_REQUEST_FAILED" });
  });
});
