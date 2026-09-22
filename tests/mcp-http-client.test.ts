import { describe, expect, it, vi } from "vitest";

import { SidebandApiError, SidebandHttpClient } from "../src/mcp/http-client.js";

describe("Sideband MCP HTTP client", () => {
  it("sends bearer authentication and payload-bound idempotency headers", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ messageId: "message-1" }, { status: 201 }),
    );
    const client = new SidebandHttpClient({
      token: "test-token",
      fetch: fetchImplementation,
    });

    await expect(
      client.request("/v1/messages", {
        method: "POST",
        idempotencyKey: "send-1",
        body: { body: "hello" },
      }),
    ).resolves.toEqual({ messageId: "message-1" });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:7341/v1/messages");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ body: "hello" }),
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
          "idempotency-key": "send-1",
        }),
      }),
    );
  });

  it("rejects remote plaintext origins and cross-origin request paths", async () => {
    expect(
      () => new SidebandHttpClient({ baseUrl: "http://example.com", token: "test-token" }),
    ).toThrow(SidebandApiError);

    const client = new SidebandHttpClient({ token: "test-token" });
    await expect(client.request("//example.com/v1/agents")).rejects.toMatchObject({
      code: "SIDEBAND_INVALID_REQUEST",
    });
  });

  it("returns sanitized daemon errors without exposing the bearer token", async () => {
    const secret = "a-secret-token-that-must-not-leak";
    const client = new SidebandHttpClient({
      token: secret,
      fetch: async () =>
        Response.json(
          { error: { code: "UNAUTHORIZED", message: "Credential does not have this grant." } },
          { status: 401 },
        ),
    });

    const error = await client.request("/v1/agents").catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "SIDEBAND_HTTP_ERROR",
      status: 401,
      message: "Credential does not have this grant.",
    });
    expect(String(error)).not.toContain(secret);
  });

  it("bounds response bodies before parsing JSON", async () => {
    const client = new SidebandHttpClient({
      token: "test-token",
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        }),
    });

    await expect(client.request("/v1/agents")).rejects.toMatchObject({
      code: "SIDEBAND_INVALID_RESPONSE",
    });
  });
});
