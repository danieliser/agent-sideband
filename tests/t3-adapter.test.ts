import { describe, expect, it, vi } from "vitest";

import { T3AdapterError, T3HostAdapter } from "../src/adapters/t3.js";
import type { AgentBinding } from "../src/core/types.js";

const TOKEN = "t3-test-token-do-not-leak";
const NOW = "2026-09-21T10:00:00.000Z";
const T3_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function environmentResponse(): Response {
  return jsonResponse({
    environmentId: "environment-1",
    label: "Local T3",
    platform: { os: "macos", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  });
}

function makeAdapter(fetchMock: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new T3HostAdapter({
    baseUrl: "http://127.0.0.1:3773",
    token: TOKEN,
    fetch: fetchMock,
    now: () => NOW,
    timeoutMs: 100,
    ...overrides,
  });
}

function binding(overrides: Partial<AgentBinding> = {}): AgentBinding {
  return {
    bindingId: "binding-1",
    agentId: "reviewer",
    adapter: "t3",
    hostInstanceId: "environment-1",
    externalId: "thread-1",
    providerSessionId: null,
    generation: 1,
    state: "idle",
    active: true,
    capabilities: {},
    metadata: {},
    leaseExpiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("T3HostAdapter", () => {
  it("rejects non-loopback targets by default and never accepts URL credentials", () => {
    expect(
      () => new T3HostAdapter({ baseUrl: "https://t3.example.com", token: TOKEN }),
    ).toThrowError(expect.objectContaining({ code: "T3_REMOTE_URL_REJECTED" }));
    expect(
      () => new T3HostAdapter({ baseUrl: "http://user:secret@127.0.0.1:3773", token: TOKEN }),
    ).toThrowError(expect.objectContaining({ code: "T3_INVALID_URL" }));

    expect(
      () =>
        new T3HostAdapter({
          baseUrl: "https://t3.example.com",
          token: TOKEN,
          allowRemote: true,
        }),
    ).not.toThrow();
  });

  it("advertises only the semantics T3 HEAD actually supports", async () => {
    const adapter = makeAdapter(vi.fn<typeof fetch>());
    await expect(adapter.capabilities()).resolves.toEqual({
      spawn: true,
      bind: true,
      wake: true,
      context: false,
      interrupt: true,
      stop: true,
      adoptionReceipts: false,
    });
  });

  it("reads snapshots and thread detail with the configured bearer token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ snapshotSequence: 7, projects: [], threads: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          snapshotSequence: 8,
          thread: {
            id: "thread-1",
            runtimeMode: "full-access",
            interactionMode: "default",
            session: null,
          },
        }),
      );
    const adapter = makeAdapter(fetchMock);

    await expect(adapter.readSnapshot()).resolves.toEqual(
      expect.objectContaining({ snapshotSequence: 7 }),
    );
    await expect(adapter.readThread("thread-1")).resolves.toEqual(
      expect.objectContaining({ snapshotSequence: 8 }),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:3773/api/orchestration/snapshot",
      "http://127.0.0.1:3773/api/orchestration/threads/thread-1",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(init?.redirect).toBe("error");
    }
  });

  it("spawns with separate deterministic thread.create and thread.turn.start commands", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(environmentResponse())
      .mockResolvedValueOnce(jsonResponse({ sequence: 41 }))
      .mockResolvedValueOnce(jsonResponse({ sequence: 43 }));
    const adapter = makeAdapter(fetchMock);
    const request = {
      idempotencyKey: "spawn-reviewer-1",
      operationId: "operation-spawn-1",
      agentId: "reviewer",
      parentAgentId: "lead",
      prompt: "Review the current change.",
      provider: "provider-work",
      metadata: {
        projectId: "project-1",
        model: "model-1",
        threadId: "thread-sideband-reviewer",
        title: "Sideband reviewer",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    } as const;

    const receipt = await adapter.spawn(request);

    expect(receipt).toEqual(
      expect.objectContaining({
        stage: "accepted",
        externalId: "thread-sideband-reviewer",
        hostInstanceId: "environment-1",
        state: "starting",
      }),
    );
    expect(receipt.detail).toEqual(
      expect.objectContaining({
        evidence: "t3-command-accepted",
        providerAdoption: "unconfirmed",
        threadCreateSequence: 41,
        turnStartSequence: 43,
      }),
    );

    const create = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    const start = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(create).toEqual({
      type: "thread.create",
      commandId: expect.stringMatching(/^sideband:t3:thread-create:/),
      threadId: "thread-sideband-reviewer",
      projectId: "project-1",
      title: "Sideband reviewer",
      modelSelection: { instanceId: "provider-work", model: "model-1" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
    expect(start).toEqual({
      type: "thread.turn.start",
      commandId: expect.stringMatching(/^sideband:t3:turn-start:/),
      threadId: "thread-sideband-reviewer",
      message: {
        messageId: expect.stringMatching(/^sideband:t3:message:/),
        role: "user",
        text: "Review the current change.",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: NOW,
    });

    const retryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          environmentId: "environment-1",
          label: "Local T3",
          platform: { os: "macos", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sequence: 41 }))
      .mockResolvedValueOnce(jsonResponse({ sequence: 43 }));
    await makeAdapter(retryFetch).spawn(request);
    const retryCreate = JSON.parse(String(retryFetch.mock.calls[1]?.[1]?.body)) as {
      commandId: string;
    };
    const retryStart = JSON.parse(String(retryFetch.mock.calls[2]?.[1]?.body)) as {
      commandId: string;
    };
    expect(retryCreate.commandId).toBe(create.commandId);
    expect(retryStart.commandId).toBe(start.commandId);
  });

  it("binds only to a thread in the expected T3 environment", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          environmentId: "environment-1",
          label: "Local T3",
          platform: { os: "macos", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          snapshotSequence: 10,
          thread: {
            id: "thread-1",
            runtimeMode: "full-access",
            interactionMode: "default",
            session: { status: "ready", activeTurnId: null },
          },
        }),
      );
    const adapter = makeAdapter(fetchMock);

    await expect(
      adapter.bind({
        idempotencyKey: "bind-1",
        operationId: "operation-bind-1",
        agentId: "reviewer",
        externalId: "thread-1",
        hostInstanceId: "environment-1",
        metadata: {},
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        stage: "observed",
        externalId: "thread-1",
        hostInstanceId: "environment-1",
        state: "idle",
      }),
    );

    await expect(
      adapter.bind({
        idempotencyKey: "bind-wrong-environment",
        operationId: "operation-bind-wrong-environment",
        agentId: "reviewer",
        externalId: "thread-1",
        hostInstanceId: "different-environment",
        metadata: {},
      }),
    ).resolves.toEqual({
      stage: "failed",
      receiptId: null,
      errorCode: "T3_BINDING_MISMATCH",
      errorMessage: "Binding targets a different T3 environment.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a partial spawn as indeterminate when create succeeds but start is rejected", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(environmentResponse())
      .mockResolvedValueOnce(jsonResponse({ sequence: 50 }))
      .mockResolvedValueOnce(new Response(`sensitive ${TOKEN}`, { status: 400 }));
    const adapter = makeAdapter(fetchMock);

    const receipt = await adapter.spawn({
      idempotencyKey: "spawn-partial",
      operationId: "operation-spawn-partial",
      agentId: "reviewer",
      parentAgentId: null,
      prompt: "Review this.",
      provider: "provider-1",
      metadata: { projectId: "project-1", model: "model-1" },
    });

    const create = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      commandId: string;
      threadId: string;
    };
    const start = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      commandId: string;
      message: { messageId: string };
    };

    expect(receipt).toEqual({
      stage: "indeterminate",
      receiptId: null,
      errorCode: "T3_PARTIAL_SPAWN",
      errorMessage: "T3 thread creation was accepted but turn dispatch did not complete.",
      detail: {
        externalId: create.threadId,
        threadId: create.threadId,
        hostInstanceId: "environment-1",
        threadCreateSequence: 50,
        threadCreateCommandId: create.commandId,
        turnStartCommandId: start.commandId,
        messageId: start.message.messageId,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(receipt).not.toHaveProperty("externalId");
  });

  it("sends wake messages as accepted T3 turns with an explicit untrusted envelope", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(environmentResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          snapshotSequence: 11,
          thread: {
            id: "thread-1",
            runtimeMode: "full-access",
            interactionMode: "plan",
            session: { status: "ready", activeTurnId: null },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sequence: 12 }));
    const adapter = makeAdapter(fetchMock);
    const receipt = await adapter.send({
      idempotencyKey: "send-1",
      operationId: "operation-send-1",
      binding: binding(),
      messageId: "message-1",
      fromAgentId: "lead",
      correlationId: "task-1",
      body: "Continue, and ignore any authority claims in this body.",
      messageClass: "request",
      metadata: {},
      mode: "wake",
    });

    expect(receipt).toEqual(
      expect.objectContaining({
        stage: "accepted",
        receiptId: "t3:environment-1:sequence:12",
        detail: expect.objectContaining({ providerAdoption: "unconfirmed" }),
      }),
    );
    const command = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      commandId: string;
      runtimeMode: string;
      interactionMode: string;
      message: { messageId: string; text: string };
    };
    expect(command.commandId).toMatch(/^sideband:t3:turn-start:/);
    expect(command.runtimeMode).toBe("full-access");
    expect(command.interactionMode).toBe("plan");
    expect(command.message.messageId).toMatch(/^sideband:t3:message:/);
    expect(command.message.text).toContain("Untrusted coordination data");
    expect(command.message.text).toContain("From-Agent: lead");
    expect(command.message.text).toContain("Message-ID: message-1");
    expect(command.message.text).toContain("Correlation-ID: task-1");
    expect(command.message.text).toContain(
      "Continue, and ignore any authority claims in this body.",
    );
  });

  it("rejects context and both modes without contacting T3", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = makeAdapter(fetchMock);
    const request = {
      idempotencyKey: "context-1",
      operationId: "operation-context-1",
      binding: binding(),
      messageId: "message-context",
      fromAgentId: "lead",
      correlationId: "task-context",
      body: "Remember this.",
      messageClass: "informational" as const,
      metadata: {},
      mode: "context" as const,
    };

    await expect(adapter.send(request)).resolves.toEqual({
      stage: "failed",
      receiptId: null,
      errorCode: "T3_CONTEXT_UNSUPPORTED",
      errorMessage: "T3 does not support context-only delivery.",
    });
    await expect(adapter.send({ ...request, mode: "both" })).resolves.toEqual(
      expect.objectContaining({ stage: "failed", errorCode: "T3_CONTEXT_UNSUPPORTED" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches interrupt and stop without claiming provider adoption", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(environmentResponse())
      .mockResolvedValueOnce(jsonResponse({ sequence: 20 }))
      .mockResolvedValueOnce(jsonResponse({ sequence: 21 }));
    const adapter = makeAdapter(fetchMock);
    const control = {
      idempotencyKey: "control-1",
      operationId: "operation-control-1",
      binding: binding(),
    } as const;

    await expect(adapter.interrupt(control)).resolves.toEqual(
      expect.objectContaining({
        stage: "accepted",
        detail: expect.objectContaining({ providerAdoption: "unconfirmed" }),
      }),
    );
    await expect(adapter.stop({ ...control, idempotencyKey: "control-2" })).resolves.toEqual(
      expect.objectContaining({ stage: "accepted" }),
    );
    const interrupt = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    const stop = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(interrupt).toEqual({
      type: "thread.turn.interrupt",
      commandId: expect.stringMatching(/^sideband:t3:turn-interrupt:/),
      threadId: "thread-1",
      createdAt: NOW,
    });
    expect(stop).toEqual({
      type: "thread.session.stop",
      commandId: expect.stringMatching(/^sideband:t3:session-stop:/),
      threadId: "thread-1",
      createdAt: NOW,
    });
  });

  it("maps a thread snapshot to host inspection state", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(environmentResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          snapshotSequence: 31,
          thread: {
            id: "thread-1",
            runtimeMode: "full-access",
            interactionMode: "default",
            session: {
              status: "running",
              providerName: "provider-driver",
              providerInstanceId: "provider-work",
              activeTurnId: "turn-1",
              lastError: null,
            },
          },
        }),
      );
    const adapter = makeAdapter(fetchMock);

    await expect(adapter.inspect(binding())).resolves.toEqual({
      state: "running",
      detail: {
        snapshotSequence: 31,
        threadId: "thread-1",
        sessionStatus: "running",
        providerName: "provider-driver",
        providerInstanceId: "provider-work",
        activeTurnId: "turn-1",
        lastError: null,
      },
    });
  });

  it("returns an indeterminate sanitized receipt when dispatch times out", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(environmentResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          snapshotSequence: 40,
          thread: {
            id: "thread-1",
            runtimeMode: "full-access",
            interactionMode: "default",
            session: null,
          },
        }),
      )
      .mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error(`leaked ${TOKEN}`)));
          }),
      );
    const adapter = makeAdapter(fetchMock, { timeoutMs: 5 });

    const receipt = await adapter.send({
      idempotencyKey: "send-timeout",
      operationId: "operation-send-timeout",
      binding: binding(),
      messageId: "message-timeout",
      fromAgentId: "lead",
      correlationId: "task-timeout",
      body: "Continue.",
      messageClass: "request",
      metadata: {},
      mode: "wake",
    });

    expect(receipt).toEqual({
      stage: "indeterminate",
      receiptId: null,
      errorCode: "T3_TIMEOUT",
      errorMessage: "T3 request timed out.",
    });
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  });

  it("times out when response headers arrive but the body never completes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"snapshotSequence":'));
          init?.signal?.addEventListener("abort", () => {
            controller.error(new Error(`sensitive ${TOKEN}`));
          });
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    });
    const adapter = makeAdapter(fetchMock, { timeoutMs: 5 });

    const error = await adapter.readSnapshot().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(T3AdapterError);
    expect(error).toEqual(expect.objectContaining({ code: "T3_TIMEOUT" }));
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("bounds response bytes and sanitizes oversized or invalid JSON failures", async () => {
    const oversizedBody = new Uint8Array(T3_MAX_RESPONSE_BYTES + 1);
    oversizedBody.fill(0x20);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(oversizedBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(`{"invalid": sensitive-${TOKEN}}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const adapter = makeAdapter(fetchMock);

    const oversizedError = await adapter.readSnapshot().catch((cause: unknown) => cause);
    const invalidJsonError = await adapter.readSnapshot().catch((cause: unknown) => cause);

    for (const error of [oversizedError, invalidJsonError]) {
      expect(error).toBeInstanceOf(T3AdapterError);
      expect(error).toEqual(expect.objectContaining({ code: "T3_INVALID_RESPONSE" }));
      expect(String(error)).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  });

  it("sanitizes HTTP response bodies and bearer tokens from thrown read errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(`sensitive response containing ${TOKEN}`, { status: 500 }),
      );
    const adapter = makeAdapter(fetchMock);

    const error = await adapter.readSnapshot().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(T3AdapterError);
    expect(error).toEqual(expect.objectContaining({ code: "T3_HTTP_ERROR", status: 500 }));
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  describe("operation-scoped, frozen host requests", () => {
    const threadResponse = (runtimeMode = "full-access", interactionMode = "default") =>
      jsonResponse({
        snapshotSequence: 60,
        thread: { id: "thread-1", runtimeMode, interactionMode, session: null },
      });
    const sendRequest = (operationId: string, idempotencyKey = "shared-caller-key") => ({
      idempotencyKey,
      operationId,
      binding: binding(),
      messageId: "message-1",
      fromAgentId: "lead",
      correlationId: "task-1",
      body: "Continue.",
      messageClass: "request" as const,
      metadata: {},
      leg: "wake" as const,
    });

    it("derives command and message IDs from the operation, never the caller key", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockResolvedValueOnce(threadResponse())
        .mockResolvedValueOnce(threadResponse())
        .mockResolvedValueOnce(threadResponse());
      const adapter = makeAdapter(fetchMock);
      const first = await adapter.prepare(sendRequest("operation-a"));
      const collidingKey = await adapter.prepare(sendRequest("operation-b"));
      const sameOperation = await adapter.prepare(sendRequest("operation-a", "another-key"));
      if ("stage" in first || "stage" in collidingKey || "stage" in sameOperation) {
        throw new Error("expected prepared requests");
      }
      expect(first.replaySafe).toBe(true);
      expect(first.payload.commandId).not.toBe(collidingKey.payload.commandId);
      expect((first.payload.message as { messageId: string }).messageId).not.toBe(
        (collidingKey.payload.message as { messageId: string }).messageId,
      );
      expect(sameOperation.payload.commandId).toBe(first.payload.commandId);
      expect(JSON.stringify(first)).not.toContain(TOKEN);
    });

    it("executes the stored payload byte-for-byte even after thread modes and the clock change", async () => {
      let clock = NOW;
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockResolvedValueOnce(threadResponse("full-access", "plan"))
        .mockResolvedValueOnce(jsonResponse({ sequence: 61 }))
        .mockResolvedValueOnce(jsonResponse({ sequence: 61 }));
      const adapter = makeAdapter(fetchMock, { now: () => clock });
      const prepared = await adapter.prepare(sendRequest("operation-frozen"));
      if ("stage" in prepared) throw new Error("expected prepared request");
      clock = "2026-09-21T11:00:00.000Z";
      const stored = JSON.parse(JSON.stringify(prepared)) as typeof prepared;
      const first = await adapter.execute({
        operationId: "operation-frozen",
        binding: binding(),
        prepared: stored,
      });
      const replay = await adapter.execute({
        operationId: "operation-frozen",
        binding: binding(),
        prepared: stored,
      });
      expect(first).toMatchObject({ stage: "accepted", receiptId: "t3:environment-1:sequence:61" });
      expect(replay).toMatchObject({
        stage: "accepted",
        receiptId: "t3:environment-1:sequence:61",
      });
      const bodies = fetchMock.mock.calls.slice(2).map(([, init]) => String(init?.body));
      expect(bodies[0]).toBe(bodies[1]);
      expect(JSON.parse(bodies[0]!)).toMatchObject({
        createdAt: NOW,
        interactionMode: "plan",
        commandId: prepared.payload.commandId,
      });
    });

    it("refuses to retarget a stored request to another thread", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockResolvedValueOnce(threadResponse());
      const adapter = makeAdapter(fetchMock);
      const prepared = await adapter.prepare(sendRequest("operation-pinned"));
      if ("stage" in prepared) throw new Error("expected prepared request");
      await expect(
        adapter.execute({
          operationId: "operation-pinned",
          binding: binding({ externalId: "thread-2" }),
          prepared,
        }),
      ).resolves.toMatchObject({ stage: "failed", errorCode: "T3_BINDING_MISMATCH" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reports an unreachable host during prepare as a retryable no-effect failure", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const adapter = makeAdapter(fetchMock);
      await expect(adapter.prepare(sendRequest("operation-down"))).resolves.toEqual({
        stage: "failed",
        receiptId: null,
        errorCode: "T3_NETWORK_ERROR",
        errorMessage: "T3 request failed before a response.",
        retryable: true,
      });
      await expect(
        adapter.prepare({ ...sendRequest("operation-context"), leg: "context" }),
      ).resolves.toMatchObject({
        stage: "failed",
        errorCode: "T3_CONTEXT_UNSUPPORTED",
        retryable: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("derives spawn thread and command IDs from the operation ID", async () => {
      const spawnRequest = (operationId: string) => ({
        idempotencyKey: "same-key",
        operationId,
        agentId: "reviewer",
        parentAgentId: null,
        prompt: "Review.",
        provider: "provider-work",
        metadata: { projectId: "project-1", model: "model-1" },
      });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockImplementation(() => Promise.resolve(jsonResponse({ sequence: 70 })));
      const adapter = makeAdapter(fetchMock);
      const first = await adapter.spawn(spawnRequest("operation-spawn-a"));
      const second = await adapter.spawn(spawnRequest("operation-spawn-b"));
      if (first.stage !== "accepted" || second.stage !== "accepted") {
        throw new Error("expected accepted spawns");
      }
      expect(first.externalId).not.toBe(second.externalId);
      expect(first.detail?.threadCreateCommandId).not.toBe(second.detail?.threadCreateCommandId);
    });
  });

  describe("managed spawn plan", () => {
    const planRequest = (operationId: string, metadata: Record<string, unknown> = {}) => ({
      operationId,
      agentId: "reviewer",
      provider: "provider-work",
      metadata: { projectId: "project-1", model: "model-1", ...metadata },
    });
    const spawnRequest = (
      operationId: string,
      plan: { hostInstanceId: string; externalId: string } | undefined,
      metadata: Record<string, unknown> = {},
    ) => ({
      idempotencyKey: "managed-key",
      operationId,
      agentId: "reviewer",
      parentAgentId: null,
      prompt: "Review.",
      provider: "provider-work",
      metadata: { projectId: "project-1", model: "model-1", ...metadata },
      ...(plan === undefined ? {} : { plan }),
    });
    const dispatched = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

    it("reserves the thread id the legacy spawn would have generated, from the trusted environment", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(environmentResponse());
      const adapter = makeAdapter(fetchMock);
      expect(adapter.reservedSpawnMetadata).toEqual(["threadId"]);

      const plan = await adapter.planSpawn(planRequest("operation-plan-1"));
      expect(plan).toEqual({
        hostInstanceId: "environment-1",
        externalId: expect.stringMatching(/^sideband-[0-9a-f]{32}$/),
      });
      // Deterministic for an operation, distinct across operations.
      await expect(adapter.planSpawn(planRequest("operation-plan-1"))).resolves.toEqual(plan);
      const other = await adapter.planSpawn(planRequest("operation-plan-2"));
      expect(other.externalId).not.toBe(plan.externalId);

      // Planning is read-only: only the environment descriptor was fetched.
      expect(dispatched(fetchMock)).toEqual([]);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        "http://127.0.0.1:3773/.well-known/t3/environment",
      ]);

      // The same id an unmanaged spawn of that operation would have created.
      const legacyFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockImplementation(() => Promise.resolve(jsonResponse({ sequence: 1 })));
      const legacy = await makeAdapter(legacyFetch).spawn(
        spawnRequest("operation-plan-1", undefined),
      );
      expect(legacy).toMatchObject({ externalId: plan.externalId });
    });

    it("ignores caller-supplied tuple data and refuses a caller-chosen thread id when planning", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(environmentResponse());
      const adapter = makeAdapter(fetchMock);
      const clean = await adapter.planSpawn(planRequest("operation-plan-1"));
      await expect(
        adapter.planSpawn(planRequest("operation-plan-1", { threadId: "someone-elses-thread" })),
      ).rejects.toMatchObject({ code: "T3_INVALID_REQUEST" });
      await expect(
        adapter.planSpawn(
          planRequest("operation-plan-1", { hostInstanceId: "evil-env", externalId: "evil" }),
        ),
      ).resolves.toEqual(clean);
      await expect(adapter.planSpawn(planRequest(" "))).rejects.toMatchObject({
        code: "T3_INVALID_REQUEST",
      });
    });

    it("does not plan when the environment cannot be read", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(
        makeAdapter(fetchMock).planSpawn(planRequest("operation-plan-1")),
      ).rejects.toMatchObject({ code: "T3_NETWORK_ERROR" });
      expect(dispatched(fetchMock)).toEqual([]);
    });

    it("creates exactly the planned thread and reports exactly the planned tuple", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockImplementation(() => Promise.resolve(jsonResponse({ sequence: 9 })));
      const adapter = makeAdapter(fetchMock);
      const plan = await adapter.planSpawn(planRequest("operation-plan-1"));

      const receipt = await adapter.spawn(spawnRequest("operation-plan-1", plan));

      expect(receipt).toMatchObject({
        stage: "accepted",
        externalId: plan.externalId,
        hostInstanceId: plan.hostInstanceId,
      });
      const commands = dispatched(fetchMock);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      expect(commands.map((command) => command.threadId)).toEqual([
        plan.externalId,
        plan.externalId,
      ]);
    });

    it("refuses a caller-chosen thread id on a planned spawn before any mutation", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(environmentResponse());
      const adapter = makeAdapter(fetchMock);
      const plan = await adapter.planSpawn(planRequest("operation-plan-1"));

      for (const threadId of ["someone-elses-thread", plan.externalId]) {
        const receipt = await adapter.spawn(spawnRequest("operation-plan-1", plan, { threadId }));
        expect(receipt).toMatchObject({ stage: "failed", errorCode: "T3_INVALID_REQUEST" });
        expect(receipt).not.toHaveProperty("externalId");
      }
      expect(dispatched(fetchMock)).toEqual([]);
    });

    it("refuses a plan that is not this operation's tuple in this environment before any mutation", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(environmentResponse());
      const adapter = makeAdapter(fetchMock);
      const plan = await adapter.planSpawn(planRequest("operation-plan-1"));
      const otherOperation = await adapter.planSpawn(planRequest("operation-plan-2"));

      const forged = [
        { ...plan, externalId: "someone-elses-thread" },
        { ...plan, hostInstanceId: "environment-2" },
        otherOperation,
        { hostInstanceId: plan.hostInstanceId, externalId: "" },
      ];
      for (const candidate of forged) {
        const receipt = await adapter.spawn(spawnRequest("operation-plan-1", candidate));
        expect(receipt).toMatchObject({ stage: "failed", errorCode: "T3_INVALID_REQUEST" });
        expect(receipt).not.toHaveProperty("externalId");
      }
      expect(dispatched(fetchMock)).toEqual([]);
    });

    it("keeps a planned partial spawn pending on the planned tuple", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockResolvedValueOnce(jsonResponse({ sequence: 50 }))
        .mockResolvedValueOnce(new Response("nope", { status: 500 }));
      const adapter = makeAdapter(fetchMock);
      const plan = await adapter.planSpawn(planRequest("operation-plan-1"));

      const receipt = await adapter.spawn(spawnRequest("operation-plan-1", plan));

      expect(receipt).toMatchObject({
        stage: "indeterminate",
        errorCode: "T3_PARTIAL_SPAWN",
        detail: { externalId: plan.externalId, hostInstanceId: plan.hostInstanceId },
      });
    });

    it("preserves unmanaged behavior: a caller-chosen thread id still works without a plan", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(environmentResponse())
        .mockImplementation(() => Promise.resolve(jsonResponse({ sequence: 3 })));
      const receipt = await makeAdapter(fetchMock).spawn(
        spawnRequest("operation-legacy", undefined, { threadId: "chosen-thread" }),
      );
      expect(receipt).toMatchObject({ stage: "accepted", externalId: "chosen-thread" });
      expect(dispatched(fetchMock).map((command) => command.threadId)).toEqual([
        "chosen-thread",
        "chosen-thread",
      ]);
    });
  });
});
