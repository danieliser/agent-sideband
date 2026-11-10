/* eslint-disable @typescript-eslint/no-explicit-any -- black-box HTTP/MCP replies are untyped JSON */
/**
 * End-to-end qualification of the composed Agent Sideband daemon: one SQLite database, the real
 * Fastify HTTP listener, the real identity credential path, and the native MCP client/server pair
 * (the MCP server calls the daemon through SidebandHttpClient, the same code the stdio CLI uses).
 *
 * WHAT IS REAL: daemon composition, SQLite migrations, identity/credential resolution, schedule
 * creation/authorization/cancellation, the scheduler loop, message + operation + prepared-request
 * persistence, HTTP routes, MCP tool catalog and transport.
 *
 * WHAT IS SIMULATED: the host. `SimulatedHost` is a spy adapter that implements the HostAdapter
 * prepare/execute transport contract and models a host that deduplicates on a command id. It
 * proves the Sideband -> adapter contract only. It does NOT prove that any real provider (T3,
 * Codex, ...) adopts the command, shows a visible turn, or that the model ever consumes context.
 * Real two-agent provider qualification is a separate pass.
 *
 * The clock is injected, so "30 minutes" means a clock jump, not real wall-clock time.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { createSidebandDaemon, type SidebandDaemon } from "../src/api/daemon.js";
import type {
  HostAdapter,
  HostAdapterCapabilities,
  HostExecuteRequest,
  HostOperationReceipt,
  HostPrepareRequest,
} from "../src/core/host-adapter.js";
import { SidebandHttpClient } from "../src/mcp/http-client.js";
import { buildAgentSidebandMcpServer } from "../src/mcp/server.js";
import { sidebandToolCatalog } from "../src/mcp/tools.js";
import { createOperatorPrincipal } from "../src/security/index.js";

const START = "2026-10-08T12:00:00.000Z";
const START_MS = Date.parse(START);
const OPERATOR_TOKEN = "operator-token-that-is-long-enough-for-the-e2e-daemon";
const HOST = "sim-host";
const HOST_INSTANCE = "sim-host-1";

// --------------------------------------------------------------------------------------------
// Simulated host (transport-contract spy). See the file header for what this does NOT prove.
// --------------------------------------------------------------------------------------------

type ExecuteBehavior = "ok" | "lost-response" | "lost-before-effect" | "retryable-failure";

interface HostEffect {
  readonly commandId: string;
  readonly leg: "wake" | "context";
  readonly threadId: string;
  readonly bindingGeneration: number;
  readonly from: string;
  readonly text: string;
}

class SimulatedHost {
  readonly caps: { -readonly [K in keyof HostAdapterCapabilities]: boolean } = {
    spawn: false,
    bind: false,
    wake: true,
    context: true,
    interrupt: false,
    stop: false,
    adoptionReceipts: false,
  };
  /** When false, prepared requests are declared NOT replay-safe (an unsafe effect). */
  replaySafe = true;
  readonly prepared: HostPrepareRequest[] = [];
  readonly executed: HostExecuteRequest[] = [];
  /** Exact JSON of each execute, in order, for byte-for-byte comparison. */
  readonly executedJson: string[] = [];
  /** Effects the simulated host actually applied, deduplicated by command id. */
  readonly applied = new Map<string, HostEffect>();
  readonly order: string[] = [];
  readonly deduped: string[] = [];
  readonly mismatches: string[] = [];
  script: ExecuteBehavior[] = [];
  readonly adapter: HostAdapter;

  constructor() {
    const unused = async (): Promise<never> => {
      throw new Error("unused");
    };
    this.adapter = {
      name: HOST,
      capabilities: async () => ({ ...this.caps }),
      spawn: unused,
      bind: unused,
      send: unused,
      interrupt: unused,
      stop: unused,
      inspect: unused,
      prepare: async (request) => {
        this.prepared.push(request);
        return {
          protocolVersion: 1,
          leg: request.leg,
          replaySafe: this.replaySafe,
          payload: {
            commandId: `cmd:${request.operationId}:${request.leg}`,
            leg: request.leg,
            threadId: request.binding.externalId,
            bindingId: request.binding.bindingId,
            bindingGeneration: request.binding.generation,
            from: request.fromAgentId,
            text: request.body,
            scheduleContext: request.metadata.scheduleContext ?? null,
          },
        };
      },
      execute: async (request): Promise<HostOperationReceipt> => {
        this.executed.push(request);
        this.executedJson.push(JSON.stringify(request.prepared.payload));
        const payload = request.prepared.payload as unknown as HostEffect & { bindingId: string };
        // Contract invariant: the stored payload must only ever be executed against its own binding.
        if (
          payload.bindingGeneration !== request.binding.generation ||
          payload.bindingId !== request.binding.bindingId ||
          payload.threadId !== request.binding.externalId
        ) {
          this.mismatches.push(payload.commandId);
        }
        const behavior = this.script.shift() ?? "ok";
        if (behavior === "lost-before-effect") throw new Error("connection reset before write");
        if (behavior === "retryable-failure") {
          return {
            stage: "failed",
            receiptId: null,
            errorCode: "HOST_UNAVAILABLE",
            errorMessage: "simulated host down",
            retryable: true,
          };
        }
        if (this.applied.has(payload.commandId)) {
          this.deduped.push(payload.commandId);
        } else {
          this.applied.set(payload.commandId, {
            commandId: payload.commandId,
            leg: payload.leg,
            threadId: payload.threadId,
            bindingGeneration: payload.bindingGeneration,
            from: payload.from,
            text: payload.text,
          });
          this.order.push(`${payload.leg}:${payload.commandId}`);
        }
        if (behavior === "lost-response") throw new Error("connection reset after write");
        return { stage: "accepted", receiptId: `receipt:${payload.commandId}` };
      },
    };
  }

  /** Visible user-message turns the simulated host applied. */
  get turns(): HostEffect[] {
    return [...this.applied.values()].filter((effect) => effect.leg === "wake");
  }

  /** Silent context items the simulated host applied. */
  get contexts(): HostEffect[] {
    return [...this.applied.values()].filter((effect) => effect.leg === "context");
  }
}

// --------------------------------------------------------------------------------------------
// Harness: real daemon + real HTTP + MCP clients
// --------------------------------------------------------------------------------------------

interface Access {
  token: string;
  agentId: string;
  principalId: string;
  hostSessionId: string;
  bindingId: string;
  generation: number;
  expiresAt: string;
  externalId: string;
  hostEpoch: string;
}

interface Reply {
  status: number;
  json: any;
  text: string;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

class Harness {
  readonly directory = mkdtempSync(join(tmpdir(), "sideband-e2e-"));
  readonly database = join(this.directory, "sideband.sqlite");
  readonly clock = { current: new Date(START) };
  readonly host = new SimulatedHost();
  readonly live = new Map<string, Access>();
  readonly mcpHandles: Array<{ client: Client; close(): Promise<void> }> = [];
  daemon!: SidebandDaemon;
  base = "";
  connectorToken = "";
  private readonly autoStart: boolean;
  private keySequence = 0;

  constructor(options: { autoStart?: boolean } = {}) {
    this.autoStart = options.autoStart ?? false;
    harnesses.push(this);
  }

  async boot(): Promise<this> {
    this.daemon = createSidebandDaemon({
      database: this.database,
      operatorToken: OPERATOR_TOKEN,
      now: () => new Date(this.clock.current),
      scheduler: { autoStart: this.autoStart, intervalMs: 15 },
      adapters: [{ name: HOST, create: () => this.host.adapter }],
    });
    this.base = await this.daemon.listen({ host: "127.0.0.1", port: 0 });
    return this;
  }

  /** Real shutdown (loop stopped, listener closed, SQLite closed) then a fresh composition. */
  async restart(): Promise<void> {
    await this.closeMcp();
    await this.daemon.close();
    await this.boot();
  }

  /** Runs `during` while the daemon is fully down (loop stopped, listener and SQLite closed). */
  async closeAndHoldDown(during: () => Promise<void>): Promise<void> {
    await this.closeMcp();
    await this.daemon.close();
    await during();
    await this.boot();
  }

  async dispose(): Promise<void> {
    await this.closeMcp();
    await this.daemon.close();
    rmSync(this.directory, { recursive: true, force: true });
  }

  private async closeMcp(): Promise<void> {
    for (const handle of this.mcpHandles.splice(0)) await handle.close().catch(() => undefined);
  }

  nextKey(prefix: string): string {
    this.keySequence += 1;
    return `${prefix}-${this.keySequence}`;
  }

  advance(seconds: number): void {
    this.clock.current = new Date(this.clock.current.getTime() + seconds * 1000);
  }

  get elapsedSeconds(): number {
    return (this.clock.current.getTime() - START_MS) / 1000;
  }

  async http(
    method: string,
    path: string,
    options: {
      token?: string;
      key?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Reply> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.key === undefined ? {} : { "idempotency-key": options.key }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = text.length === 0 ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  operator = (method: string, path: string, body?: unknown, key?: string) =>
    this.http(method, path, {
      token: OPERATOR_TOKEN,
      ...(body === undefined ? {} : { body }),
      ...(key === undefined ? {} : { key }),
    });

  async enrollConnector(): Promise<void> {
    const reply = await this.operator("POST", "/v1/connectors", {
      adapter: HOST,
      hostInstanceId: HOST_INSTANCE,
    });
    expect(reply.status, reply.text).toBe(201);
    this.connectorToken = reply.json.token;
  }

  connector = (method: string, path: string, body?: unknown, key?: string) =>
    this.http(method, path, {
      token: this.connectorToken,
      ...(body === undefined ? {} : { body }),
      ...(key === undefined ? {} : { key }),
    });

  /** Provision (or rebind, when the provider session or epoch changes) via the connector path. */
  async provision(
    externalId: string,
    options: { providerSessionId?: string; hostEpoch?: string; leaseSeconds?: number } = {},
  ): Promise<Access> {
    const hostEpoch = options.hostEpoch ?? "epoch-1";
    const reply = await this.connector(
      "POST",
      "/v1/host-sessions",
      {
        externalId,
        providerSessionId: options.providerSessionId ?? `${externalId}-provider-1`,
        hostEpoch,
        leaseSeconds: options.leaseSeconds ?? 300,
      },
      this.nextKey(`provision-${externalId}`),
    );
    expect(reply.status, reply.text).toBe(201);
    const access: Access = { ...reply.json, externalId, hostEpoch };
    this.live.set(externalId, access);
    return access;
  }

  async heartbeat(access: Access): Promise<Reply> {
    return this.connector("POST", `/v1/host-sessions/${access.hostSessionId}/heartbeat`, {
      hostEpoch: access.hostEpoch,
      leaseSeconds: 300,
    });
  }

  /** Advances the clock while the host keeps every live session's lease fresh (not the token). */
  async advanceAlive(seconds: number, step = 240): Promise<void> {
    let remaining = seconds;
    while (remaining > 0) {
      const slice = Math.min(step, remaining);
      this.advance(slice);
      remaining -= slice;
      for (const access of this.live.values()) {
        const beat = await this.heartbeat(access);
        expect(beat.status, beat.text).toBe(200);
      }
    }
  }

  async tick(): Promise<void> {
    await this.daemon.loop.runOnce();
  }

  async twoAgents(): Promise<{ a: Access; b: Access }> {
    await this.enrollConnector();
    const a = await this.provision("thread-a");
    const b = await this.provision("thread-b");
    expect(a.agentId).not.toBe(b.agentId);
    return { a, b };
  }

  async createSchedule(
    access: { token: string },
    body: Record<string, unknown>,
    key = this.nextKey("schedule"),
  ): Promise<Reply> {
    return this.http("POST", "/v1/schedules", { token: access.token, key, body });
  }

  async occurrences(scheduleId: string): Promise<any[]> {
    const reply = await this.operator("GET", `/v1/schedules/${scheduleId}/occurrences`);
    expect(reply.status, reply.text).toBe(200);
    return reply.json.items;
  }

  async scheduleStatus(scheduleId: string): Promise<string> {
    const reply = await this.operator("GET", `/v1/schedules/${scheduleId}`);
    expect(reply.status, reply.text).toBe(200);
    return reply.json.status;
  }

  /** A native MCP client wired to the daemon over real HTTP with this credential. */
  async mcp(token: string, audiences: Array<"agent" | "operator"> = ["agent"]) {
    const api = new SidebandHttpClient({ baseUrl: this.base, token });
    const server = buildAgentSidebandMcpServer({ api, audiences });
    const client = new Client({ name: "sideband-e2e", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    this.mcpHandles.push({
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    });
    return {
      client,
      call: async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        return {
          isError: result.isError === true,
          data: (result.structuredContent ?? {}) as any,
        };
      },
    };
  }

  /** Wire-level view of the single prepared request for a dispatched occurrence. */
  preparedFor(occurrence: { operationId: string | null }, leg: "wake" | "context" = "wake") {
    expect(occurrence.operationId).not.toBeNull();
    return this.daemon.store.getPreparedRequest(occurrence.operationId as string, leg);
  }
}

async function boot(options: { autoStart?: boolean } = {}): Promise<Harness> {
  return new Harness(options).boot();
}

const afterSeconds = (delaySeconds: number) => ({ type: "after", delaySeconds });

// --------------------------------------------------------------------------------------------

describe("composed daemon: discovery, shared catalog, credential path", () => {
  it("serves the same schedule catalog over MCP and HTTP and binds MCP to the caller's credential", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);
    const mcpB = await h.mcp(b.token);

    const tools = (await mcpA.client.listTools()).tools.map((tool) => tool.name).sort();
    const catalog = sidebandToolCatalog({ audiences: ["agent"] })
      .map((tool) => tool.name)
      .sort();
    expect(tools).toEqual(catalog);
    expect(tools).toEqual(
      expect.arrayContaining([
        "sideband_schedule_create",
        "sideband_schedule_cancel",
        "sideband_schedules_list",
        "sideband_schedule_get",
        "sideband_schedule_occurrences_list",
        "sideband_capabilities_get",
        "sideband_identity_get",
      ]),
    );
    // Agent MCP never exposes operator tools or a way to supply identity.
    expect(tools).not.toContain("sideband_schedule_event_emit");

    const whoA = await mcpA.call("sideband_identity_get");
    const whoB = await mcpB.call("sideband_identity_get");
    expect(whoA.data).toMatchObject({
      kind: "agent",
      agentId: a.agentId,
      principalId: a.principalId,
    });
    expect(whoB.data).toMatchObject({ kind: "agent", agentId: b.agentId });
    expect(whoA.data.session).toMatchObject({ generation: 1, adapter: HOST });
    expect(JSON.stringify(whoA.data)).not.toContain(a.token);

    // Created through MCP, visible through HTTP with the same credential, invisible to B.
    const created = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "shared-1",
      body: "shared catalog check",
      trigger: { type: "after", delay: { value: 5, unit: "minutes" } },
    });
    expect(created.isError, JSON.stringify(created.data)).toBe(false);
    const scheduleId = created.data.schedule.scheduleId as string;
    const viaHttp = await h.http("GET", `/v1/schedules/${scheduleId}`, { token: a.token });
    expect(viaHttp.status).toBe(200);
    expect(viaHttp.json.body).toBe("shared catalog check");
    const asB = await h.http("GET", `/v1/schedules/${scheduleId}`, { token: b.token });
    expect(asB.status).toBe(404);
    const listB = await mcpB.call("sideband_schedules_list");
    expect(listB.data.items).toEqual([]);
    const listA = await mcpA.call("sideband_schedules_list");
    expect(listA.data.items.map((item: any) => item.scheduleId)).toEqual([scheduleId]);
  });

  it("states capabilities honestly: wake default, context per host, named events and file/process unavailable", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);
    const caps = (await mcpA.call("sideband_capabilities_get")).data;
    expect(caps.scheduling.defaultDeliveryMode).toBe("wake");
    expect(caps.scheduling.allowedTargets).toBe("self-or-explicit-grant");
    expect(caps.scheduling.triggers).toEqual({
      after: true,
      at: true,
      interval: true,
      cron: true,
      // Named events: agents cannot subscribe (core matches only same-principal schedules).
      event: false,
    });
    // File/process triggers are future-only: not advertised, not accepted.
    expect(Object.keys(caps.scheduling.triggers)).not.toEqual(
      expect.arrayContaining(["file", "process"]),
    );
    expect(caps.delivery).toMatchObject({ adapter: HOST, wake: true, context: true, both: true });
    // The simulated host does not claim provider adoption; the receipt level must say so.
    expect(caps.delivery.receiptLevel).toBe("host-accepted");

    h.host.caps.context = false;
    const downgraded = (await mcpA.call("sideband_capabilities_get")).data;
    expect(downgraded.delivery).toMatchObject({ wake: true, context: false, both: false });

    for (const type of ["file", "process", "webhook"]) {
      const reply = await h.createSchedule(a, { body: "x", trigger: { type, path: "/tmp/x" } });
      expect(reply.status, `${type}: ${reply.text}`).toBeGreaterThanOrEqual(400);
      expect(reply.status).toBeLessThan(500);
    }
  });
});

describe("timers and the default user-message mode", () => {
  it("fires a relative 30 minute reminder exactly once as a visible wake turn (default mode)", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);

    const created = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "thirty-min",
      body: "Check the build.",
      trigger: { type: "after", delay: { value: 30, unit: "minutes" } },
    });
    expect(created.isError, JSON.stringify(created.data)).toBe(false);
    // 30-minute duration normalization: the wire request is exactly 1800 seconds.
    expect(created.data.requestedTrigger).toEqual({ type: "after", delaySeconds: 1800 });
    expect(created.data.schedule.deliveryMode).toBe("wake");
    expect(created.data.receiptLevel).toBe("scheduled");
    expect(Date.parse(created.data.schedule.nextDueAt) - START_MS).toBe(1_800_000);
    const scheduleId = created.data.schedule.scheduleId as string;

    // Same duration expressed as raw seconds and as 30 minutes normalize identically.
    const raw = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "thirty-min-raw",
      body: "raw seconds",
      trigger: { type: "after", delaySeconds: 1800 },
    });
    expect(Date.parse(raw.data.schedule.nextDueAt)).toBe(
      Date.parse(created.data.schedule.nextDueAt),
    );

    await h.advanceAlive(1799);
    await h.tick();
    expect(h.host.turns).toHaveLength(0);
    await h.advanceAlive(1);
    await h.tick();
    await h.tick();
    // Two schedules (distinct keys) -> two turns; each exactly once.
    expect(h.host.turns).toHaveLength(2);
    const turn = h.host.turns.find((effect) => effect.text === "Check the build.")!;
    expect(turn).toMatchObject({ threadId: "thread-a", from: a.agentId, bindingGeneration: 1 });
    expect(h.host.contexts).toHaveLength(0);
    expect(h.host.order.filter((entry) => entry.startsWith("wake:"))).toHaveLength(2);

    const [occurrence] = await h.occurrences(scheduleId);
    expect(occurrence).toMatchObject({ state: "host_accepted", attempts: 1 });
    // The first-class receipt is "accepted by the simulated host", not provider adoption.
    expect(h.preparedFor(occurrence)?.receipt?.stage).toBe("accepted");
    expect(h.host.mismatches).toEqual([]);
    expect(await h.scheduleStatus(scheduleId)).toBe("completed");
  });

  it("rejects ambiguous or malformed durations instead of guessing", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);
    const bad: Array<Record<string, unknown>> = [
      { type: "after" },
      { type: "after", delaySeconds: 60, delay: { value: 1, unit: "minutes" } },
      { type: "after", delay: { value: 0, unit: "minutes" } },
      { type: "after", delay: { value: 1.5, unit: "minutes" } },
      { type: "after", delay: { value: 30, unit: "fortnights" } },
      { type: "after", delaySeconds: -5 },
    ];
    for (const trigger of bad) {
      const result = await mcpA.call("sideband_schedule_create", {
        idempotencyKey: h.nextKey("bad"),
        body: "x",
        trigger,
      });
      expect(result.isError, JSON.stringify(trigger)).toBe(true);
    }
    expect(h.daemon.store.database.prepare("SELECT COUNT(*) AS n FROM schedules").get()).toEqual({
      n: 0,
    });
    // And over raw HTTP the string form "30 minutes" is not a duration.
    const reply = await h.createSchedule(a, {
      body: "x",
      trigger: { type: "after", delaySeconds: "30 minutes" },
    });
    expect(reply.status).toBe(422);
  });

  it("normalizes an absolute RFC 3339 offset to the same instant and refuses naive times", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);
    // 08:30 -04:00 == 12:30Z, i.e. START + 30 minutes.
    const created = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "abs-offset",
      body: "absolute",
      trigger: { type: "at", at: "2026-10-08T08:30:00-04:00" },
    });
    expect(created.isError, JSON.stringify(created.data)).toBe(false);
    expect(Date.parse(created.data.schedule.nextDueAt)).toBe(START_MS + 1_800_000);
    const naive = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "abs-naive",
      body: "naive",
      trigger: { type: "at", at: "2026-10-08T12:30:00" },
    });
    expect(naive.isError).toBe(true);
    const past = await h.createSchedule(a, {
      body: "past",
      trigger: { type: "at", at: "2026-10-08T11:00:00Z" },
    });
    // A past instant is either refused or immediately due, never silently dropped.
    if (past.status < 300) {
      await h.tick();
      expect(h.host.turns.map((turn) => turn.text)).toContain("past");
    } else {
      expect(past.status).toBeLessThan(500);
    }
    await h.advanceAlive(1800);
    await h.tick();
    expect(h.host.turns.map((turn) => turn.text)).toContain("absolute");
  });

  it("drives due work from the daemon's own timer loop without manual ticks", async () => {
    const h = await boot({ autoStart: true });
    const { a } = await h.twoAgents();
    expect(h.daemon.loop.status().state).toBe("running");
    const reply = await h.createSchedule(a, { body: "auto-loop", trigger: afterSeconds(120) });
    expect(reply.status).toBe(201);
    await h.advanceAlive(120);
    const deadline = Date.now() + 5000;
    while (h.host.turns.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(h.host.turns.map((turn) => turn.text)).toEqual(["auto-loop"]);
    expect(h.daemon.loop.status()).toMatchObject({ lastErrorCode: null, consecutiveFailures: 0 });
    // Give the loop several more passes; the turn count must not grow.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.host.turns).toHaveLength(1);
  });

  it("coalesces missed interval slots instead of replaying a backlog", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const reply = await h.createSchedule(a, {
      body: "heartbeat",
      trigger: { type: "interval", everySeconds: 600 },
    });
    expect(reply.status, reply.text).toBe(201);
    await h.advanceAlive(3500);
    await h.tick();
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    const [occurrence] = await h.occurrences(reply.json.schedule.scheduleId);
    expect(occurrence.skippedSlots).toBeGreaterThanOrEqual(1);
    expect(await h.scheduleStatus(reply.json.schedule.scheduleId)).toBe("active");
  });
});

describe("delivery modes: wake, context-only, both", () => {
  it("context-only injects silent context and creates no visible turn", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);
    const created = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "ctx-only",
      body: "remember the migration plan",
      deliveryMode: "context",
      trigger: { type: "after", delaySeconds: 60 },
    });
    expect(created.isError, JSON.stringify(created.data)).toBe(false);
    await h.advanceAlive(60);
    await h.tick();
    await h.tick();
    expect(h.host.turns).toHaveLength(0);
    expect(h.host.contexts).toHaveLength(1);
    expect(h.host.contexts[0]).toMatchObject({
      text: "remember the migration plan",
      threadId: "thread-a",
    });
  });

  it("both injects context first, then exactly one wake", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.createSchedule(a, {
      body: "context then wake",
      deliveryMode: "both",
      context: { ticket: "SB-1" },
      trigger: afterSeconds(60),
    });
    expect(created.status, created.text).toBe(201);
    await h.advanceAlive(60);
    await h.tick();
    await h.tick();
    expect(h.host.order.map((entry) => entry.split(":")[0])).toEqual(["context", "wake"]);
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.contexts).toHaveLength(1);
    // Untrusted structured context is carried only as data in the context request.
    expect(h.host.prepared.find((p) => p.leg === "context")?.metadata.scheduleContext).toEqual({
      ticket: "SB-1",
    });
  });

  it("refuses context delivery to a host without context, at create time and at dispatch time, never falling back to wake", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    h.host.caps.context = false;
    for (const deliveryMode of ["context", "both"]) {
      const refused = await h.createSchedule(a, {
        body: "needs context",
        deliveryMode,
        trigger: afterSeconds(60),
      });
      expect(refused.status, `${deliveryMode}: ${refused.text}`).toBeGreaterThanOrEqual(400);
      expect(refused.json.error.code).toBe("CONTEXT_INJECTION_UNSUPPORTED");
    }
    // Accepted while supported, then the host loses the capability before the timer fires.
    h.host.caps.context = true;
    const ok = await h.createSchedule(a, {
      body: "context later",
      deliveryMode: "both",
      trigger: afterSeconds(60),
    });
    expect(ok.status).toBe(201);
    h.host.caps.context = false;
    await h.advanceAlive(60);
    await h.tick();
    expect(h.host.turns).toHaveLength(0);
    expect(h.host.contexts).toHaveLength(0);
    const [occurrence] = await h.occurrences(ok.json.schedule.scheduleId);
    expect(occurrence).toMatchObject({
      state: "blocked",
      error: { code: "CONTEXT_INJECTION_UNSUPPORTED" },
    });
  });
});

describe("cancellation and idempotency", () => {
  it("cancels before due, replays the cancel, and never wakes", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);
    const created = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "to-cancel",
      body: "never delivered",
      trigger: { type: "after", delaySeconds: 600 },
    });
    const scheduleId = created.data.schedule.scheduleId as string;

    // B cannot even see A's schedule, let alone cancel it.
    const foreign = await h.http("POST", `/v1/schedules/${scheduleId}/cancel`, {
      token: b.token,
      key: "foreign-cancel",
    });
    expect(foreign.status).toBe(404);
    expect(await h.scheduleStatus(scheduleId)).toBe("active");

    const first = await mcpA.call("sideband_schedule_cancel", {
      scheduleId,
      idempotencyKey: "cancel-1",
    });
    expect(first.isError, JSON.stringify(first.data)).toBe(false);
    expect(first.data).toMatchObject({ replayed: false, schedule: { status: "cancelled" } });
    const replay = await mcpA.call("sideband_schedule_cancel", {
      scheduleId,
      idempotencyKey: "cancel-1",
    });
    expect(replay.data).toMatchObject({ replayed: true, schedule: { status: "cancelled" } });

    await h.advanceAlive(600);
    await h.tick();
    expect(h.host.turns).toHaveLength(0);
    expect(h.host.executed).toHaveLength(0);
    expect((await h.occurrences(scheduleId)).filter((o) => o.state === "host_accepted")).toEqual(
      [],
    );
  });

  it("reports an already-accepted occurrence when cancelling after it fired", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.createSchedule(a, {
      body: "recurring",
      trigger: { type: "interval", everySeconds: 300 },
    });
    const scheduleId = created.json.schedule.scheduleId as string;
    await h.advanceAlive(300);
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    const cancel = await h.http("POST", `/v1/schedules/${scheduleId}/cancel`, {
      token: a.token,
      key: "cancel-recurring",
    });
    expect(cancel.status, cancel.text).toBe(200);
    expect(cancel.json.alreadyAcceptedOccurrenceIds).toHaveLength(1);
    await h.advanceAlive(900);
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
  });

  it("makes repeated creation idempotent per key across HTTP and MCP, and conflicts on a changed request", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);
    const request = { body: "once", trigger: afterSeconds(120) };

    const first = await h.createSchedule(a, request, "same-key");
    const second = await h.createSchedule(a, request, "same-key");
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.json.replayed).toBe(true);
    expect(second.json.schedule.scheduleId).toBe(first.json.schedule.scheduleId);

    const conflict = await h.createSchedule(a, { ...request, body: "changed" }, "same-key");
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // The same logical request via MCP with the same key resolves to the same schedule.
    const viaMcp = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "same-key",
      body: "once",
      trigger: { type: "after", delay: { value: 2, unit: "minutes" } },
    });
    expect(viaMcp.isError, JSON.stringify(viaMcp.data)).toBe(false);
    expect(viaMcp.data.schedule.scheduleId).toBe(first.json.schedule.scheduleId);
    expect(viaMcp.data.replayed).toBe(true);

    // A different key is a different schedule by design.
    const other = await h.createSchedule(a, request, "other-key");
    expect(other.json.schedule.scheduleId).not.toBe(first.json.schedule.scheduleId);

    await h.advanceAlive(120);
    await h.tick();
    await h.tick();
    expect(h.host.turns).toHaveLength(2);
    const listed = await mcpA.call("sideband_schedules_list");
    expect(listed.data.items).toHaveLength(2);
  });
});

describe("daemon close and reopen", () => {
  it("keeps a pending timer, the identity credential, and fires once after a real restart", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.createSchedule(a, {
      body: "survives restart",
      trigger: afterSeconds(600),
    });
    const scheduleId = created.json.schedule.scheduleId as string;

    await h.restart();
    expect(h.daemon.store.appliedMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4]);
    // The agent's token still authenticates against the reopened database.
    const me = await h.http("GET", "/v1/me", { token: a.token });
    expect(me.status).toBe(200);
    expect(me.json.agentId).toBe(a.agentId);
    expect(await h.scheduleStatus(scheduleId)).toBe("active");

    await h.advanceAlive(599);
    await h.tick();
    expect(h.host.turns).toHaveLength(0);
    await h.advanceAlive(1);
    await h.tick();
    await h.tick();
    expect(h.host.turns).toHaveLength(1);

    await h.restart();
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.executed).toHaveLength(1);
  });

  it("delivers a timer that came due while the daemon was down, once, after reopen", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    await h.createSchedule(a, { body: "late but once", trigger: afterSeconds(120) });
    await h.closeAndHoldDown(async () => {
      h.advance(3600);
    });
    // The host reconnects after the outage (heartbeat), then the loop runs.
    await h.heartbeat(a);
    await h.tick();
    await h.tick();
    expect(h.host.turns.map((turn) => turn.text)).toEqual(["late but once"]);
  });
});

describe("offline, rebind and generation handling", () => {
  it("routes a pending reminder to the new generation after a rebind and kills the old token", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.createSchedule(a, { body: "follow me", trigger: afterSeconds(600) });
    const scheduleId = created.json.schedule.scheduleId as string;

    const rebound = await h.provision("thread-a", {
      providerSessionId: "thread-a-provider-2",
      hostEpoch: "epoch-2",
    });
    expect(rebound.agentId).toBe(a.agentId);
    expect(rebound.generation).toBe(2);
    expect(rebound.token).not.toBe(a.token);
    expect((await h.http("GET", "/v1/me", { token: a.token })).status).toBe(401);
    expect((await h.http("GET", "/v1/me", { token: rebound.token })).status).toBe(200);
    // The old epoch can no longer heartbeat for the superseded session.
    const stale = await h.heartbeat(a);
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(stale.status).toBeLessThan(500);
    // The pending schedule is still visible to the rebound identity.
    expect(
      (await h.http("GET", `/v1/schedules/${scheduleId}`, { token: rebound.token })).status,
    ).toBe(200);

    await h.advanceAlive(600);
    await h.tick();
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.turns[0]).toMatchObject({ bindingGeneration: 2, threadId: "thread-a" });
    expect(h.host.mismatches).toEqual([]);
  });

  it("blocks retryably while the target is offline and delivers exactly once after it returns", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    const created = await h.createSchedule(b, { body: "wait for me", trigger: afterSeconds(300) });
    const scheduleId = created.json.schedule.scheduleId as string;

    const offline = await h.connector(
      "POST",
      `/v1/host-sessions/${b.hostSessionId}/offline`,
      { reason: "host restart" },
      "offline-b",
    );
    expect(offline.status, offline.text).toBe(200);
    h.live.delete("thread-b");
    expect((await h.http("GET", "/v1/me", { token: b.token })).status).toBe(401);

    await h.advanceAlive(300);
    await h.tick();
    expect(h.host.executed).toHaveLength(0);
    const [blocked] = await h.occurrences(scheduleId);
    expect(blocked.state).toBe("blocked");
    expect(await h.scheduleStatus(scheduleId)).not.toBe("suspended");

    // B returns as a new generation; the retry window elapses; one delivery.
    const back = await h.provision("thread-b", {
      providerSessionId: "thread-b-provider-2",
      hostEpoch: "epoch-2",
    });
    expect(back.generation).toBeGreaterThan(b.generation);
    expect(back.agentId).toBe(b.agentId);
    for (let i = 0; i < 6 && h.host.turns.length === 0; i += 1) {
      await h.advanceAlive(300);
      await h.tick();
    }
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.turns[0]).toMatchObject({
      threadId: "thread-b",
      bindingGeneration: back.generation,
    });
    expect(a.agentId).not.toBe(h.host.turns[0]?.from);
    expect(h.host.mismatches).toEqual([]);
  });

  it("holds a due reminder while the host lease has lapsed, then delivers once when the same epoch heartbeats back", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.createSchedule(a, { body: "lease lapse", trigger: afterSeconds(600) });
    const scheduleId = created.json.schedule.scheduleId as string;
    // The host goes silent (no heartbeats) well past the 300s lease and past the due time.
    h.live.clear();
    h.advance(1200);
    await h.tick();
    expect(h.host.executed).toHaveLength(0);
    expect((await h.occurrences(scheduleId))[0]).toMatchObject({ state: "blocked" });
    expect(await h.scheduleStatus(scheduleId)).not.toBe("suspended");

    const beat = await h.heartbeat(a);
    expect(beat.status, beat.text).toBe(200);
    h.live.set("thread-a", a);
    for (let i = 0; i < 6 && h.host.turns.length === 0; i += 1) {
      await h.advanceAlive(120);
      await h.tick();
    }
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.turns[0]).toMatchObject({ threadId: "thread-a", bindingGeneration: 1 });
    expect(h.host.mismatches).toEqual([]);
  });

  it("never replays a stored request onto a different binding generation", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.createSchedule(a, { body: "gen1 only", trigger: afterSeconds(60) });
    const scheduleId = created.json.schedule.scheduleId as string;
    h.host.script = ["lost-response"];
    await h.advanceAlive(60);
    await h.tick();
    const [occurrence] = await h.occurrences(scheduleId);
    expect(occurrence.state).toBe("indeterminate");

    await h.provision("thread-a", {
      providerSessionId: "thread-a-provider-2",
      hostEpoch: "epoch-2",
    });
    const before = h.host.executed.length;
    let outcome: unknown = "no-throw";
    try {
      outcome = await h.daemon.scheduler.replayIndeterminate({
        occurrenceId: occurrence.occurrenceId,
      });
    } catch (error) {
      outcome = (error as { code?: string }).code;
    }
    // Whatever the policy, the gen-1 payload must not be executed against the gen-2 binding,
    // and the visible turn count must stay at the single effect that already happened.
    expect(h.host.mismatches).toEqual([]);
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.turns[0]?.bindingGeneration).toBe(1);
    expect(h.host.executed.length - before).toBeLessThanOrEqual(1);
    // Observed policy: a superseded binding's stored request is refused, not re-targeted.
    expect(outcome).toBe("UNAUTHORIZED");
    expect(h.host.executed.length - before).toBe(0);
  });
});

describe("credential lifetime vs explicit access control", () => {
  it("fires a self reminder after the tool token expired, and the expired token is dead", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.createSchedule(a, {
      body: "after the token died",
      trigger: afterSeconds(9 * 3600),
    });
    const scheduleId = created.json.schedule.scheduleId as string;
    await h.advanceAlive(9 * 3600);
    expect((await h.http("GET", "/v1/me", { token: a.token })).status).toBe(401);
    // Token expiry is not revocation: the owner can mint a fresh credential, and the timer fires.
    await h.tick();
    await h.tick();
    expect(h.host.turns.map((turn) => turn.text)).toEqual(["after the token died"]);
    expect(await h.scheduleStatus(scheduleId)).toBe("completed");
    expect(a.expiresAt).toBeDefined();
  });

  it("stops a pending reminder after explicit access revoke and keeps it stopped after restore", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    const keep = await h.createSchedule(a, { body: "keeper", trigger: afterSeconds(900) });
    const doomed = await h.createSchedule(b, { body: "doomed", trigger: afterSeconds(900) });

    const revoke = await h.connector(
      "POST",
      `/v1/host-sessions/${b.hostSessionId}/revoke`,
      { reason: "operator request" },
      "revoke-b",
    );
    expect(revoke.status, revoke.text).toBe(200);
    h.live.delete("thread-b");
    expect((await h.http("GET", "/v1/me", { token: b.token })).status).toBe(401);
    // A revoked identity cannot read back or create schedules even if it kept the token string.
    expect((await h.createSchedule(b, { body: "x", trigger: afterSeconds(60) })).status).toBe(401);

    await h.advanceAlive(900);
    await h.tick();
    await h.tick();
    expect(h.host.turns.map((turn) => turn.text)).toEqual(["keeper"]);
    expect(await h.scheduleStatus(keep.json.schedule.scheduleId)).toBe("completed");
    expect(await h.scheduleStatus(doomed.json.schedule.scheduleId)).toBe("suspended");
    expect((await h.occurrences(doomed.json.schedule.scheduleId))[0]).toMatchObject({
      state: "blocked",
    });

    // Restoring access does not resurrect the suspended schedule (no silent late delivery).
    const restore = await h.operator("POST", `/v1/agents/${b.agentId}/access/restore`);
    expect(restore.status, restore.text).toBe(200);
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
  });

  it("honors the operator's explicit access revoke over HTTP and refuses a later token or re-provision", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    const doomed = await h.createSchedule(b, { body: "doomed", trigger: afterSeconds(300) });
    const asAgent = await h.http("POST", `/v1/agents/${b.agentId}/access/revoke`, {
      token: a.token,
    });
    expect(asAgent.status).toBe(403);
    const revoked = await h.operator("POST", `/v1/agents/${b.agentId}/access/revoke`, {
      reason: "e2e revoke",
    });
    expect(revoked.status, revoked.text).toBe(200);
    h.live.delete("thread-b");
    expect((await h.http("GET", "/v1/me", { token: b.token })).status).toBe(401);
    // The connector cannot quietly re-provision an explicitly revoked identity.
    const reprovision = await h.connector(
      "POST",
      "/v1/host-sessions",
      { externalId: "thread-b", providerSessionId: "thread-b-provider-2", hostEpoch: "epoch-2" },
      "reprovision-b",
    );
    expect(reprovision.status).toBe(403);
    await h.advanceAlive(300);
    await h.tick();
    expect(h.host.executed).toHaveLength(0);
    expect(await h.scheduleStatus(doomed.json.schedule.scheduleId)).toBe("suspended");
  });
});

describe("cross-agent grants", () => {
  it("refuses a foreign target without a grant, delivers with one, and stops when it is revoked", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    const grant = { ownerAgentId: a.agentId, targetAgentId: b.agentId };
    const body = { body: "ping B", targetAgentId: b.agentId, trigger: afterSeconds(300) };

    const denied = await h.createSchedule(a, body);
    expect(denied.status).toBe(403);
    // Agents cannot grant themselves authority; only the operator credential can.
    expect(
      (await h.http("POST", "/v1/schedule-grants", { token: a.token, body: grant })).status,
    ).toBe(403);
    expect((await h.operator("POST", "/v1/schedule-grants", grant)).status).toBe(200);
    const granted = await h.createSchedule(a, body);
    expect(granted.status, granted.text).toBe(201);
    expect(granted.json.schedule).toMatchObject({
      ownerAgentId: a.agentId,
      targetAgentId: b.agentId,
    });
    // Visible to the target, who may read but not cancel on the owner's behalf.
    expect(
      (await h.http("GET", `/v1/schedules/${granted.json.schedule.scheduleId}`, { token: b.token }))
        .status,
    ).toBe(200);

    const second = await h.createSchedule(a, { ...body, body: "ping B again" });
    expect(second.status).toBe(201);
    expect(
      (await h.operator("POST", "/v1/schedule-grants/revoke", { ...grant, reason: "e2e revoke" }))
        .status,
    ).toBe(200);

    await h.advanceAlive(300);
    await h.tick();
    await h.tick();
    expect(h.host.executed).toHaveLength(0);
    expect(await h.scheduleStatus(granted.json.schedule.scheduleId)).toBe("suspended");
    expect((await h.createSchedule(a, body)).status).toBe(403);
  });

  it("delivers a granted cross-agent reminder with the owner as sender, never the target", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    const grantReply = await h.operator("POST", "/v1/schedule-grants", {
      ownerAgentId: a.agentId,
      targetAgentId: b.agentId,
    });
    expect(grantReply.status, grantReply.text).toBe(200);
    const reply = await h.createSchedule(a, {
      body: "from A to B",
      targetAgentId: b.agentId,
      trigger: afterSeconds(60),
    });
    expect(reply.status, reply.text).toBe(201);
    await h.advanceAlive(60);
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.turns[0]).toMatchObject({ threadId: "thread-b", from: a.agentId });
  });
});

describe("forged identity rejection", () => {
  it("never honors caller-supplied principal, owner, sender or target identity fields (HTTP and MCP)", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    const mcpA = await h.mcp(a.token);
    // Fields the surface documents as rejected outright (422 IDENTITY_FIELD_REJECTED).
    const rejected = [
      "principalId",
      "ownerAgentId",
      "fromAgentId",
      "ownerPrincipalId",
      "provenance",
    ];
    // Identity-shaped fields that are not on the reject list. They must at minimum be ignored:
    // owner and target stay the authenticated caller and B never receives anything.
    const ignoredOrRejected = ["agentId", "senderId", "actor"];
    for (const field of [...rejected, ...ignoredOrRejected]) {
      const reply = await h.createSchedule(a, {
        body: `forged ${field}`,
        trigger: afterSeconds(60),
        [field]: field === "provenance" ? { authenticatedPrincipalId: "operator" } : b.agentId,
      });
      if (rejected.includes(field)) {
        expect(reply.status, `${field}: ${reply.text}`).toBe(422);
        expect(reply.json.error.code).toBe("IDENTITY_FIELD_REJECTED");
      } else if (reply.status < 300) {
        expect(reply.json.schedule.ownerAgentId, field).toBe(a.agentId);
        expect(reply.json.schedule.targetAgentId, field).toBe(a.agentId);
      } else {
        expect(reply.status, field).toBeLessThan(500);
      }
      // MCP's strict schema refuses every unknown field before it reaches the daemon.
      const viaMcp = await mcpA.call("sideband_schedule_create", {
        idempotencyKey: h.nextKey("forged"),
        body: "forged",
        trigger: afterSeconds(60),
        [field]: b.agentId,
      });
      expect(viaMcp.isError, field).toBe(true);
    }
    // A forged target without a grant is refused by authorization, not by field filtering.
    const target = await h.createSchedule(a, {
      body: "to B",
      targetAgentId: b.agentId,
      trigger: afterSeconds(60),
    });
    expect(target.status).toBe(403);
    // A forged sender on the message path is refused too.
    const message = await h.http("POST", "/v1/messages", {
      token: a.token,
      key: "forged-message",
      body: {
        target: { type: "agent", id: b.agentId },
        correlationId: "c-1",
        body: "hi",
        messageClass: "request",
        fromAgentId: b.agentId,
      },
    });
    expect(message.status).toBe(422);
    expect(h.daemon.store.listInbox(b.agentId, { limit: 10 })).toHaveLength(0);
    await h.advanceAlive(60);
    await h.tick();
    expect(
      h.host.turns.every((turn) => turn.threadId === "thread-a" && turn.from === a.agentId),
    ).toBe(true);
    expect(h.host.turns.some((turn) => turn.threadId === "thread-b")).toBe(false);
  });

  it("separates credential classes: forged, connector-as-agent, agent-as-connector, agent-as-operator", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const bodyOk = { body: "x", trigger: afterSeconds(60) };

    const forged = `sbat_${"A".repeat(43)}`;
    expect((await h.createSchedule({ token: forged }, bodyOk)).status).toBe(401);
    expect((await h.http("GET", "/v1/me", { token: "sbct_" + "B".repeat(43) })).status).toBe(401);
    expect((await h.http("GET", "/v1/me", { token: "not-a-token" })).status).toBe(401);
    expect((await h.http("GET", "/v1/me")).status).toBe(401);

    // A connector may not own schedules; an agent may not act as a connector or operator.
    expect((await h.createSchedule({ token: h.connectorToken }, bodyOk)).status).toBe(403);
    const asConnector = await h.http("POST", "/v1/host-sessions", {
      token: a.token,
      key: "agent-provision",
      body: { externalId: "thread-x", providerSessionId: "p", hostEpoch: "e" },
    });
    expect(asConnector.status).toBe(403);
    expect(
      (
        await h.http("POST", "/v1/connectors", {
          token: a.token,
          body: { adapter: HOST, hostInstanceId: "x" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await h.http("POST", `/v1/agents/${a.agentId}/access/restore`, { token: a.token })).status,
    ).toBe(403);
    // Lifecycle control and named-event publication are not agent powers.
    expect(
      (
        await h.http("POST", `/v1/bindings/${a.bindingId}/send`, {
          token: a.token,
          key: "agent-send",
          body: { messageId: "m", mode: "wake" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.http("POST", "/v1/schedule-events", {
          token: a.token,
          key: "agent-event",
          body: { eventName: "build-finished", occurredAt: START, payload: {} },
        })
      ).status,
    ).toBe(403);
    expect(h.host.executed).toHaveLength(0);
  });

  it("never persists or echoes raw credentials (database files, events, host payloads, errors)", async () => {
    const h = await boot();
    const { a, b } = await h.twoAgents();
    await h.createSchedule(a, { body: "no secrets here", trigger: afterSeconds(60) });
    await h.advanceAlive(60);
    await h.tick();
    const events = await h.operator("GET", "/v1/events?limit=1000");
    expect(events.status).toBe(200);
    const secrets = [a.token, b.token, h.connectorToken, OPERATOR_TOKEN];
    const surfaces = [
      events.text,
      JSON.stringify(h.host.prepared),
      JSON.stringify(h.host.executedJson),
      (await h.http("GET", "/health")).text,
      (await h.http("GET", "/v1/me", { token: "sbat_" + "Z".repeat(43) })).text,
    ];
    for (const file of [h.database, `${h.database}-wal`]) {
      if (existsSync(file)) surfaces.push(readFileSync(file).toString("latin1"));
    }
    for (const secret of secrets) {
      for (const surface of surfaces) expect(surface).not.toContain(secret);
    }
  });
});

describe("operator provenance", () => {
  it("an operator wake keeps the operator as sender and does not impersonate the target", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const sent = await h.operator(
      "POST",
      "/v1/messages",
      {
        target: { type: "agent", id: a.agentId },
        correlationId: "operator-wake-1",
        body: "Operator says: stand by.",
        messageClass: "request",
      },
      "operator-message-1",
    );
    expect(sent.status, sent.text).toBe(201);
    expect(sent.json.fromAgentId).toBe("operator");
    expect(sent.json.provenance).toMatchObject({
      authenticatedPrincipalId: "operator",
      source: "http",
    });

    const wake = await h.operator(
      "POST",
      `/v1/bindings/${a.bindingId}/send`,
      { messageId: sent.json.messageId, mode: "wake" },
      "operator-wake-op-1",
    );
    expect(wake.status, wake.text).toBe(202);
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.turns[0]).toMatchObject({
      from: "operator",
      threadId: "thread-a",
      text: "Operator says: stand by.",
    });
    expect(h.host.turns[0]?.from).not.toBe(a.agentId);
    const stored = h.daemon.store.getMessage(sent.json.messageId);
    expect(stored.provenance.authenticatedPrincipalId).toBe("operator");
    // Replaying the same operator wake key does not add a second visible turn.
    const again = await h.operator(
      "POST",
      `/v1/bindings/${a.bindingId}/send`,
      { messageId: sent.json.messageId, mode: "wake" },
      "operator-wake-op-1",
    );
    expect(again.status).toBe(202);
    expect(h.host.turns).toHaveLength(1);
  });

  async function expectOperatorReminderIsNotSentAsTarget(
    h: Harness,
    a: Access,
    scheduleId: string,
  ): Promise<void> {
    await h.advanceAlive(60);
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    const turn = h.host.turns[0]!;
    expect(turn.threadId).toBe("thread-a");
    // The recipient must never see its own id as the sender of an operator-owned reminder.
    expect(turn.from).not.toBe(a.agentId);
    expect(turn.from === "operator" || turn.from.startsWith("system")).toBe(true);
    const [occurrence] = await h.occurrences(scheduleId);
    const message = h.daemon.store.getMessage(occurrence.messageId);
    expect(message.fromAgentId).not.toBe(a.agentId);
    expect(message.provenance.authenticatedPrincipalId).toBe("operator");
    expect(message.metadata).toMatchObject({
      schedule: { ownerPrincipalId: "operator", ownerAgentId: null },
    });
  }

  it("[REGRESSION core store fromAgentId fallback] an operator-owned reminder created in-process is not sent as the target", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.daemon.scheduler.createSchedule({
      caller: {
        kind: "operator",
        principalId: "operator",
        agentId: "operator",
        source: "http",
        sourceInstanceId: "e2e",
        grants: new Set(["admin"]) as never,
        handle: createOperatorPrincipal("operator"),
      },
      principalId: "operator",
      idempotencyKey: "operator-in-process-1",
      targetAgentId: a.agentId,
      name: "Operator reminder",
      body: "Operator reminder for A",
      trigger: { type: "after", delaySeconds: 60 },
      deliveryMode: "wake",
    });
    expect(created.schedule.ownerAgentId).toBeNull();
    await expectOperatorReminderIsNotSentAsTarget(h, a, created.schedule.scheduleId);
  });

  it("[REGRESSION HTTP surface] an operator can create a reminder for an agent over HTTP", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const created = await h.operator(
      "POST",
      "/v1/schedules",
      { body: "Operator reminder for A", targetAgentId: a.agentId, trigger: afterSeconds(60) },
      "operator-schedule-1",
    );
    // The operator principal owns the schedule; the surface passes no declared owner agent.
    expect(created.status, created.text).toBe(201);
    expect(created.json.schedule.ownerAgentId).toBeNull();
    await expectOperatorReminderIsNotSentAsTarget(h, a, created.json.schedule.scheduleId);
  });
});

describe("named events (explicit stance) and future triggers", () => {
  it("lets only a trusted host or operator publish events; agents can neither subscribe nor publish", async () => {
    const h = await boot();
    const { a } = await h.twoAgents();
    const subscribe = await h.createSchedule(a, {
      body: "on build",
      trigger: { type: "event", eventName: "build-finished" },
    });
    expect(subscribe.status).toBe(422);
    expect(subscribe.json.error.details.reason).toBe("EVENT_SUBSCRIPTIONS_UNAVAILABLE");
    const mcpA = await h.mcp(a.token);
    const viaMcp = await mcpA.call("sideband_schedule_create", {
      idempotencyKey: "event-sub",
      body: "on build",
      trigger: { type: "event", eventName: "build-finished" },
    });
    expect(viaMcp.isError).toBe(true);

    const agentPublish = await h.http("POST", "/v1/schedule-events", {
      token: a.token,
      key: "agent-evt",
      body: { eventName: "build-finished", occurredAt: START, payload: {} },
    });
    expect(agentPublish.status).toBe(403);

    // The trusted host connector may publish; no agent schedule can match it today.
    const published = await h.connector(
      "POST",
      "/v1/schedule-events",
      { eventName: "build-finished", occurredAt: START, payload: { ok: true } },
      "build-42",
    );
    expect(published.status, published.text).toBe(202);
    await h.tick();
    expect(h.host.executed).toHaveLength(0);
  });
});

describe("unknown host outcome: stored request, replay safety, no duplicate turns", () => {
  async function lostResponseSetup(options: { replaySafe: boolean; mode?: "wake" | "both" }) {
    const h = await boot();
    const { a } = await h.twoAgents();
    h.host.replaySafe = options.replaySafe;
    const created = await h.createSchedule(a, {
      body: "exactly one visible turn",
      deliveryMode: options.mode ?? "wake",
      trigger: afterSeconds(120),
    });
    const scheduleId = created.json.schedule.scheduleId as string;
    return { h, a, scheduleId };
  }

  it("never auto-replays an unknown outcome, across ticks, hours and a daemon restart", async () => {
    const { h, scheduleId } = await lostResponseSetup({ replaySafe: true });
    h.host.script = ["lost-response"];
    await h.advanceAlive(120);
    await h.tick();
    const [occurrence] = await h.occurrences(scheduleId);
    expect(occurrence.state).toBe("indeterminate");
    expect(["HOST_ADAPTER_ERROR", "HOST_OUTCOME_INDETERMINATE"]).toContain(occurrence.error.code);
    expect(h.host.executed).toHaveLength(1);
    expect(h.host.turns).toHaveLength(1);
    const storedBefore = JSON.stringify(h.preparedFor(occurrence));

    await h.advanceAlive(4 * 3600);
    await h.tick();
    await h.tick();
    await h.restart();
    await h.advanceAlive(3600);
    await h.tick();
    await h.tick();
    expect(h.host.executed).toHaveLength(1);
    expect(h.host.turns).toHaveLength(1);
    expect((await h.occurrences(scheduleId))[0]?.state).toBe("indeterminate");
    // Persisted host command id/payload unchanged by the restart.
    expect(JSON.stringify(h.preparedFor(occurrence))).toBe(storedBefore);
  });

  it("explicit replay of a replay-safe request resends the identical stored payload and adds no turn", async () => {
    const { h, scheduleId } = await lostResponseSetup({ replaySafe: true });
    h.host.script = ["lost-response"];
    await h.advanceAlive(120);
    await h.tick();
    const [occurrence] = await h.occurrences(scheduleId);
    const stored = h.preparedFor(occurrence)!;
    expect(stored.prepared.replaySafe).toBe(true);
    const payloadBefore = JSON.stringify(stored.prepared.payload);
    const commandId = stored.prepared.payload.commandId;
    expect(h.host.executedJson[0]).toBe(payloadBefore);

    await h.restart();
    await h.advanceAlive(3600);
    const replay = await h.daemon.scheduler.replayIndeterminate({
      occurrenceId: occurrence.occurrenceId,
    });
    expect(replay).toMatchObject({ state: "host_accepted", finished: true });
    // Identical bytes, same command id, host deduped it, prepare was not called again.
    expect(h.host.executedJson).toHaveLength(2);
    expect(h.host.executedJson[1]).toBe(payloadBefore);
    expect(JSON.stringify(h.preparedFor(occurrence)!.prepared.payload)).toBe(payloadBefore);
    expect(h.preparedFor(occurrence)!.prepared.payload.commandId).toBe(commandId);
    expect(h.host.prepared).toHaveLength(1);
    expect(h.host.deduped).toEqual([commandId]);
    expect(h.host.turns).toHaveLength(1);
    expect(h.host.mismatches).toEqual([]);
    expect((await h.occurrences(scheduleId))[0]?.state).toBe("host_accepted");
    expect(await h.scheduleStatus(scheduleId)).toBe("completed");
    // The command ids do not drift on later ticks.
    await h.tick();
    expect(h.host.executed).toHaveLength(2);
  });

  it("refuses to replay an unsafe effect and leaves the single visible turn alone", async () => {
    const { h, scheduleId } = await lostResponseSetup({ replaySafe: false });
    h.host.script = ["lost-response"];
    await h.advanceAlive(120);
    await h.tick();
    const [occurrence] = await h.occurrences(scheduleId);
    expect(h.preparedFor(occurrence)!.prepared.replaySafe).toBe(false);
    await expect(
      h.daemon.scheduler.replayIndeterminate({ occurrenceId: occurrence.occurrenceId }),
    ).rejects.toMatchObject({ code: "HOST_OUTCOME_INDETERMINATE" });
    expect(h.host.executed).toHaveLength(1);
    expect(h.host.turns).toHaveLength(1);
    const after = (await h.occurrences(scheduleId))[0];
    expect(after.state).toBe("indeterminate");
    expect(after.error.code).toBe("HOST_OUTCOME_INDETERMINATE");
    await h.restart();
    await h.tick();
    expect(h.host.executed).toHaveLength(1);
  });

  it("treats a lost-before-effect error exactly like an unknown outcome (no guess, no auto retry)", async () => {
    const { h, scheduleId } = await lostResponseSetup({ replaySafe: false });
    h.host.script = ["lost-before-effect"];
    await h.advanceAlive(120);
    await h.tick();
    await h.advanceAlive(3600);
    await h.tick();
    expect(h.host.turns).toHaveLength(0);
    expect(h.host.executed).toHaveLength(1);
    expect((await h.occurrences(scheduleId))[0]?.state).toBe("indeterminate");
  });

  it("a definitive retryable host failure retries as a new operation and yields one turn", async () => {
    const { h, scheduleId } = await lostResponseSetup({ replaySafe: true });
    h.host.script = ["retryable-failure"];
    await h.advanceAlive(120);
    await h.tick();
    expect(h.host.turns).toHaveLength(0);
    for (let i = 0; i < 8 && h.host.turns.length === 0; i += 1) {
      await h.advanceAlive(300);
      await h.tick();
    }
    await h.tick();
    expect(h.host.turns).toHaveLength(1);
    expect((await h.occurrences(scheduleId)).at(-1)?.state).toBe("host_accepted");
  });

  it("checkpoints the context leg: replaying a lost wake does not inject context twice", async () => {
    const { h, scheduleId } = await lostResponseSetup({ replaySafe: true, mode: "both" });
    h.host.script = ["ok", "lost-response"];
    await h.advanceAlive(120);
    await h.tick();
    const [occurrence] = await h.occurrences(scheduleId);
    expect(occurrence.state).toBe("indeterminate");
    expect(h.host.contexts).toHaveLength(1);
    expect(h.host.turns).toHaveLength(1);
    const contextCommand = h.preparedFor(occurrence, "context")!.prepared.payload.commandId;

    await h.daemon.scheduler.replayIndeterminate({ occurrenceId: occurrence.occurrenceId });
    // Only the unfinished wake leg was resent; the context leg stayed a checkpoint.
    expect(h.host.executed.filter((e) => e.prepared.leg === "context")).toHaveLength(1);
    expect(h.host.executed.filter((e) => e.prepared.leg === "wake")).toHaveLength(2);
    expect(h.host.contexts).toHaveLength(1);
    expect(h.host.turns).toHaveLength(1);
    expect(h.preparedFor(occurrence, "context")!.prepared.payload.commandId).toBe(contextCommand);
  });
});
