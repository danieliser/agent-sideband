import { describe, expect, it, vi } from "vitest";

import { T3HostAdapter, type T3DeliveryCredential } from "../src/adapters/t3.js";
import type { HostPreparedRequest } from "../src/core/host-adapter.js";
import { AgentSideband } from "../src/core/sideband.js";
import type { AgentBinding } from "../src/core/types.js";
import { SqliteSidebandStore } from "../src/store/sqlite.js";

/**
 * HTTP/fetch contract tests for the T3 thread-scoped context route. These prove the exact requests
 * Sideband sends and how it translates T3 receipts; they do not prove provider model consumption.
 */

const ENV_TOKEN = "t3-environment-token-never-for-context";
const DELIVERY_TOKEN = "t3-thread-delivery-token-secret";
const NOW = "2026-10-08T12:00:00.000Z";
const CONTEXT_PATH = "/api/orchestration/threads/thread-1/context-injections";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

function credential(overrides: Partial<T3DeliveryCredential> = {}): T3DeliveryCredential {
  return {
    scheme: "t3-thread-mcp-v1",
    token: DELIVERY_TOKEN,
    providerSessionId: "mcp-generation-1",
    generation: 1,
    expiresAt: "2026-10-08T20:00:00.000Z",
    ...overrides,
  };
}

function capability(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    context: true,
    capability: "codex-thread-inject-items-v1",
    active: true,
    authorized: true,
    providerSessionId: "mcp-generation-1",
    providerInstanceId: "codex",
    delivery: "model-visible-history",
    timing: "next-model-request",
    startsTurn: false,
    sessionStates: ["ready"],
    modelConsumption: "unproven",
    ...overrides,
  };
}

function adopted(injectionId: string) {
  return {
    protocolVersion: 1,
    injectionId,
    stage: "provider-adopted",
    providerSessionId: "mcp-generation-1",
    acceptedAt: "2026-10-08T12:00:01.000Z",
    adoptedAt: "2026-10-08T12:00:02.000Z",
    errorCode: null,
    providerEvidence: "rpc-acknowledged",
    modelConsumption: "unproven",
  };
}

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string | undefined;
}

/** Routes the T3 surface; `context` answers POSTs to the context route. */
function t3Host(options: {
  readonly capability?: () => Response;
  readonly context?: (body: Record<string, unknown>) => Response | Promise<Response>;
  readonly dispatch?: () => Response;
}) {
  const seen: Seen[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    seen.push({
      method,
      path,
      authorization: headers.get("authorization"),
      body: init?.body === undefined ? undefined : String(init.body),
    });
    if (path === "/.well-known/t3/environment") {
      return json({
        environmentId: "environment-1",
        label: "Local T3",
        platform: {},
        serverVersion: "test",
        capabilities: {},
      });
    }
    if (path === CONTEXT_PATH && method === "GET") {
      return options.capability?.() ?? json(capability());
    }
    if (path === CONTEXT_PATH && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return (await options.context?.(body)) ?? json(adopted(String(body.injectionId)));
    }
    if (path === "/api/orchestration/threads/thread-1") {
      return json({
        snapshotSequence: 3,
        thread: { id: "thread-1", runtimeMode: "auto", interactionMode: "default", session: null },
      });
    }
    if (path === "/api/orchestration/dispatch")
      return options.dispatch?.() ?? json({ sequence: 7 });
    return json({ error: "not found" }, 404);
  });
  return { fetchMock, seen };
}

function makeAdapter(
  fetchMock: typeof fetch,
  resolve?: (binding: AgentBinding) => T3DeliveryCredential | null,
  reject?: (binding: AgentBinding, providerSessionId: string) => void,
) {
  return new T3HostAdapter({
    baseUrl: "http://127.0.0.1:3773",
    token: ENV_TOKEN,
    fetch: fetchMock,
    now: () => NOW,
    timeoutMs: 200,
    ...(resolve === undefined ? {} : { resolveDeliveryCredential: resolve }),
    ...(reject === undefined ? {} : { rejectDeliveryCredential: reject }),
  });
}

const sendRequest = {
  idempotencyKey: "send-1",
  operationId: "operation-1",
  binding: binding(),
  messageId: "message-1",
  fromAgentId: "lead",
  correlationId: "correlation-1",
  body: "Check the failing build.",
  messageClass: "request" as const,
  metadata: {},
};

async function prepareContext(adapter: T3HostAdapter) {
  return adapter.prepare({ ...sendRequest, leg: "context" });
}

function asPrepared(value: unknown): HostPreparedRequest {
  expect(value).not.toHaveProperty("stage");
  return value as HostPreparedRequest;
}

describe("T3 context capability", () => {
  it("advertises context only when a delivery credential resolver is configured", async () => {
    const { fetchMock } = t3Host({});
    expect((await makeAdapter(fetchMock).capabilities()).context).toBe(false);
    expect((await makeAdapter(fetchMock, () => credential()).capabilities()).context).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses context without a resolver and never touches the host", async () => {
    const { fetchMock } = t3Host({});
    const result = await prepareContext(makeAdapter(fetchMock));
    expect(result).toMatchObject({ stage: "failed", errorCode: "T3_CONTEXT_UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is retryable and sends nothing while no credential for the exact binding is held", async () => {
    const { fetchMock, seen } = t3Host({});
    const result = await prepareContext(makeAdapter(fetchMock, () => null));
    expect(result).toMatchObject({
      stage: "failed",
      errorCode: "CONTEXT_CREDENTIAL_UNAVAILABLE",
      retryable: true,
    });
    expect(seen.some((request) => request.path.includes("context-injections"))).toBe(false);
  });
});

describe("T3 context prepare", () => {
  it("preflights the exact thread route with the delivery bearer and freezes a secret-free payload", async () => {
    const { fetchMock, seen } = t3Host({});
    const resolved: AgentBinding[] = [];
    const prepared = asPrepared(
      await prepareContext(
        makeAdapter(fetchMock, (target) => {
          resolved.push(target);
          return credential();
        }),
      ),
    );
    expect(resolved[0]?.bindingId).toBe("binding-1");
    const preflight = seen.find((request) => request.path === CONTEXT_PATH);
    expect(preflight).toMatchObject({ method: "GET", authorization: `Bearer ${DELIVERY_TOKEN}` });
    // The environment token never reaches a context route.
    expect(
      seen.filter(
        (r) => r.path.includes("context-injections") && r.authorization?.includes(ENV_TOKEN),
      ),
    ).toEqual([]);

    expect(prepared).toMatchObject({ protocolVersion: 1, leg: "context", replaySafe: true });
    expect(prepared.payload).toEqual({
      type: "thread.context.inject",
      threadId: "thread-1",
      request: {
        injectionId: expect.stringMatching(/^sideband:t3:context:[0-9a-f]{32}$/),
        body: expect.stringContaining("Check the failing build."),
      },
    });
    const again = asPrepared(
      await prepareContext(makeAdapter(t3Host({}).fetchMock, () => credential())),
    );
    expect(again.payload).toEqual(prepared.payload);
    const serialized = JSON.stringify(prepared);
    expect(serialized).not.toContain(DELIVERY_TOKEN);
    expect(serialized).not.toContain(ENV_TOKEN);
  });

  it.each([
    ["busy session", capability({ context: false }), "T3_CONTEXT_NOT_READY", true],
    [
      "inactive thread",
      capability({ context: false, active: false }),
      "T3_CONTEXT_NOT_READY",
      true,
    ],
    [
      "missing grant",
      capability({ context: false, authorized: false }),
      "T3_CONTEXT_NOT_AUTHORIZED",
      true,
    ],
    [
      "unsupported provider",
      capability({ context: false, capability: null }),
      "T3_CONTEXT_UNSUPPORTED",
      false,
    ],
    [
      "different credential generation",
      capability({ providerSessionId: "mcp-generation-2" }),
      "CONTEXT_CREDENTIAL_UNAVAILABLE",
      true,
    ],
  ])("refuses a %s without falling back to a wake", async (_name, body, code, retryable) => {
    const { fetchMock, seen } = t3Host({ capability: () => json(body) });
    const result = await prepareContext(makeAdapter(fetchMock, () => credential()));
    expect(result).toMatchObject({ stage: "failed", errorCode: code, retryable });
    expect(seen.some((request) => request.path === "/api/orchestration/dispatch")).toBe(false);
    expect(JSON.stringify(result)).not.toContain(DELIVERY_TOKEN);
  });

  it("discards a credential the host rejects and stays retryable", async () => {
    const rejected: string[] = [];
    const { fetchMock } = t3Host({
      capability: () =>
        json({ protocolVersion: 1, error: { code: "INVALID_THREAD_CREDENTIAL" } }, 401),
    });
    const result = await prepareContext(
      makeAdapter(
        fetchMock,
        () => credential(),
        (_binding, providerSessionId) => rejected.push(providerSessionId),
      ),
    );
    expect(result).toMatchObject({
      stage: "failed",
      errorCode: "CONTEXT_CREDENTIAL_UNAVAILABLE",
      retryable: true,
    });
    expect(rejected).toEqual(["mcp-generation-1"]);
  });

  it("refuses bodies the host contract cannot carry", async () => {
    const { fetchMock } = t3Host({});
    const result = await makeAdapter(fetchMock, () => credential()).prepare({
      ...sendRequest,
      body: "x".repeat(64_001),
      leg: "context",
    });
    expect(result).toMatchObject({
      stage: "failed",
      errorCode: "T3_INVALID_REQUEST",
      retryable: false,
    });
  });
});

describe("T3 context execute receipts", () => {
  async function run(
    context: Parameters<typeof t3Host>[0]["context"],
    resolve = () => credential(),
  ) {
    const host = t3Host({ ...(context === undefined ? {} : { context }) });
    let current: T3DeliveryCredential | null = credential();
    const adapter = makeAdapter(host.fetchMock, () => current);
    const prepared = asPrepared(await prepareContext(adapter));
    current = resolve();
    const receipt = await adapter.execute({
      operationId: "operation-1",
      binding: binding(),
      prepared,
    });
    return { receipt, prepared, seen: host.seen };
  }

  it("translates a provider RPC acknowledgment into adopted with unproven consumption", async () => {
    const { receipt, prepared, seen } = await run(undefined);
    const post = seen.find((request) => request.method === "POST");
    expect(post).toMatchObject({ path: CONTEXT_PATH, authorization: `Bearer ${DELIVERY_TOKEN}` });
    expect(JSON.parse(post!.body!)).toEqual((prepared.payload as { request: unknown }).request);
    const injectionId = (prepared.payload.request as { injectionId: string }).injectionId;
    expect(receipt).toEqual({
      stage: "adopted",
      receiptId: `t3:environment-1:context:${injectionId}`,
      detail: {
        evidence: "t3-context-receipt",
        mode: "context",
        injectionId,
        hostStage: "provider-adopted",
        providerSessionId: "mcp-generation-1",
        acceptedAt: "2026-10-08T12:00:01.000Z",
        adoptedAt: "2026-10-08T12:00:02.000Z",
        errorCode: null,
        providerEvidence: "rpc-acknowledged",
        modelConsumption: "unproven",
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(DELIVERY_TOKEN);
  });

  it("keeps a 202 durable-intent receipt indeterminate instead of claiming adoption", async () => {
    const { receipt } = await run((body) =>
      json(
        {
          ...adopted(String(body.injectionId)),
          stage: "accepted",
          adoptedAt: null,
          providerEvidence: "none",
        },
        202,
      ),
    );
    expect(receipt).toMatchObject({
      stage: "indeterminate",
      errorCode: "T3_CONTEXT_PENDING",
      detail: { hostStage: "accepted", providerEvidence: "none", modelConsumption: "unproven" },
    });
  });

  it("maps an indeterminate native failure to indeterminate and a known one to terminal failed", async () => {
    const failed = (code: string) => (body: Record<string, unknown>) =>
      json(
        {
          ...adopted(String(body.injectionId)),
          stage: "failed",
          adoptedAt: null,
          errorCode: code,
          providerEvidence: "none",
        },
        502,
      );
    expect((await run(failed("HOST_OUTCOME_INDETERMINATE"))).receipt).toMatchObject({
      stage: "indeterminate",
      errorCode: "T3_CONTEXT_INDETERMINATE",
    });
    const known = (await run(failed("CONTEXT_INJECTION_UNSUPPORTED"))).receipt;
    expect(known).toMatchObject({ stage: "failed", errorCode: "T3_CONTEXT_FAILED" });
    expect(known).not.toHaveProperty("retryable", true);
  });

  it("treats a lost transport as indeterminate", async () => {
    const { receipt } = await run(() => {
      throw new TypeError("socket hang up");
    });
    expect(receipt).toMatchObject({ stage: "indeterminate", errorCode: "T3_NETWORK_ERROR" });
  });

  it("treats a mismatched receipt as indeterminate", async () => {
    const { receipt } = await run(() => json(adopted("someone-else")));
    expect(receipt).toMatchObject({ stage: "indeterminate", errorCode: "T3_INVALID_RESPONSE" });
  });

  it("refuses preflight scope failures as definitive retryable no-effects", async () => {
    const { receipt } = await run(() =>
      json({ protocolVersion: 1, error: { code: "HOST_SESSION_MISMATCH" } }, 409),
    );
    expect(receipt).toMatchObject({
      stage: "failed",
      errorCode: "CONTEXT_CREDENTIAL_UNAVAILABLE",
      retryable: true,
    });
  });

  it("never sends when the credential vanished before execution", async () => {
    const { receipt, seen } = await run(undefined, () => null);
    expect(receipt).toMatchObject({
      stage: "indeterminate",
      errorCode: "CONTEXT_CREDENTIAL_UNAVAILABLE",
      detail: { dispatched: false },
    });
    expect(seen.some((request) => request.method === "POST")).toBe(false);
  });
});

describe("T3 context through the coordinator", () => {
  function setup(context?: Parameters<typeof t3Host>[0]["context"]) {
    const store = SqliteSidebandStore.open(":memory:", { now: () => NOW });
    const host = t3Host({ ...(context === undefined ? {} : { context }) });
    const t3 = makeAdapter(host.fetchMock, () => credential());
    const sideband = new AgentSideband({ store, adapters: [t3] });
    store.registerAgent({ agentId: "reviewer" });
    store.bindAgent({
      bindingId: "binding-1",
      agentId: "reviewer",
      adapter: "t3",
      hostInstanceId: "environment-1",
      externalId: "thread-1",
      state: "idle",
      actorPrincipalId: "operator",
    });
    const message = store.sendMessage({
      idempotencyKey: "m1",
      fromAgentId: "reviewer",
      target: { type: "agent", id: "reviewer" },
      correlationId: "c1",
      body: "Background: the deploy finished.",
      messageClass: "informational",
      provenance: {
        authenticatedPrincipalId: "agent:reviewer",
        source: "http",
        sourceInstanceId: null,
        sourceOperationId: null,
        trust: "untrusted",
      },
    });
    const send = {
      principalId: "operator",
      idempotencyKey: "both-1",
      bindingId: "binding-1",
      messageId: message.messageId,
      mode: "both" as const,
    };
    return { store, sideband, host, send };
  }

  it("checkpoints an adopted context leg before the wake and persists no bearer", async () => {
    const { store, sideband, host, send } = setup();
    const result = await sideband.sendMessageToHost(send);
    expect(result.operation.stage).toBe("accepted");
    const order = host.seen
      .filter((request) => request.method === "POST")
      .map((request) => request.path);
    expect(order).toEqual([CONTEXT_PATH, "/api/orchestration/dispatch"]);
    const contextRow = store.getPreparedRequest(result.operation.operationId, "context");
    expect(contextRow?.receipt).toMatchObject({ stage: "adopted" });
    const persisted = JSON.stringify(
      store.database.prepare("SELECT * FROM operations").all(),
    ).concat(JSON.stringify(contextRow));
    expect(persisted).not.toContain(DELIVERY_TOKEN);
    expect(persisted).not.toContain(ENV_TOKEN);
    store.close();
  });

  it("never wakes after a pending context outcome and replays only the frozen bytes", async () => {
    let posts = 0;
    const { store, sideband, host, send } = setup((body) => {
      posts += 1;
      return posts === 1
        ? json(
            {
              ...adopted(String(body.injectionId)),
              stage: "accepted",
              adoptedAt: null,
              providerEvidence: "none",
            },
            202,
          )
        : json(adopted(String(body.injectionId)));
    });
    const first = await sideband.sendMessageToHost(send);
    expect(first.operation).toMatchObject({
      stage: "indeterminate",
      errorCode: "T3_CONTEXT_PENDING",
    });
    expect(host.seen.some((request) => request.path === "/api/orchestration/dispatch")).toBe(false);

    // Retrying the same send returns the recorded outcome; nothing is re-sent on its own.
    await sideband.sendMessageToHost(send);
    expect(posts).toBe(1);

    const replayed = await sideband.sendMessageToHost({ ...send, replayIndeterminate: true });
    expect(replayed.operation.stage).toBe("accepted");
    const contextPosts = host.seen.filter(
      (request) => request.method === "POST" && request.path === CONTEXT_PATH,
    );
    expect(contextPosts).toHaveLength(2);
    expect(contextPosts[1]!.body).toBe(contextPosts[0]!.body);
    store.close();
  });
});

describe("T3 per-binding context readiness", () => {
  it("separates adapter support from a held credential for exactly this binding", async () => {
    const { fetchMock } = t3Host({ capability: () => json(capability({ context: false })) });
    let held: T3DeliveryCredential | null = null;
    const unsupported = makeAdapter(fetchMock);
    const adapter = makeAdapter(fetchMock, () => held);

    expect((await unsupported.capabilitiesForBinding(binding())).context).toBe(false);
    // Supported adapter-wide, but nothing held for this target yet (e.g. after a restart).
    expect((await adapter.capabilities()).context).toBe(true);
    expect((await adapter.capabilitiesForBinding(binding())).context).toBe(false);

    held = credential();
    expect((await adapter.capabilitiesForBinding(binding())).context).toBe(true);
    // A credential from another generation never counts for this binding.
    expect((await adapter.capabilitiesForBinding(binding({ generation: 2 }))).context).toBe(false);
    held = credential({ expiresAt: "2026-10-08T11:59:59.000Z" });
    expect((await adapter.capabilitiesForBinding(binding())).context).toBe(false);

    // Readiness reporting never calls the host, so a busy session is not consulted here; prepare
    // enforces it later without substituting a wake.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
