import { describe, expect, it, vi } from "vitest";

import type { HostAdapter } from "../src/core/host-adapter.js";
import { AgentSideband } from "../src/core/sideband.js";
import type { MessageProvenance } from "../src/core/types.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";
import { T3HostAdapter } from "../src/adapters/t3.js";

function adapter(): HostAdapter {
  return {
    name: "test-host",
    capabilities: vi.fn(async () => ({
      spawn: true,
      bind: true,
      wake: true,
      context: true,
      interrupt: true,
      stop: true,
      adoptionReceipts: true,
    })),
    spawn: vi.fn(async (request) => ({
      externalId: `thread-${request.agentId}`,
      hostInstanceId: "test-local",
      providerSessionId: `session-${request.agentId}`,
      generation: 1,
      state: "idle" as const,
      stage: "adopted" as const,
      receiptId: `spawn-${request.idempotencyKey}`,
    })),
    bind: vi.fn(async (request) => ({
      externalId: request.externalId,
      hostInstanceId: request.hostInstanceId,
      providerSessionId: request.providerSessionId,
      generation: request.generation,
      state: "idle" as const,
      stage: "observed" as const,
      receiptId: `bind-${request.idempotencyKey}`,
    })),
    send: vi.fn(async (request) => ({
      stage: "accepted" as const,
      receiptId: `send-${request.messageId}`,
    })),
    interrupt: vi.fn(async () => ({ stage: "accepted" as const, receiptId: "interrupt-1" })),
    stop: vi.fn(async () => ({ stage: "observed" as const, receiptId: "stop-1" })),
    inspect: vi.fn(async () => ({ state: "idle" as const })),
  };
}

function provenance(): MessageProvenance {
  return {
    authenticatedPrincipalId: "agent:sender",
    source: "mcp",
    sourceInstanceId: "t3-local",
    sourceOperationId: null,
    trust: "untrusted",
  };
}

describe("Agent Sideband host coordination", () => {
  it("spawns once for an idempotent request and records a generational binding", async () => {
    const store = SqliteSidebandStore.open(":memory:");
    const host = adapter();
    const sideband = new AgentSideband({ store, adapters: [host] });
    const request = {
      principalId: "agent:lead",
      idempotencyKey: "spawn-1",
      agentId: "reviewer",
      adapter: "test-host",
      parentAgentId: null,
      prompt: "Review the change.",
      provider: "provider-1",
      metadata: { projectId: "project-1" },
    } as const;

    const first = await sideband.spawnAgent(request);
    const second = await sideband.spawnAgent(request);

    expect(second).toEqual(first);
    expect(host.spawn).toHaveBeenCalledOnce();
    expect(host.capabilities).toHaveBeenCalledOnce();
    expect(first.operation.stage).toBe("adopted");
    expect(first.binding).toEqual(
      expect.objectContaining({
        adapter: "test-host",
        externalId: "thread-reviewer",
        hostInstanceId: "test-local",
        providerSessionId: "session-reviewer",
        generation: 1,
        active: true,
      }),
    );
    store.close();
  });

  it("atomically claims concurrent idempotent dispatch so the host is invoked once", async () => {
    const store = SqliteSidebandStore.open(":memory:");
    const host = adapter();
    let releaseSpawn: (() => void) | undefined;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    vi.mocked(host.spawn).mockImplementationOnce(async (request) => {
      await spawnGate;
      return {
        externalId: `thread-${request.agentId}`,
        hostInstanceId: "test-local",
        stage: "accepted",
        receiptId: "spawn-concurrent",
      };
    });
    const sideband = new AgentSideband({ store, adapters: [host] });
    const request = {
      principalId: "agent:lead",
      idempotencyKey: "spawn-concurrent-1",
      agentId: "concurrent-worker",
      adapter: "test-host",
      parentAgentId: null,
      prompt: "Start exactly once.",
      provider: "provider-1",
      metadata: {},
    } as const;

    const winner = sideband.spawnAgent(request);
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledOnce());
    const loser = await sideband.spawnAgent(request);

    expect(loser).toEqual({
      operation: expect.objectContaining({
        kind: "spawn",
        stage: "dispatching",
        dispatchOwnerId: expect.any(String),
      }),
      binding: null,
    });
    expect(host.spawn).toHaveBeenCalledOnce();

    releaseSpawn?.();
    const completed = await winner;
    expect(completed.operation.stage).toBe("accepted");
    expect(host.spawn).toHaveBeenCalledOnce();
    store.close();
  });

  it("binds a pre-existing host session through an explicit durable operation", async () => {
    const store = SqliteSidebandStore.open(":memory:");
    store.registerAgent({ agentId: "reviewer" });
    const host = adapter();
    const sideband = new AgentSideband({ store, adapters: [host] });
    const result = await sideband.bindAgent({
      principalId: "service:t3",
      idempotencyKey: "bind-1",
      agentId: "reviewer",
      adapter: "test-host",
      externalId: "thread-existing",
      hostInstanceId: "test-local",
      providerSessionId: "provider-session-1",
      generation: 7,
      metadata: {},
    });

    expect(result.operation).toEqual(expect.objectContaining({ kind: "bind", stage: "observed" }));
    expect(result.binding).toEqual(
      expect.objectContaining({ externalId: "thread-existing", generation: 7 }),
    );
    expect(host.bind).toHaveBeenCalledOnce();
    store.close();
  });

  it("records host notification independently and leaves the mailbox pending", async () => {
    const store = SqliteSidebandStore.open(":memory:");
    store.registerAgent({ agentId: "sender" });
    store.registerAgent({ agentId: "recipient" });
    const binding = store.bindAgent({
      bindingId: "binding-recipient",
      agentId: "recipient",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-recipient",
      providerSessionId: "provider-session-recipient",
      generation: 1,
      state: "idle",
      actorPrincipalId: "service:t3",
    });
    const message = store.sendMessage({
      idempotencyKey: "message-1",
      fromAgentId: "sender",
      target: { type: "agent", id: "recipient" },
      correlationId: "task-1",
      body: "Please continue.",
      messageClass: "request",
      provenance: provenance(),
    });
    const host = adapter();
    const sideband = new AgentSideband({ store, adapters: [host] });

    // Crash seam: the send committed, but dispatch was never acquired.
    store.beginOperation({
      principalId: "service:t3",
      idempotencyKey: "notify-1",
      kind: "send",
      adapter: binding.adapter,
      agentId: binding.agentId,
      bindingId: binding.bindingId,
      messageId: message.messageId,
      correlationId: message.correlationId,
      request: { bindingId: binding.bindingId, messageId: message.messageId, mode: "wake" },
    });

    const result = await sideband.sendMessageToHost({
      principalId: "service:t3",
      idempotencyKey: "notify-1",
      bindingId: binding.bindingId,
      messageId: message.messageId,
      mode: "wake",
    });

    expect(result.operation.stage).toBe("accepted");
    expect(store.getDelivery(message.messageId, "recipient").status).toBe("pending");
    expect(store.listInbox("recipient")).toHaveLength(1);
    expect(host.send).toHaveBeenCalledOnce();

    store.bindAgent({
      bindingId: "binding-recipient-new",
      agentId: "recipient",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-recipient",
      providerSessionId: "provider-session-recipient-new",
      generation: 2,
      state: "idle",
      actorPrincipalId: "service:t3",
    });
    const replay = await sideband.sendMessageToHost({
      principalId: "service:t3",
      idempotencyKey: "notify-1",
      bindingId: binding.bindingId,
      messageId: message.messageId,
      mode: "wake",
    });
    expect(replay.operation).toEqual(result.operation);
    expect(replay.binding?.bindingId).toBe(binding.bindingId);
    expect(host.send).toHaveBeenCalledOnce();
    store.close();
  });

  it("rejects superseded and expired explicit binding IDs before host send", async () => {
    const store = SqliteSidebandStore.open(":memory:", {
      now: () => "2026-09-21T12:00:00.000Z",
    });
    store.registerAgent({ agentId: "sender" });
    store.registerAgent({ agentId: "recipient" });
    const oldBinding = store.bindAgent({
      bindingId: "binding-old",
      agentId: "recipient",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-recipient",
      generation: 1,
      state: "idle",
      actorPrincipalId: "service:t3",
    });
    store.bindAgent({
      bindingId: "binding-current",
      agentId: "recipient",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-recipient",
      generation: 2,
      state: "idle",
      actorPrincipalId: "service:t3",
    });
    const message = store.sendMessage({
      idempotencyKey: "message-binding-check",
      fromAgentId: "sender",
      target: { type: "agent", id: "recipient" },
      correlationId: "binding-check",
      body: "Use only the current live binding.",
      messageClass: "request",
      provenance: provenance(),
    });
    const host = adapter();
    const sideband = new AgentSideband({ store, adapters: [host] });

    await expect(
      sideband.sendMessageToHost({
        principalId: "service:t3",
        idempotencyKey: "notify-old",
        bindingId: oldBinding.bindingId,
        messageId: message.messageId,
        mode: "wake",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "BINDING_CONFLICT" }));

    const expired = store.bindAgent({
      bindingId: "binding-expired",
      agentId: "recipient",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-recipient",
      generation: 3,
      state: "idle",
      leaseExpiresAt: "2026-09-21T11:59:59.000Z",
      actorPrincipalId: "service:t3",
    });
    await expect(
      sideband.sendMessageToHost({
        principalId: "service:t3",
        idempotencyKey: "notify-expired",
        bindingId: expired.bindingId,
        messageId: message.messageId,
        mode: "wake",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "BINDING_NOT_FOUND" }));
    expect(host.send).not.toHaveBeenCalled();
    store.close();
  });

  it("marks thrown adapter outcomes indeterminate and retries by the same operation identity", async () => {
    const store = SqliteSidebandStore.open(":memory:");
    const host = adapter();
    vi.mocked(host.spawn).mockRejectedValueOnce(new Error("connection reset after send"));
    const sideband = new AgentSideband({ store, adapters: [host] });
    const request = {
      principalId: "agent:lead",
      idempotencyKey: "spawn-ambiguous",
      agentId: "worker",
      adapter: "test-host",
      parentAgentId: null,
      prompt: "Start.",
      provider: "provider-1",
      metadata: {},
    } as const;

    const first = await sideband.spawnAgent(request);
    const replay = await sideband.spawnAgent(request);

    expect(first.operation).toEqual(
      expect.objectContaining({
        stage: "indeterminate",
        errorCode: "HOST_ADAPTER_ERROR",
        errorMessage: "Host adapter threw without a structured receipt.",
      }),
    );
    expect(first.binding).toBeNull();
    expect(replay).toEqual(first);
    expect(host.spawn).toHaveBeenCalledOnce();
    await expect(
      sideband.reconcileOperation({
        operationId: first.operation.operationId,
        receipt: { stage: "observed", receiptId: "t3-reconciled-1" },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        stage: "observed",
        hostReceiptId: "t3-reconciled-1",
        errorCode: null,
      }),
    );
    store.close();
  });

  it("uses the active generation for interrupt and stop operations", async () => {
    const store = SqliteSidebandStore.open(":memory:");
    store.registerAgent({ agentId: "worker" });
    store.bindAgent({
      bindingId: "old",
      agentId: "worker",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-worker",
      generation: 1,
      state: "idle",
      actorPrincipalId: "service:t3",
    });
    store.bindAgent({
      bindingId: "current",
      agentId: "worker",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-worker",
      generation: 2,
      state: "running",
      actorPrincipalId: "service:t3",
    });
    const host = adapter();
    const sideband = new AgentSideband({ store, adapters: [host] });

    const interrupted = await sideband.interruptAgent({
      principalId: "agent:lead",
      agentId: "worker",
      idempotencyKey: "interrupt-1",
    });
    store.bindAgent({
      bindingId: "replacement",
      agentId: "worker",
      adapter: "test-host",
      hostInstanceId: "test-local",
      externalId: "thread-worker",
      generation: 3,
      state: "running",
      actorPrincipalId: "service:t3",
    });
    const interruptReplay = await sideband.interruptAgent({
      principalId: "agent:lead",
      agentId: "worker",
      idempotencyKey: "interrupt-1",
    });
    store.registerAgent({ agentId: "other-worker" });
    await expect(
      sideband.interruptAgent({
        principalId: "agent:lead",
        agentId: "other-worker",
        idempotencyKey: "interrupt-1",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    await sideband.stopAgent({
      principalId: "agent:lead",
      agentId: "worker",
      idempotencyKey: "stop-1",
    });

    expect(host.interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ bindingId: "current", generation: 2 }),
      }),
    );
    expect(interruptReplay.operation).toEqual(interrupted.operation);
    expect(interruptReplay.binding?.bindingId).toBe("current");
    expect(host.interrupt).toHaveBeenCalledOnce();
    expect(host.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ bindingId: "replacement", generation: 3 }),
      }),
    );
    store.close();
  });

  it("persists the exact T3 request before I/O and replays only those bytes after an ambiguous send", async () => {
    let clock = "2026-10-08T12:00:00.000Z";
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      );
    const bodiesAtDispatch: string[] = [];
    const store = SqliteSidebandStore.open(":memory:", { now: () => clock });
    let dispatches = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/.well-known/t3/environment") {
        return json({
          environmentId: "environment-1",
          label: "Local T3",
          platform: {},
          serverVersion: "test",
          capabilities: {},
        });
      }
      if (path.startsWith("/api/orchestration/threads/")) {
        return json({
          snapshotSequence: 1,
          thread: {
            id: "thread-a",
            runtimeMode: "auto",
            interactionMode: "default",
            session: null,
          },
        });
      }
      // The prepared row must already be durable when the mutation reaches the host.
      expect(store.getPreparedRequest(lastOperationId(), "wake")).not.toBeNull();
      bodiesAtDispatch.push(String(init?.body));
      dispatches += 1;
      if (dispatches === 1) throw new TypeError("socket hang up after write");
      return json({ sequence: 9 });
    });
    const lastOperationId = () =>
      (
        store.database
          .prepare("SELECT operation_id FROM operations ORDER BY created_at DESC LIMIT 1")
          .get() as { operation_id: string }
      ).operation_id;
    const t3 = new T3HostAdapter({
      baseUrl: "http://127.0.0.1:3773",
      token: "t3-token",
      fetch: fetchMock,
      now: () => clock,
    });
    const sideband = new AgentSideband({ store, adapters: [t3] });
    store.registerAgent({ agentId: "a" });
    store.bindAgent({
      bindingId: "binding-a",
      agentId: "a",
      adapter: "t3",
      hostInstanceId: "environment-1",
      externalId: "thread-a",
      state: "idle",
      actorPrincipalId: "operator",
    });
    const message = store.sendMessage({
      idempotencyKey: "m1",
      fromAgentId: "a",
      target: { type: "agent", id: "a" },
      correlationId: "c1",
      body: "Wake up.",
      messageClass: "request",
      provenance: provenance(),
    });
    const send = {
      principalId: "principal-a",
      idempotencyKey: "wake-1",
      bindingId: "binding-a",
      messageId: message.messageId,
      mode: "wake" as const,
    };

    const first = await sideband.sendMessageToHost(send);
    expect(first.operation).toMatchObject({
      stage: "indeterminate",
      errorCode: "T3_NETWORK_ERROR",
    });
    expect((await sideband.sendMessageToHost(send)).operation.stage).toBe("indeterminate");
    expect(dispatches).toBe(1);

    clock = "2026-10-08T13:00:00.000Z";
    const replayed = await sideband.sendMessageToHost({ ...send, replayIndeterminate: true });
    expect(replayed.operation).toMatchObject({
      operationId: first.operation.operationId,
      stage: "accepted",
      hostReceiptId: "t3:environment-1:sequence:9",
    });
    expect(bodiesAtDispatch).toHaveLength(2);
    expect(bodiesAtDispatch[1]).toBe(bodiesAtDispatch[0]);
    expect(JSON.parse(bodiesAtDispatch[0]!)).toMatchObject({
      createdAt: "2026-10-08T12:00:00.000Z",
    });
    expect(bodiesAtDispatch[0]).not.toContain("t3-token");
  });
});
