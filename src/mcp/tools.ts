import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  SidebandApiError,
  type SidebandMcpApiClient,
  type SidebandMcpRequestOptions,
} from "./http-client.js";

/**
 * One definition per Sideband tool, shared by every MCP host. The standalone server registers
 * these with its MCP SDK; another host (for example an authenticated host-side MCP server) can
 * read `sidebandToolCatalog()` for JSON Schemas and route calls through `callSidebandTool()`, so
 * contracts are defined exactly once.
 */
export type SidebandToolAudience = "agent" | "operator";

export interface SidebandToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface SidebandToolResult {
  readonly content: Array<{ type: "text"; text: string }>;
  readonly structuredContent: Record<string, unknown>;
  readonly isError: boolean;
  readonly [key: string]: unknown;
}

export interface SidebandToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly audience: SidebandToolAudience;
  readonly inputSchema: z.ZodObject;
  readonly annotations: SidebandToolAnnotations;
  run(api: SidebandMcpApiClient, input: unknown): Promise<unknown>;
}

export interface SidebandToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly audience: SidebandToolAudience;
  /** JSON Schema (draft 2020-12) for the tool arguments. */
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: SidebandToolAnnotations;
}

/** Thrown by a tool when arguments are well-typed but not meaningful together. */
class ToolArgumentError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

function defineTool<S extends z.ZodObject>(definition: {
  name: string;
  title: string;
  description: string;
  audience: SidebandToolAudience;
  inputSchema: S;
  annotations: SidebandToolAnnotations;
  run(api: SidebandMcpApiClient, input: z.output<S>): Promise<unknown>;
}): SidebandToolDefinition {
  return definition as unknown as SidebandToolDefinition;
}

const READ: SidebandToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: SidebandToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const HOST_EFFECT: SidebandToolAnnotations = { ...WRITE, openWorldHint: true };
const DESTRUCTIVE: SidebandToolAnnotations = { ...HOST_EFFECT, destructiveHint: true };

const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "Unique key for this exact request. Retrying with the same key never repeats the effect.",
  );
const metadataSchema = z.record(z.string(), z.unknown()).default({});
const after = z.string().min(1).optional().describe("Cursor from a previous page's `next`.");
const limit = z.number().int().min(1).max(200).optional();

/** Read requests keep the historical `(path, undefined)` call shape. */
function get(api: SidebandMcpApiClient, path: string): Promise<unknown> {
  return api.request(path, undefined);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix.length === 0 ? path : `${path}?${suffix}`;
}

const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 } as const;

const triggerSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("after"),
      delaySeconds: z.number().int().positive().optional(),
      delay: z
        .object({
          value: z.number().int().positive(),
          unit: z.enum(["seconds", "minutes", "hours", "days"]),
        })
        .optional()
        .describe("Friendly form, e.g. {value:30,unit:'minutes'}. Give this or delaySeconds."),
    }),
    z.strictObject({
      type: z.literal("at"),
      at: z
        .string()
        .min(1)
        .describe("RFC 3339 time with Z or an explicit offset, e.g. 2026-10-09T09:00:00-04:00."),
    }),
    z.strictObject({
      type: z.literal("interval"),
      everySeconds: z.number().int().positive(),
      startAt: z
        .string()
        .min(1)
        .optional()
        .describe("RFC 3339 first slot; default now + interval."),
    }),
    z.strictObject({
      type: z.literal("cron"),
      expression: z
        .string()
        .min(1)
        .describe(
          "Five fields: minute hour day-of-month month day-of-week, e.g. '0 9 * * MON-FRI'.",
        ),
      timezone: z
        .string()
        .min(1)
        .optional()
        .describe("IANA zone such as America/New_York. Default UTC."),
    }),
  ])
  .describe("When to fire. Sideband never guesses a timezone; use an explicit offset or zone.");

function normalizeTrigger(trigger: z.output<typeof triggerSchema>): Record<string, unknown> {
  if (trigger.type !== "after") return trigger;
  if ((trigger.delaySeconds === undefined) === (trigger.delay === undefined)) {
    throw new ToolArgumentError(
      "An after trigger needs exactly one of delaySeconds or delay.",
      "trigger.delay",
    );
  }
  const delaySeconds =
    trigger.delaySeconds ?? trigger.delay!.value * UNIT_SECONDS[trigger.delay!.unit];
  if (!Number.isSafeInteger(delaySeconds)) {
    throw new ToolArgumentError("The delay is too large.", "trigger.delay");
  }
  return { type: "after", delaySeconds };
}

export const sidebandTools: readonly SidebandToolDefinition[] = [
  defineTool({
    name: "sideband_capabilities_get",
    title: "Sideband capabilities",
    description:
      "Report what this Sideband can do for you: supported schedule triggers, whether your host can receive a wake, context, or both, and the receipt level. Check before asking for context delivery.",
    audience: "agent",
    inputSchema: z.strictObject({}),
    annotations: READ,
    run: (api) => get(api, "/v1/capabilities"),
  }),
  defineTool({
    name: "sideband_identity_get",
    title: "Who am I",
    description:
      "Show the identity this credential is bound to: agent id, host session, binding and grants. Never returns a secret.",
    audience: "agent",
    inputSchema: z.strictObject({}),
    annotations: READ,
    run: (api) => get(api, "/v1/me"),
  }),
  defineTool({
    name: "sideband_schedule_create",
    title: "Schedule a wake-up",
    description:
      "Schedule a durable future message. It targets you by default and wakes you with a visible message. Examples: in 30 minutes -> trigger {type:'after',delay:{value:30,unit:'minutes'}}; at a time -> {type:'at',at:'2026-10-09T13:00:00Z'}; every weekday at 9 in New York -> {type:'cron',expression:'0 9 * * MON-FRI',timezone:'America/New_York'}. deliveryMode 'context' or 'both' is refused unless your host supports context; there is no silent fallback to wake.",
    audience: "agent",
    inputSchema: z.strictObject({
      idempotencyKey,
      body: z.string().min(1).describe("The message you will receive when the schedule fires."),
      trigger: triggerSchema,
      name: z.string().min(1).max(200).optional().describe("Short label. Default 'Reminder'."),
      targetAgentId: z
        .string()
        .min(1)
        .optional()
        .describe("Omit to schedule for yourself. Other targets need an explicit grant."),
      deliveryMode: z
        .enum(["wake", "context", "both"])
        .optional()
        .describe(
          "wake = visible user message (default); context = silent context; both = context then wake.",
        ),
    }),
    annotations: WRITE,
    run: (api, input) =>
      api.request("/v1/schedules", {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          body: input.body,
          trigger: normalizeTrigger(input.trigger),
          ...(input.deliveryMode === undefined ? {} : { deliveryMode: input.deliveryMode }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.targetAgentId === undefined ? {} : { targetAgentId: input.targetAgentId }),
        },
      }),
  }),
  defineTool({
    name: "sideband_schedules_list",
    title: "List schedules",
    description: "List schedules you own or that target you, oldest first.",
    audience: "agent",
    inputSchema: z.strictObject({
      status: z.enum(["active", "completed", "cancelled", "blocked", "suspended"]).optional(),
      targetAgentId: z.string().min(1).optional(),
      after,
      limit,
    }),
    annotations: READ,
    run: (api, input) => get(api, withQuery("/v1/schedules", input)),
  }),
  defineTool({
    name: "sideband_schedule_get",
    title: "Get a schedule",
    description: "Show one schedule with its next due time and latest occurrence receipt.",
    audience: "agent",
    inputSchema: z.strictObject({ scheduleId: z.string().min(1) }),
    annotations: READ,
    run: (api, input) => get(api, `/v1/schedules/${segment(input.scheduleId)}`),
  }),
  defineTool({
    name: "sideband_schedule_occurrences_list",
    title: "Schedule delivery history",
    description:
      "List each time a schedule fired: lateness, host receipt stage, and why an occurrence was blocked.",
    audience: "agent",
    inputSchema: z.strictObject({ scheduleId: z.string().min(1), after, limit }),
    annotations: READ,
    run: (api, input) =>
      get(
        api,
        withQuery(`/v1/schedules/${segment(input.scheduleId)}/occurrences`, {
          after: input.after,
          limit: input.limit,
        }),
      ),
  }),
  defineTool({
    name: "sideband_schedule_cancel",
    title: "Cancel a schedule",
    description:
      "Cancel a schedule you own. Reports which pending occurrences were suppressed and which were already in flight or accepted.",
    audience: "agent",
    inputSchema: z.strictObject({ scheduleId: z.string().min(1), idempotencyKey }),
    annotations: { ...WRITE, destructiveHint: true },
    run: (api, input) =>
      api.request(`/v1/schedules/${segment(input.scheduleId)}/cancel`, {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
      }),
  }),
  defineTool({
    name: "sideband_agents_list",
    title: "List agents",
    description: "List agents registered with Agent Sideband.",
    audience: "agent",
    inputSchema: z.strictObject({ after, limit }),
    annotations: READ,
    run: (api, input) => get(api, withQuery("/v1/agents", input)),
  }),
  defineTool({
    name: "sideband_message_send",
    title: "Send a message",
    description:
      "Send a durable direct or channel message. Sender identity comes from the credential.",
    audience: "agent",
    inputSchema: z.strictObject({
      idempotencyKey,
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
    annotations: WRITE,
    run: (api, input) =>
      api.request("/v1/messages", {
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
  }),
  defineTool({
    name: "sideband_inbox_list",
    title: "Read inbox",
    description: "List durable inbox messages for the credential-bound agent.",
    audience: "agent",
    inputSchema: z.strictObject({ after, limit }),
    annotations: READ,
    run: (api, input) => get(api, withQuery("/v1/inbox", input)),
  }),
  defineTool({
    name: "sideband_message_claim",
    title: "Claim a message",
    description: "Claim an inbox message under a bounded lease.",
    audience: "agent",
    inputSchema: z.strictObject({
      messageId: z.string().min(1),
      consumerId: z.string().min(1),
      leaseSeconds: z.number().int().min(1).max(300),
    }),
    annotations: { ...WRITE, idempotentHint: false },
    run: (api, input) =>
      api.request(`/v1/inbox/${segment(input.messageId)}/claim`, {
        method: "POST",
        body: { consumerId: input.consumerId, leaseSeconds: input.leaseSeconds },
      }),
  }),
  defineTool({
    name: "sideband_message_ack",
    title: "Acknowledge a message",
    description: "Acknowledge a claimed inbox message as delivered.",
    audience: "agent",
    inputSchema: z.strictObject({
      messageId: z.string().min(1),
      claimToken: z.string().min(1),
      receiptId: z.string().min(1).optional(),
    }),
    annotations: WRITE,
    run: (api, input) =>
      api.request(`/v1/inbox/${segment(input.messageId)}/ack`, {
        method: "POST",
        body: {
          claimToken: input.claimToken,
          ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
        },
      }),
  }),
  defineTool({
    name: "sideband_message_release",
    title: "Release a message",
    description: "Release a claimed inbox message back to pending.",
    audience: "agent",
    inputSchema: z.strictObject({ messageId: z.string().min(1), claimToken: z.string().min(1) }),
    annotations: WRITE,
    run: (api, input) =>
      api.request(`/v1/inbox/${segment(input.messageId)}/release`, {
        method: "POST",
        body: { claimToken: input.claimToken },
      }),
  }),
  defineTool({
    name: "sideband_presence_heartbeat",
    title: "Presence heartbeat",
    description: "Refresh presence for the credential-bound agent.",
    audience: "agent",
    inputSchema: z.strictObject({ signal: z.string().min(1) }),
    annotations: WRITE,
    run: (api, input) =>
      api.request("/v1/presence/heartbeat", { method: "POST", body: { signal: input.signal } }),
  }),
  defineTool({
    name: "sideband_host_message_send",
    title: "Notify a host",
    description:
      "Notify a bound host about an existing durable message without acknowledging its inbox delivery.",
    audience: "operator",
    inputSchema: z.strictObject({
      idempotencyKey,
      bindingId: z.string().min(1),
      messageId: z.string().min(1),
      mode: z.enum(["wake", "context", "both"]),
    }),
    annotations: HOST_EFFECT,
    run: (api, input) =>
      api.request(`/v1/bindings/${segment(input.bindingId)}/send`, {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: { messageId: input.messageId, mode: input.mode },
      }),
  }),
  defineTool({
    name: "sideband_agent_spawn",
    title: "Spawn an agent",
    description: "Spawn an agent through a configured host adapter.",
    audience: "operator",
    inputSchema: z.strictObject({
      idempotencyKey,
      agentId: z.string().min(1),
      adapter: z.string().min(1),
      provider: z.string().min(1),
      prompt: z.string().min(1),
      metadata: metadataSchema,
    }),
    annotations: HOST_EFFECT,
    run: (api, input) =>
      api.request(`/v1/agents/${segment(input.agentId)}/spawn`, {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          adapter: input.adapter,
          provider: input.provider,
          prompt: input.prompt,
          metadata: input.metadata,
        },
      }),
  }),
  defineTool({
    name: "sideband_agent_bind",
    title: "Bind a host session",
    description: "Bind an existing host session to a Sideband agent.",
    audience: "operator",
    inputSchema: z.strictObject({
      idempotencyKey,
      agentId: z.string().min(1),
      adapter: z.string().min(1),
      externalId: z.string().min(1),
      hostInstanceId: z.string().min(1),
      providerSessionId: z.string().min(1).optional(),
      generation: z.number().int().min(1).optional(),
      metadata: metadataSchema,
    }),
    annotations: HOST_EFFECT,
    run: (api, input) =>
      api.request("/v1/bindings", {
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
  }),
  ...(["interrupt", "stop"] as const).map((action) =>
    defineTool({
      name: `sideband_agent_${action}`,
      title: action === "stop" ? "Stop an agent" : "Interrupt an agent",
      description: `${action === "stop" ? "Stop" : "Interrupt"} an agent through its active host binding.`,
      audience: "operator",
      inputSchema: z.strictObject({ idempotencyKey, agentId: z.string().min(1) }),
      annotations: DESTRUCTIVE,
      run: (api, input) =>
        api.request(`/v1/agents/${segment(input.agentId)}/${action}`, {
          method: "POST",
          idempotencyKey: input.idempotencyKey,
        }),
    }),
  ),
  defineTool({
    name: "sideband_events_list",
    title: "Read the event log",
    description: "Read the ordered durable Sideband event log.",
    audience: "operator",
    inputSchema: z.strictObject({
      afterSequence: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
    annotations: READ,
    run: (api, input) =>
      get(
        api,
        withQuery("/v1/events", { after_sequence: input.afterSequence, limit: input.limit }),
      ),
  }),
  defineTool({
    name: "sideband_schedule_event_emit",
    title: "Publish a named event",
    description:
      "Publish a named event that fires matching event schedules. Requires an operator or trusted host credential.",
    audience: "operator",
    inputSchema: z.strictObject({
      eventId: z
        .string()
        .min(1)
        .max(128)
        .describe("Unique id; replays with the same id are no-ops."),
      eventName: z.string().min(1),
      occurredAt: z
        .string()
        .min(1)
        .describe("RFC 3339 time the event happened; not in the future."),
      payload: metadataSchema,
    }),
    annotations: HOST_EFFECT,
    run: (api, input) =>
      api.request("/v1/schedule-events", {
        method: "POST",
        idempotencyKey: input.eventId,
        body: { eventName: input.eventName, occurredAt: input.occurredAt, payload: input.payload },
      }),
  }),
];

function selectTools(audiences: readonly SidebandToolAudience[]): SidebandToolDefinition[] {
  return sidebandTools.filter((tool) => audiences.includes(tool.audience));
}

/** SDK-neutral descriptors, suitable for any MCP implementation that accepts JSON Schema. */
export function sidebandToolCatalog(
  options: { readonly audiences?: readonly SidebandToolAudience[] } = {},
): SidebandToolDescriptor[] {
  return selectTools(options.audiences ?? ["agent", "operator"]).map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    audience: tool.audience,
    inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>,
    annotations: tool.annotations,
  }));
}

function textResult(
  structuredContent: Record<string, unknown>,
  isError: boolean,
): SidebandToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError,
  };
}

export function sidebandToolSuccess(value: unknown): SidebandToolResult {
  const structured =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value ?? null };
  return textResult(structured, false);
}

/**
 * Structured failure: `{ error: { code, message, details, retryable } }`. Only daemon-sanitized
 * fields are copied; transport internals and credentials never reach the model.
 */
export function sidebandToolFailure(error: unknown): SidebandToolResult {
  if (error instanceof SidebandApiError) {
    return textResult(
      {
        error: {
          code: error.remoteCode ?? error.code,
          message: error.message,
          details: error.details,
          retryable: error.retryable,
          ...(error.status === undefined ? {} : { status: error.status }),
        },
      },
      true,
    );
  }
  if (error instanceof ToolArgumentError) {
    return textResult(
      {
        error: {
          code: "INVALID_ARGUMENT",
          message: error.message,
          details: { field: error.field },
          retryable: false,
        },
      },
      true,
    );
  }
  if (error instanceof z.ZodError) {
    return textResult(
      {
        error: {
          code: "INVALID_ARGUMENT",
          message: "Tool arguments do not match the schema.",
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
          retryable: false,
        },
      },
      true,
    );
  }
  return textResult(
    {
      error: {
        code: "SIDEBAND_REQUEST_FAILED",
        message: "Agent Sideband request failed.",
        details: {},
        retryable: false,
      },
    },
    true,
  );
}

/** Runs a tool with already-validated input. */
export async function runSidebandTool(
  tool: SidebandToolDefinition,
  api: SidebandMcpApiClient,
  input: unknown,
): Promise<SidebandToolResult> {
  try {
    return sidebandToolSuccess(await tool.run(api, input));
  } catch (error) {
    return sidebandToolFailure(error);
  }
}

/** Validates raw arguments and runs a tool by name. Unknown tools fail as a structured result. */
export async function invokeSidebandTool(
  api: SidebandMcpApiClient,
  name: string,
  args: unknown,
  options: { readonly audiences?: readonly SidebandToolAudience[] } = {},
): Promise<SidebandToolResult> {
  const tool = selectTools(options.audiences ?? ["agent", "operator"]).find(
    (candidate) => candidate.name === name,
  );
  if (tool === undefined) {
    return textResult(
      {
        error: {
          code: "TOOL_NOT_FOUND",
          message: `Unknown Sideband tool: ${name}`,
          details: {},
          retryable: false,
        },
      },
      true,
    );
  }
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) return sidebandToolFailure(parsed.error);
  return runSidebandTool(tool, api, parsed.data);
}

/** Registers the shared catalog on an MCP SDK server, e.g. a host's own authenticated server. */
export function registerSidebandTools(
  server: McpServer,
  api: SidebandMcpApiClient,
  options: { readonly audiences?: readonly SidebandToolAudience[] } = {},
): void {
  for (const tool of selectTools(options.audiences ?? ["agent", "operator"])) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (input: unknown) => runSidebandTool(tool, api, input),
    );
  }
}

export type { SidebandMcpApiClient, SidebandMcpRequestOptions };
