import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSidebandDaemon, type SidebandDaemon } from "../src/api/daemon.js";
import { sidebandToolCatalog } from "../src/mcp/tools.js";

const START = "2026-10-08T12:00:00.000Z";
const OPERATOR = "operator-token-that-is-long-enough-for-the-daemon";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function bearer(token: string, key?: string) {
  return {
    authorization: `Bearer ${token}`,
    ...(key === undefined ? {} : { "idempotency-key": key }),
  };
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "sideband-mcp-bridge-"));
  const daemon = createSidebandDaemon({
    database: join(directory, "sideband.sqlite"),
    operatorToken: OPERATOR,
    now: () => new Date(START),
    scheduler: { autoStart: false },
  });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => daemon.close());
  const enrolled = await daemon.app.inject({
    method: "POST",
    url: "/v1/connectors",
    headers: bearer(OPERATOR),
    payload: { adapter: "t3", hostInstanceId: "env-1" },
  });
  const connector = enrolled.json().token as string;
  const provisioned = await daemon.app.inject({
    method: "POST",
    url: "/v1/host-sessions",
    headers: bearer(connector, "provision-1"),
    payload: { externalId: "thread-1", providerSessionId: "mcp-gen-1", hostEpoch: "t3-epoch-1" },
  });
  expect(provisioned.statusCode).toBe(201);
  const agent = provisioned.json() as {
    token: string;
    agentId: string;
    principalId: string;
    hostSessionId: string;
  };
  return { daemon, connector, agent };
}

function call(daemon: SidebandDaemon, token: string, name: string, body: unknown) {
  return daemon.app.inject({
    method: "POST",
    url: `/v1/mcp/tools/${name}/call`,
    headers: bearer(token),
    payload: body as Record<string, unknown>,
  });
}

describe("MCP catalog route", () => {
  it("serves the shared agent catalog verbatim to the connector", async () => {
    const { daemon, connector } = await setup();
    const response = await daemon.app.inject({
      method: "GET",
      url: "/v1/mcp/catalog?audience=agent",
      headers: bearer(connector),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      catalogVersion: 1,
      tools: JSON.parse(JSON.stringify(sidebandToolCatalog({ audiences: ["agent"] }))),
    });
    expect(
      response.json().tools.every((tool: { audience: string }) => tool.audience === "agent"),
    ).toBe(true);
  });

  it("keeps operator tools from connectors and agents", async () => {
    const { daemon, connector, agent } = await setup();
    for (const token of [connector, agent.token]) {
      const response = await daemon.app.inject({
        method: "GET",
        url: "/v1/mcp/catalog?audience=operator",
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(403);
    }
    const operator = await daemon.app.inject({
      method: "GET",
      url: "/v1/mcp/catalog?audience=operator",
      headers: bearer(OPERATOR),
    });
    expect(operator.statusCode).toBe(200);
    expect(operator.json().tools.map((tool: { name: string }) => tool.name)).toContain(
      "sideband_agent_stop",
    );
    const invalid = await daemon.app.inject({
      method: "GET",
      url: "/v1/mcp/catalog?audience=everyone",
      headers: bearer(OPERATOR),
    });
    expect(invalid.statusCode).toBe(422);
    const anonymous = await daemon.app.inject({
      method: "GET",
      url: "/v1/mcp/catalog?audience=agent",
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("MCP tool call route", () => {
  it("runs the shared handler as the server-resolved agent", async () => {
    const { daemon, agent } = await setup();
    const response = await call(daemon, agent.token, "sideband_identity_get", { arguments: {} });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const result = response.json();
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.structuredContent).toMatchObject({
      agentId: agent.agentId,
      principalId: agent.principalId,
    });
    expect(response.body).not.toContain(agent.token);
  });

  it("stamps the sender from the forwarded agent credential", async () => {
    const { daemon, agent } = await setup();
    const response = await call(daemon, agent.token, "sideband_message_send", {
      arguments: {
        idempotencyKey: "bridge-send-1",
        targetType: "agent",
        targetId: agent.agentId,
        correlationId: "corr-1",
        body: "hello",
        messageClass: "informational",
      },
    });
    expect(response.statusCode).toBe(200);
    const message = response.json().structuredContent;
    expect(response.json().isError).toBe(false);
    expect(message.fromAgentId).toBe(agent.agentId);
    expect(daemon.store.getMessage(message.messageId).provenance).toMatchObject({
      authenticatedPrincipalId: agent.principalId,
      trust: "untrusted",
    });
  });

  it("refuses connector and operator credentials, with no operator fallback", async () => {
    const { daemon, connector } = await setup();
    for (const token of [connector, OPERATOR]) {
      const response = await call(daemon, token, "sideband_identity_get", { arguments: {} });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
    }
  });

  it("hides operator and unknown tools from agents", async () => {
    const { daemon, agent } = await setup();
    for (const name of ["sideband_agent_stop", "sideband_events_list", "sideband_nope"]) {
      const response = await call(daemon, agent.token, name, {
        arguments: { idempotencyKey: "k", agentId: "x" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("TOOL_NOT_FOUND");
    }
  });

  it("refuses spoofed identity fields and malformed bodies", async () => {
    const { daemon, agent } = await setup();
    const spoofed = await call(daemon, agent.token, "sideband_inbox_list", {
      arguments: { agentId: "someone-else" },
    });
    expect(spoofed.statusCode).toBe(422);
    expect(spoofed.json().error).toMatchObject({
      code: "IDENTITY_FIELD_REJECTED",
      details: { field: "agentId" },
    });
    for (const body of [{}, { arguments: [] }, { arguments: {}, extra: 1 }, { arguments: "x" }]) {
      const response = await call(daemon, agent.token, "sideband_inbox_list", body);
      expect(response.statusCode).toBe(422);
    }
  });

  it("returns inner route failures as structured tool errors", async () => {
    const { daemon, agent } = await setup();
    const response = await call(daemon, agent.token, "sideband_schedule_get", {
      arguments: { scheduleId: "missing" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "SCHEDULE_NOT_FOUND", status: 404 } },
    });
    const invalid = await call(daemon, agent.token, "sideband_schedule_get", { arguments: {} });
    expect(invalid.json()).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INVALID_ARGUMENT" } },
    });
  });

  it("answers 401 once the agent credential is no longer live", async () => {
    const { daemon, connector, agent } = await setup();
    await daemon.app.inject({
      method: "POST",
      url: `/v1/host-sessions/${agent.hostSessionId}/offline`,
      headers: bearer(connector, "offline-1"),
      payload: {},
    });
    const response = await call(daemon, agent.token, "sideband_identity_get", { arguments: {} });
    expect(response.statusCode).toBe(401);
  });
});
