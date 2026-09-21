import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";

import Database from "better-sqlite3";

import { SidebandError } from "../core/errors.js";
import type { HostOperationReceipt } from "../core/host-adapter.js";
import type {
  AgentBinding,
  AgentRecord,
  ChannelRecord,
  ClaimRecord,
  DeliveryRecord,
  MessageProvenance,
  MessageRecord,
  OperationRecord,
  Page,
  PageRequest,
  PresenceRecord,
  SidebandEvent,
  TeamMember,
  TeamRecord,
} from "../core/types.js";
import type {
  BeginOperationInput,
  BeginOperationResult,
  BindAgentInput,
  ClaimOperationDispatchResult,
  RecordOperationReceiptInput,
  SendMessageInput,
  SidebandStore,
} from "./store.js";

const MAX_PAGE_SIZE = 1_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_BODY_BYTES = 256 * 1_024;
const MAX_METADATA_BYTES = 64 * 1_024;
const MAX_LEASE_SECONDS = 300;
const MAX_JSON_DEPTH = 16;

export interface SqliteSidebandStoreOptions {
  readonly now?: () => string | Date;
  readonly onlineSeconds?: number;
  readonly idleSeconds?: number;
  readonly tokenBytes?: (size: number) => Uint8Array;
}

interface AgentRow {
  agent_id: string;
  display_name: string | null;
  lifecycle: "active" | "retired";
  created_at: string;
  updated_at: string;
}

interface TeamRow {
  team_id: string;
  display_name: string | null;
  created_at: string;
}

interface TeamMemberRow {
  team_id: string;
  agent_id: string;
  role: string;
  parent_agent_id: string | null;
  joined_at: string;
  updated_at: string;
}

interface ChannelRow {
  channel_id: string;
  display_name: string | null;
  team_id: string | null;
  lead_agent_id: string | null;
  created_at: string;
}

interface MessageRow {
  message_id: string;
  idempotency_key: string;
  from_agent_id: string;
  target_type: "agent" | "channel";
  target_id: string;
  correlation_id: string;
  body: string;
  message_class: MessageRecord["messageClass"];
  metadata_json: string;
  provenance_json: string;
  created_at: string;
}

interface DeliveryRow {
  message_id: string;
  recipient_agent_id: string;
  status: DeliveryRecord["status"];
  consumer_id: string | null;
  claim_expires_at: string | null;
  receipt_id: string | null;
  ack_token_hash: string | null;
  delivered_at: string | null;
}

interface ClaimRow {
  message_id: string;
  recipient_agent_id: string;
  consumer_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

interface BindingRow {
  binding_id: string;
  agent_id: string;
  adapter: string;
  host_instance_id: string;
  external_id: string;
  provider_session_id: string | null;
  generation: number;
  state: AgentBinding["state"];
  active: number;
  capabilities_json: string;
  metadata_json: string;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  operation_id: string;
  principal_id: string;
  idempotency_key: string;
  request_hash: string;
  kind: OperationRecord["kind"];
  adapter: string;
  agent_id: string;
  binding_id: string | null;
  message_id: string | null;
  correlation_id: string | null;
  stage: OperationRecord["stage"];
  dispatch_owner_id: string | null;
  dispatch_started_at: string | null;
  host_receipt_id: string | null;
  detail_json: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  sequence: number;
  event_id: string;
  schema_version: 1;
  type: string;
  entity_type: string;
  entity_id: string;
  actor_principal_id: string;
  correlation_id: string | null;
  causation_id: string | null;
  payload_json: string;
  occurred_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  resource_type: string;
  resource_id: string;
}

function fail(code: ConstructorParameters<typeof SidebandError>[0], message: string): never {
  throw new SidebandError(code, message);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function validateIdentifier(value: string, name: string): string {
  if (
    value.length === 0 ||
    value.length > 128 ||
    hasControlCharacters(value) ||
    value.trim() !== value
  ) {
    fail(
      "INVALID_ARGUMENT",
      `${name} must be 1-128 non-control characters without edge whitespace.`,
    );
  }
  return value;
}

function validateText(value: string, name: string, maxBytes: number): string {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) {
    fail(
      "INVALID_ARGUMENT",
      `${name} must be non-empty, contain no NUL, and be at most ${maxBytes} bytes.`,
    );
  }
  return value;
}

function canonicalize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_JSON_DEPTH) fail("INVALID_ARGUMENT", "JSON value exceeds maximum nesting depth.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_ARGUMENT", "JSON numbers must be finite.");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("INVALID_ARGUMENT", "JSON value must not contain cycles.");
    seen.add(value);
    const result = value.map((entry) => {
      if (entry === undefined) fail("INVALID_ARGUMENT", "JSON arrays must not contain undefined.");
      return canonicalize(entry, depth + 1, seen);
    });
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      fail("INVALID_ARGUMENT", "JSON objects must be plain objects.");
    }
    if (seen.has(object)) fail("INVALID_ARGUMENT", "JSON value must not contain cycles.");
    seen.add(object);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(object).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        fail("INVALID_ARGUMENT", `Unsafe JSON key: ${key}.`);
      }
      const entry = object[key];
      if (entry !== undefined) result[key] = canonicalize(entry, depth + 1, seen);
    }
    seen.delete(object);
    return result;
  }
  fail("INVALID_ARGUMENT", "Value must be JSON serializable.");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function parseObject(json: string): Readonly<Record<string, unknown>> {
  return JSON.parse(json) as Readonly<Record<string, unknown>>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function pageLimit(input: PageRequest | undefined): number {
  const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    fail("INVALID_ARGUMENT", `limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return limit;
}

function agentFromRow(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    lifecycle: row.lifecycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memberFromRow(row: TeamMemberRow): TeamMember {
  return {
    teamId: row.team_id,
    agentId: row.agent_id,
    role: row.role,
    parentAgentId: row.parent_agent_id,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  };
}

function deliveryFromRow(row: DeliveryRow): DeliveryRecord {
  return {
    messageId: row.message_id,
    recipientAgentId: row.recipient_agent_id,
    status: row.status,
    consumerId: row.consumer_id,
    claimExpiresAt: row.claim_expires_at,
    receiptId: row.receipt_id,
    deliveredAt: row.delivered_at,
  };
}

function bindingFromRow(row: BindingRow): AgentBinding {
  return {
    bindingId: row.binding_id,
    agentId: row.agent_id,
    adapter: row.adapter,
    hostInstanceId: row.host_instance_id,
    externalId: row.external_id,
    providerSessionId: row.provider_session_id,
    generation: row.generation,
    state: row.state,
    active: row.active === 1,
    capabilities: parseObject(row.capabilities_json) as Readonly<Record<string, boolean>>,
    metadata: parseObject(row.metadata_json),
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function operationFromRow(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    principalId: row.principal_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    kind: row.kind,
    adapter: row.adapter,
    agentId: row.agent_id,
    bindingId: row.binding_id,
    messageId: row.message_id,
    correlationId: row.correlation_id,
    stage: row.stage,
    dispatchOwnerId: row.dispatch_owner_id,
    dispatchStartedAt: row.dispatch_started_at,
    hostReceiptId: row.host_receipt_id,
    detail: parseObject(row.detail_json),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSidebandStore implements SidebandStore {
  private constructor(
    private readonly database: Database.Database,
    private readonly options: Required<SqliteSidebandStoreOptions>,
  ) {}

  static open(path: string, options: SqliteSidebandStoreOptions = {}): SqliteSidebandStore {
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    if (path !== ":memory:") database.pragma("journal_mode = WAL");
    const migration = readFileSync(
      new URL("../../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );
    database.exec(migration);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Read-only or platform-specific filesystems may not expose chmod.
      }
    }
    const onlineSeconds = options.onlineSeconds ?? 60;
    const idleSeconds = options.idleSeconds ?? 300;
    if (onlineSeconds < 0 || idleSeconds <= onlineSeconds) {
      database.close();
      fail("INVALID_ARGUMENT", "Presence thresholds require 0 <= onlineSeconds < idleSeconds.");
    }
    const store = new SqliteSidebandStore(database, {
      now: options.now ?? (() => new Date()),
      onlineSeconds,
      idleSeconds,
      tokenBytes: options.tokenBytes ?? ((size) => randomBytes(size)),
    });
    store.recoverInterruptedDispatches();
    return store;
  }

  private now(): string {
    const value = this.options.now();
    const date = typeof value === "string" ? new Date(value) : value;
    if (!Number.isFinite(date.getTime()))
      fail("INVALID_ARGUMENT", "Clock returned an invalid date.");
    return date.toISOString();
  }

  private appendEvent(input: {
    type: string;
    entityType: string;
    entityId: string;
    actorPrincipalId: string;
    correlationId?: string;
    causationId?: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO events (
          event_id, schema_version, type, entity_type, entity_id,
          actor_principal_id, correlation_id, causation_id, payload_json, occurred_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.type,
        input.entityType,
        input.entityId,
        input.actorPrincipalId,
        input.correlationId ?? null,
        input.causationId ?? null,
        canonicalJson(input.payload),
        input.occurredAt,
      );
  }

  private recoverInterruptedDispatches(): void {
    this.database.transaction(() => {
      const interrupted = this.database
        .prepare("SELECT * FROM operations WHERE stage = 'dispatching' ORDER BY created_at")
        .all() as OperationRow[];
      if (interrupted.length === 0) return;
      const now = this.now();
      for (const row of interrupted) {
        this.database
          .prepare(
            `UPDATE operations SET stage = 'indeterminate',
               error_code = 'PROCESS_RESTART_DURING_DISPATCH',
               error_message = 'The Sideband process restarted while the host dispatch was in flight.',
               updated_at = ?
             WHERE operation_id = ? AND stage = 'dispatching'`,
          )
          .run(now, row.operation_id);
        this.appendEvent({
          type: "operation.dispatch-interrupted",
          entityType: "operation",
          entityId: row.operation_id,
          actorPrincipalId: row.principal_id,
          ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
          ...(row.dispatch_owner_id === null ? {} : { causationId: row.dispatch_owner_id }),
          payload: {
            priorStage: "dispatching",
            stage: "indeterminate",
            errorCode: "PROCESS_RESTART_DURING_DISPATCH",
          },
          occurredAt: now,
        });
      }
    })();
  }

  registerAgent(input: {
    agentId: string;
    displayName?: string | undefined;
    actorPrincipalId?: string;
  }): AgentRecord {
    const agentId = validateIdentifier(input.agentId, "agentId");
    const displayName = input.displayName ?? null;
    if (displayName !== null) validateText(displayName, "displayName", 512);
    return this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM agents WHERE agent_id = ?")
        .get(agentId) as AgentRow | undefined;
      if (existing) {
        if (existing.display_name !== displayName) {
          fail("AGENT_CONFLICT", `Agent ${agentId} already exists with different properties.`);
        }
        return agentFromRow(existing);
      }
      const now = this.now();
      this.database
        .prepare(
          "INSERT INTO agents (agent_id, display_name, lifecycle, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
        )
        .run(agentId, displayName, now, now);
      this.database
        .prepare(
          "INSERT INTO presence (agent_id, last_seen_at, last_signal) VALUES (?, NULL, NULL)",
        )
        .run(agentId);
      this.appendEvent({
        type: "agent.registered",
        entityType: "agent",
        entityId: agentId,
        actorPrincipalId: input.actorPrincipalId ?? "local-owner",
        payload: { agentId, displayName },
        occurredAt: now,
      });
      return this.getAgent(agentId);
    })();
  }

  getAgent(agentId: string): AgentRecord {
    const row = this.database.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as
      | AgentRow
      | undefined;
    if (!row) fail("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    return agentFromRow(row);
  }

  listAgents(input?: PageRequest): readonly AgentRecord[] {
    return this.pageAgents(input).items;
  }

  pageAgents(input: PageRequest = {}): Page<AgentRecord> {
    const limit = pageLimit(input);
    const rows = this.database
      .prepare("SELECT * FROM agents WHERE agent_id > ? ORDER BY agent_id LIMIT ?")
      .all(input.after ?? "", limit + 1) as AgentRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(agentFromRow);
    return { items, next: hasMore ? (items.at(-1)?.agentId ?? null) : null };
  }

  getPresence(agentId: string): PresenceRecord {
    this.getAgent(agentId);
    const row = this.database
      .prepare("SELECT last_seen_at, last_signal FROM presence WHERE agent_id = ?")
      .get(agentId) as { last_seen_at: string | null; last_signal: string | null } | undefined;
    const lastSeenAt = row?.last_seen_at ?? null;
    if (lastSeenAt === null) return { agentId, state: "never_seen", lastSeenAt, lastSignal: null };
    const ageSeconds = (new Date(this.now()).getTime() - new Date(lastSeenAt).getTime()) / 1_000;
    const state =
      ageSeconds <= this.options.onlineSeconds
        ? "online"
        : ageSeconds <= this.options.idleSeconds
          ? "idle"
          : "offline";
    return { agentId, state, lastSeenAt, lastSignal: row?.last_signal ?? null };
  }

  touchPresence(input: {
    agentId: string;
    signal: string;
    actorPrincipalId?: string;
  }): PresenceRecord {
    this.getAgent(input.agentId);
    validateIdentifier(input.signal, "signal");
    this.database.transaction(() => {
      const now = this.now();
      this.database
        .prepare("UPDATE presence SET last_seen_at = ?, last_signal = ? WHERE agent_id = ?")
        .run(now, input.signal, input.agentId);
      this.appendEvent({
        type: "presence.touched",
        entityType: "agent",
        entityId: input.agentId,
        actorPrincipalId: input.actorPrincipalId ?? input.agentId,
        payload: { signal: input.signal },
        occurredAt: now,
      });
    })();
    return this.getPresence(input.agentId);
  }

  createTeam(input: {
    teamId: string;
    displayName?: string | undefined;
    actorPrincipalId?: string;
  }): TeamRecord {
    const teamId = validateIdentifier(input.teamId, "teamId");
    const displayName = input.displayName ?? null;
    if (displayName !== null) validateText(displayName, "displayName", 512);
    return this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM teams WHERE team_id = ?")
        .get(teamId) as TeamRow | undefined;
      if (existing) {
        if (existing.display_name !== displayName) {
          fail("TEAM_CONFLICT", `Team ${teamId} already exists with different properties.`);
        }
        return this.getTeam(teamId);
      }
      const now = this.now();
      this.database
        .prepare("INSERT INTO teams (team_id, display_name, created_at) VALUES (?, ?, ?)")
        .run(teamId, displayName, now);
      this.appendEvent({
        type: "team.created",
        entityType: "team",
        entityId: teamId,
        actorPrincipalId: input.actorPrincipalId ?? "local-owner",
        payload: { teamId, displayName },
        occurredAt: now,
      });
      return this.getTeam(teamId);
    })();
  }

  addTeamMember(input: {
    teamId: string;
    agentId: string;
    role: string;
    parentAgentId?: string | undefined;
    actorPrincipalId?: string;
  }): TeamMember {
    this.getTeam(input.teamId);
    this.getAgent(input.agentId);
    validateIdentifier(input.role, "role");
    const parentAgentId = input.parentAgentId ?? null;
    if (parentAgentId === input.agentId) {
      fail("TEAM_PARENT_CYCLE", "An agent cannot be its own team parent.");
    }
    return this.database.transaction(() => {
      if (parentAgentId !== null) {
        const parent = this.database
          .prepare("SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?")
          .get(input.teamId, parentAgentId) as TeamMemberRow | undefined;
        if (!parent) fail("TEAM_PARENT_NOT_FOUND", `Team parent not found: ${parentAgentId}`);
        let cursor: string | null = parentAgentId;
        while (cursor !== null) {
          if (cursor === input.agentId) {
            fail("TEAM_PARENT_CYCLE", `Parent assignment would create a cycle in ${input.teamId}.`);
          }
          const row = this.database
            .prepare("SELECT parent_agent_id FROM team_members WHERE team_id = ? AND agent_id = ?")
            .get(input.teamId, cursor) as { parent_agent_id: string | null } | undefined;
          cursor = row?.parent_agent_id ?? null;
        }
      }
      const existing = this.database
        .prepare("SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?")
        .get(input.teamId, input.agentId) as TeamMemberRow | undefined;
      if (existing && existing.role === input.role && existing.parent_agent_id === parentAgentId) {
        return memberFromRow(existing);
      }
      const now = this.now();
      if (existing) {
        this.database
          .prepare(
            "UPDATE team_members SET role = ?, parent_agent_id = ?, updated_at = ? WHERE team_id = ? AND agent_id = ?",
          )
          .run(input.role, parentAgentId, now, input.teamId, input.agentId);
      } else {
        this.database
          .prepare(
            `INSERT INTO team_members
              (team_id, agent_id, role, parent_agent_id, joined_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(input.teamId, input.agentId, input.role, parentAgentId, now, now);
      }
      this.appendEvent({
        type: existing ? "team.member-updated" : "team.member-added",
        entityType: "team",
        entityId: input.teamId,
        actorPrincipalId: input.actorPrincipalId ?? "local-owner",
        payload: { agentId: input.agentId, role: input.role, parentAgentId },
        occurredAt: now,
      });
      const row = this.database
        .prepare("SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?")
        .get(input.teamId, input.agentId) as TeamMemberRow;
      return memberFromRow(row);
    })();
  }

  getTeam(teamId: string): TeamRecord {
    const team = this.database.prepare("SELECT * FROM teams WHERE team_id = ?").get(teamId) as
      | TeamRow
      | undefined;
    if (!team) fail("TEAM_NOT_FOUND", `Team not found: ${teamId}`);
    const members = this.database
      .prepare("SELECT * FROM team_members WHERE team_id = ? ORDER BY agent_id")
      .all(teamId) as TeamMemberRow[];
    return {
      teamId: team.team_id,
      displayName: team.display_name,
      createdAt: team.created_at,
      members: members.map(memberFromRow),
    };
  }

  createChannel(input: {
    channelId: string;
    displayName?: string | undefined;
    teamId?: string | undefined;
    leadAgentId?: string | undefined;
    actorPrincipalId?: string;
  }): ChannelRecord {
    const channelId = validateIdentifier(input.channelId, "channelId");
    if (input.teamId) this.getTeam(input.teamId);
    if (input.leadAgentId) this.getAgent(input.leadAgentId);
    const displayName = input.displayName ?? null;
    return this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM channels WHERE channel_id = ?")
        .get(channelId) as ChannelRow | undefined;
      if (existing) {
        if (
          existing.display_name !== displayName ||
          existing.team_id !== (input.teamId ?? null) ||
          existing.lead_agent_id !== (input.leadAgentId ?? null)
        ) {
          fail(
            "CHANNEL_CONFLICT",
            `Channel ${channelId} already exists with different properties.`,
          );
        }
        return this.getChannel(channelId);
      }
      const now = this.now();
      this.database
        .prepare(
          "INSERT INTO channels (channel_id, display_name, team_id, lead_agent_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(channelId, displayName, input.teamId ?? null, input.leadAgentId ?? null, now);
      this.appendEvent({
        type: "channel.created",
        entityType: "channel",
        entityId: channelId,
        actorPrincipalId: input.actorPrincipalId ?? "local-owner",
        payload: {
          channelId,
          displayName,
          teamId: input.teamId ?? null,
          leadAgentId: input.leadAgentId ?? null,
        },
        occurredAt: now,
      });
      return this.getChannel(channelId);
    })();
  }

  addChannelMember(input: {
    channelId: string;
    agentId: string;
    actorPrincipalId?: string;
  }): ChannelRecord {
    this.getChannel(input.channelId);
    this.getAgent(input.agentId);
    this.database.transaction(() => {
      const now = this.now();
      const result = this.database
        .prepare(
          "INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)",
        )
        .run(input.channelId, input.agentId, now);
      if (result.changes === 1) {
        this.appendEvent({
          type: "channel.member-added",
          entityType: "channel",
          entityId: input.channelId,
          actorPrincipalId: input.actorPrincipalId ?? "local-owner",
          payload: { agentId: input.agentId },
          occurredAt: now,
        });
      }
    })();
    return this.getChannel(input.channelId);
  }

  getChannel(channelId: string): ChannelRecord {
    const row = this.database
      .prepare("SELECT * FROM channels WHERE channel_id = ?")
      .get(channelId) as ChannelRow | undefined;
    if (!row) fail("CHANNEL_NOT_FOUND", `Channel not found: ${channelId}`);
    const members = this.database
      .prepare("SELECT agent_id FROM channel_members WHERE channel_id = ? ORDER BY agent_id")
      .all(channelId) as Array<{ agent_id: string }>;
    return {
      channelId: row.channel_id,
      displayName: row.display_name,
      teamId: row.team_id,
      leadAgentId: row.lead_agent_id,
      createdAt: row.created_at,
      memberAgentIds: members.map(({ agent_id }) => agent_id),
    };
  }

  sendMessage(input: SendMessageInput): MessageRecord {
    validateIdentifier(input.idempotencyKey, "idempotencyKey");
    validateIdentifier(input.correlationId, "correlationId");
    validateText(input.body, "body", MAX_BODY_BYTES);
    this.getAgent(input.fromAgentId);
    const provenance = this.validateProvenance(input.provenance);
    const metadataJson = canonicalJson(input.metadata ?? {});
    if (Buffer.byteLength(metadataJson, "utf8") > MAX_METADATA_BYTES) {
      fail("INVALID_ARGUMENT", `metadata must be at most ${MAX_METADATA_BYTES} bytes.`);
    }
    const request = {
      fromAgentId: input.fromAgentId,
      target: input.target,
      correlationId: input.correlationId,
      body: input.body,
      messageClass: input.messageClass,
      metadata: JSON.parse(metadataJson) as unknown,
      provenance,
    };
    const requestHash = sha256(canonicalJson(request));
    return this.database.transaction(() => {
      const prior = this.findIdempotency(
        provenance.authenticatedPrincipalId,
        "message.send",
        input.idempotencyKey,
      );
      if (prior) {
        if (prior.request_hash !== requestHash) {
          fail("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another request.");
        }
        return this.getMessage(prior.resource_id);
      }
      let recipients: string[];
      if (input.target.type === "agent") {
        this.getAgent(input.target.id);
        recipients = [input.target.id];
      } else {
        this.getChannel(input.target.id);
        const senderMembership = this.database
          .prepare("SELECT 1 AS present FROM channel_members WHERE channel_id = ? AND agent_id = ?")
          .get(input.target.id, input.fromAgentId) as { present: 1 } | undefined;
        if (!senderMembership) {
          fail(
            "UNAUTHORIZED",
            `Agent ${input.fromAgentId} is not a member of channel ${input.target.id}.`,
          );
        }
        recipients = (
          this.database
            .prepare(
              "SELECT agent_id FROM channel_members WHERE channel_id = ? AND agent_id <> ? ORDER BY agent_id",
            )
            .all(input.target.id, input.fromAgentId) as Array<{ agent_id: string }>
        ).map(({ agent_id }) => agent_id);
      }
      const now = this.now();
      const messageId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO messages (
            message_id, idempotency_key, from_agent_id, target_type, target_id,
            correlation_id, body, message_class, metadata_json, provenance_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          input.idempotencyKey,
          input.fromAgentId,
          input.target.type,
          input.target.id,
          input.correlationId,
          input.body,
          input.messageClass,
          metadataJson,
          canonicalJson(provenance),
          now,
        );
      const insertDelivery = this.database.prepare(
        `INSERT INTO deliveries (
          message_id, recipient_agent_id, status, consumer_id, claim_expires_at,
          receipt_id, ack_token_hash, delivered_at
        ) VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL)`,
      );
      for (const recipient of recipients) insertDelivery.run(messageId, recipient);
      this.database
        .prepare(
          `INSERT INTO idempotency_records
            (principal_id, operation, idempotency_key, request_hash, resource_type, resource_id, created_at)
           VALUES (?, 'message.send', ?, ?, 'message', ?, ?)`,
        )
        .run(
          provenance.authenticatedPrincipalId,
          input.idempotencyKey,
          requestHash,
          messageId,
          now,
        );
      this.appendEvent({
        type: "message.sent",
        entityType: "message",
        entityId: messageId,
        actorPrincipalId: provenance.authenticatedPrincipalId,
        correlationId: input.correlationId,
        ...(provenance.sourceOperationId === null
          ? {}
          : { causationId: provenance.sourceOperationId }),
        payload: {
          fromAgentId: input.fromAgentId,
          target: input.target,
          recipientAgentIds: recipients,
          trust: "untrusted",
        },
        occurredAt: now,
      });
      return this.getMessage(messageId);
    })();
  }

  private validateProvenance(provenance: MessageProvenance): MessageProvenance {
    validateIdentifier(provenance.authenticatedPrincipalId, "authenticatedPrincipalId");
    if (provenance.trust !== "untrusted") {
      fail("INVALID_ARGUMENT", "Message provenance trust must be untrusted.");
    }
    if (!["http", "mcp", "t3", "persist", "internal"].includes(provenance.source)) {
      fail("INVALID_ARGUMENT", "Unknown provenance source.");
    }
    if (provenance.sourceInstanceId !== null) {
      validateIdentifier(provenance.sourceInstanceId, "sourceInstanceId");
    }
    if (provenance.sourceOperationId !== null) {
      validateIdentifier(provenance.sourceOperationId, "sourceOperationId");
    }
    return { ...provenance };
  }

  private findIdempotency(
    principal: string,
    operation: string,
    key: string,
  ): IdempotencyRow | undefined {
    return this.database
      .prepare(
        `SELECT request_hash, resource_type, resource_id FROM idempotency_records
         WHERE principal_id = ? AND operation = ? AND idempotency_key = ?`,
      )
      .get(principal, operation, key) as IdempotencyRow | undefined;
  }

  getMessage(messageId: string): MessageRecord {
    const row = this.database
      .prepare("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId) as MessageRow | undefined;
    if (!row) fail("MESSAGE_NOT_FOUND", `Message not found: ${messageId}`);
    const recipients = this.database
      .prepare(
        "SELECT recipient_agent_id FROM deliveries WHERE message_id = ? ORDER BY recipient_agent_id",
      )
      .all(messageId) as Array<{ recipient_agent_id: string }>;
    return {
      messageId: row.message_id,
      idempotencyKey: row.idempotency_key,
      fromAgentId: row.from_agent_id,
      target: { type: row.target_type, id: row.target_id },
      correlationId: row.correlation_id,
      body: row.body,
      messageClass: row.message_class,
      metadata: parseObject(row.metadata_json),
      provenance: JSON.parse(row.provenance_json) as MessageProvenance,
      createdAt: row.created_at,
      recipientAgentIds: recipients.map(({ recipient_agent_id }) => recipient_agent_id),
    };
  }

  listInbox(agentId: string, input?: PageRequest): readonly MessageRecord[] {
    return this.pageInbox(agentId, input).items;
  }

  pageInbox(agentId: string, input: PageRequest = {}): Page<MessageRecord> {
    this.getAgent(agentId);
    this.recoverExpiredClaims(agentId);
    const limit = pageLimit(input);
    const rows = this.database
      .prepare(
        `SELECT m.* FROM messages m
         JOIN deliveries d ON d.message_id = m.message_id
         WHERE d.recipient_agent_id = ? AND d.status = 'pending'
           AND m.rowid > COALESCE((SELECT rowid FROM messages WHERE message_id = ?), 0)
         ORDER BY m.rowid LIMIT ?`,
      )
      .all(agentId, input.after ?? "", limit + 1) as MessageRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.getMessage(row.message_id));
    return { items, next: hasMore ? (items.at(-1)?.messageId ?? null) : null };
  }

  private recoverExpiredClaims(recipientAgentId: string): void {
    const now = this.now();
    this.database.transaction(() => {
      const expired = this.database
        .prepare("SELECT message_id FROM claims WHERE recipient_agent_id = ? AND expires_at <= ?")
        .all(recipientAgentId, now) as Array<{ message_id: string }>;
      for (const { message_id } of expired) {
        this.database
          .prepare(
            `UPDATE deliveries SET status = 'pending', consumer_id = NULL, claim_expires_at = NULL
             WHERE message_id = ? AND recipient_agent_id = ? AND status = 'claimed'`,
          )
          .run(message_id, recipientAgentId);
      }
      this.database
        .prepare("DELETE FROM claims WHERE recipient_agent_id = ? AND expires_at <= ?")
        .run(recipientAgentId, now);
    })();
  }

  claimMessage(input: {
    messageId: string;
    recipientAgentId: string;
    consumerId: string;
    leaseSeconds: number;
    actorPrincipalId?: string;
  }): ClaimRecord {
    validateIdentifier(input.consumerId, "consumerId");
    if (
      !Number.isSafeInteger(input.leaseSeconds) ||
      input.leaseSeconds < 1 ||
      input.leaseSeconds > MAX_LEASE_SECONDS
    ) {
      fail("INVALID_ARGUMENT", `leaseSeconds must be an integer from 1 to ${MAX_LEASE_SECONDS}.`);
    }
    this.recoverExpiredClaims(input.recipientAgentId);
    return this.database.transaction(() => {
      const delivery = this.deliveryRow(input.messageId, input.recipientAgentId);
      if (delivery.status !== "pending") {
        fail("MESSAGE_CLAIM_CONFLICT", `Message ${input.messageId} is not pending.`);
      }
      const now = this.now();
      const expiresAt = new Date(
        new Date(now).getTime() + input.leaseSeconds * 1_000,
      ).toISOString();
      const token = Buffer.from(this.options.tokenBytes(32)).toString("base64url");
      const tokenHash = sha256(token);
      const updated = this.database
        .prepare(
          `UPDATE deliveries SET status = 'claimed', consumer_id = ?, claim_expires_at = ?
           WHERE message_id = ? AND recipient_agent_id = ? AND status = 'pending'`,
        )
        .run(input.consumerId, expiresAt, input.messageId, input.recipientAgentId);
      if (updated.changes !== 1) {
        fail("MESSAGE_CLAIM_CONFLICT", `Message ${input.messageId} was claimed concurrently.`);
      }
      this.database
        .prepare(
          `INSERT INTO claims
            (message_id, recipient_agent_id, consumer_id, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.messageId, input.recipientAgentId, input.consumerId, tokenHash, expiresAt, now);
      this.database
        .prepare("UPDATE presence SET last_seen_at = ?, last_signal = 'claim' WHERE agent_id = ?")
        .run(now, input.recipientAgentId);
      this.appendEvent({
        type: "message.claimed",
        entityType: "message",
        entityId: input.messageId,
        actorPrincipalId: input.actorPrincipalId ?? input.recipientAgentId,
        payload: {
          recipientAgentId: input.recipientAgentId,
          consumerId: input.consumerId,
          expiresAt,
        },
        occurredAt: now,
      });
      const claimedDelivery = deliveryFromRow(
        this.deliveryRow(input.messageId, input.recipientAgentId),
      );
      return {
        ...claimedDelivery,
        status: "claimed" as const,
        consumerId: input.consumerId,
        claimToken: token,
        claimExpiresAt: expiresAt,
      };
    })();
  }

  acknowledgeMessage(input: {
    messageId: string;
    recipientAgentId: string;
    claimToken: string;
    receiptId?: string | undefined;
    actorPrincipalId?: string;
  }): DeliveryRecord {
    return this.database.transaction(() => {
      const delivery = this.deliveryRow(input.messageId, input.recipientAgentId);
      const suppliedHash = sha256(input.claimToken);
      if (delivery.status === "delivered") {
        if (
          delivery.ack_token_hash === null ||
          !safeHashEqual(delivery.ack_token_hash, suppliedHash) ||
          delivery.receipt_id !== (input.receiptId ?? null)
        ) {
          fail(
            "MESSAGE_CLAIM_CONFLICT",
            "Acknowledgement replay does not match the delivered token and receipt.",
          );
        }
        return deliveryFromRow(delivery);
      }
      const claim = this.database
        .prepare("SELECT * FROM claims WHERE message_id = ? AND recipient_agent_id = ?")
        .get(input.messageId, input.recipientAgentId) as ClaimRow | undefined;
      const now = this.now();
      if (
        delivery.status !== "claimed" ||
        !claim ||
        claim.expires_at <= now ||
        !safeHashEqual(claim.token_hash, suppliedHash)
      ) {
        fail("MESSAGE_CLAIM_CONFLICT", "Acknowledgement requires the active exact claim token.");
      }
      this.database
        .prepare(
          `UPDATE deliveries SET status = 'delivered', receipt_id = ?, ack_token_hash = ?,
             delivered_at = ?, claim_expires_at = NULL
           WHERE message_id = ? AND recipient_agent_id = ? AND status = 'claimed'`,
        )
        .run(input.receiptId ?? null, suppliedHash, now, input.messageId, input.recipientAgentId);
      this.database
        .prepare("DELETE FROM claims WHERE message_id = ? AND recipient_agent_id = ?")
        .run(input.messageId, input.recipientAgentId);
      this.database
        .prepare("UPDATE presence SET last_seen_at = ?, last_signal = 'ack' WHERE agent_id = ?")
        .run(now, input.recipientAgentId);
      this.appendEvent({
        type: "message.acknowledged",
        entityType: "message",
        entityId: input.messageId,
        actorPrincipalId: input.actorPrincipalId ?? input.recipientAgentId,
        payload: { recipientAgentId: input.recipientAgentId, receiptId: input.receiptId ?? null },
        occurredAt: now,
      });
      return deliveryFromRow(this.deliveryRow(input.messageId, input.recipientAgentId));
    })();
  }

  releaseMessage(input: {
    messageId: string;
    recipientAgentId: string;
    claimToken: string;
    actorPrincipalId?: string;
  }): DeliveryRecord {
    return this.database.transaction(() => {
      const claim = this.database
        .prepare("SELECT * FROM claims WHERE message_id = ? AND recipient_agent_id = ?")
        .get(input.messageId, input.recipientAgentId) as ClaimRow | undefined;
      const now = this.now();
      if (
        !claim ||
        claim.expires_at <= now ||
        !safeHashEqual(claim.token_hash, sha256(input.claimToken))
      ) {
        fail("MESSAGE_CLAIM_CONFLICT", "Release requires the active exact claim token.");
      }
      this.database
        .prepare(
          `UPDATE deliveries SET status = 'pending', consumer_id = NULL, claim_expires_at = NULL
           WHERE message_id = ? AND recipient_agent_id = ? AND status = 'claimed'`,
        )
        .run(input.messageId, input.recipientAgentId);
      this.database
        .prepare("DELETE FROM claims WHERE message_id = ? AND recipient_agent_id = ?")
        .run(input.messageId, input.recipientAgentId);
      this.appendEvent({
        type: "message.released",
        entityType: "message",
        entityId: input.messageId,
        actorPrincipalId: input.actorPrincipalId ?? input.recipientAgentId,
        payload: { recipientAgentId: input.recipientAgentId },
        occurredAt: now,
      });
      return deliveryFromRow(this.deliveryRow(input.messageId, input.recipientAgentId));
    })();
  }

  private deliveryRow(messageId: string, recipientAgentId: string): DeliveryRow {
    const row = this.database
      .prepare("SELECT * FROM deliveries WHERE message_id = ? AND recipient_agent_id = ?")
      .get(messageId, recipientAgentId) as DeliveryRow | undefined;
    if (!row)
      fail("MESSAGE_NOT_FOUND", `Message delivery not found: ${messageId}/${recipientAgentId}`);
    return row;
  }

  getDelivery(messageId: string, recipientAgentId: string): DeliveryRecord {
    return deliveryFromRow(this.deliveryRow(messageId, recipientAgentId));
  }

  bindAgent(input: BindAgentInput): AgentBinding {
    return this.database.transaction(() => this.bindAgentInTransaction(input))();
  }

  private bindAgentInTransaction(input: BindAgentInput): AgentBinding {
    this.getAgent(input.agentId);
    validateIdentifier(input.adapter, "adapter");
    validateIdentifier(input.hostInstanceId, "hostInstanceId");
    validateIdentifier(input.externalId, "externalId");
    const metadataJson = canonicalJson(input.metadata ?? {});
    const capabilitiesJson = canonicalJson(input.capabilities ?? {});
    const active = input.active ?? true;
    const maxGeneration = this.database
      .prepare(
        "SELECT COALESCE(MAX(generation), 0) AS generation FROM bindings WHERE agent_id = ? AND adapter = ? AND host_instance_id = ?",
      )
      .get(input.agentId, input.adapter, input.hostInstanceId) as { generation: number };
    const generation = input.generation ?? maxGeneration.generation + 1;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      fail("INVALID_ARGUMENT", "generation must be a positive integer.");
    }
    const bindingId = input.bindingId ?? randomUUID();
    const existing = this.database
      .prepare("SELECT * FROM bindings WHERE binding_id = ?")
      .get(bindingId) as BindingRow | undefined;
    if (existing) {
      const same =
        existing.agent_id === input.agentId &&
        existing.adapter === input.adapter &&
        existing.host_instance_id === input.hostInstanceId &&
        existing.external_id === input.externalId &&
        existing.provider_session_id === (input.providerSessionId ?? null) &&
        existing.generation === generation;
      if (!same)
        fail("BINDING_CONFLICT", `Binding ${bindingId} already exists with other identity.`);
      return bindingFromRow(existing);
    }
    if (input.generation !== undefined && generation <= maxGeneration.generation) {
      fail(
        "BINDING_CONFLICT",
        `Binding generation ${generation} is not newer than ${maxGeneration.generation}.`,
      );
    }
    const now = this.now();
    if (active) {
      this.database
        .prepare(
          `UPDATE bindings SET active = 0, updated_at = ?
           WHERE agent_id = ? AND adapter = ? AND host_instance_id = ? AND active = 1`,
        )
        .run(now, input.agentId, input.adapter, input.hostInstanceId);
    }
    this.database
      .prepare(
        `INSERT INTO bindings (
          binding_id, agent_id, adapter, host_instance_id, external_id, provider_session_id,
          generation, state, active, capabilities_json, metadata_json, lease_expires_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bindingId,
        input.agentId,
        input.adapter,
        input.hostInstanceId,
        input.externalId,
        input.providerSessionId ?? null,
        generation,
        input.state,
        active ? 1 : 0,
        capabilitiesJson,
        metadataJson,
        input.leaseExpiresAt ?? null,
        now,
        now,
      );
    this.appendEvent({
      type: "binding.created",
      entityType: "binding",
      entityId: bindingId,
      actorPrincipalId: input.actorPrincipalId,
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      payload: {
        agentId: input.agentId,
        adapter: input.adapter,
        hostInstanceId: input.hostInstanceId,
        externalId: input.externalId,
        generation,
        active,
      },
      occurredAt: now,
    });
    return this.getBinding(bindingId);
  }

  getBinding(bindingId: string): AgentBinding {
    const row = this.database
      .prepare("SELECT * FROM bindings WHERE binding_id = ?")
      .get(bindingId) as BindingRow | undefined;
    if (!row) fail("BINDING_NOT_FOUND", `Binding not found: ${bindingId}`);
    return bindingFromRow(row);
  }

  getControllableBinding(bindingId: string): AgentBinding {
    const row = this.database
      .prepare("SELECT * FROM bindings WHERE binding_id = ?")
      .get(bindingId) as BindingRow | undefined;
    if (!row) fail("BINDING_NOT_FOUND", `Binding not found: ${bindingId}`);
    if (row.lease_expires_at !== null && row.lease_expires_at <= this.now()) {
      fail("BINDING_NOT_FOUND", `Binding lease has expired: ${bindingId}`);
    }
    const newest = this.database
      .prepare(
        `SELECT binding_id, generation FROM bindings
         WHERE agent_id = ? AND adapter = ? AND host_instance_id = ?
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(row.agent_id, row.adapter, row.host_instance_id) as
      | { binding_id: string; generation: number }
      | undefined;
    if (
      row.active !== 1 ||
      newest?.binding_id !== row.binding_id ||
      newest?.generation !== row.generation
    ) {
      fail("BINDING_CONFLICT", `Binding is not the active generation: ${bindingId}`);
    }
    return bindingFromRow(row);
  }

  getActiveBinding(agentId: string, adapter?: string): AgentBinding {
    const rows = (
      adapter
        ? this.database
            .prepare(
              `SELECT * FROM bindings WHERE agent_id = ? AND adapter = ? AND active = 1
             ORDER BY generation DESC`,
            )
            .all(agentId, adapter)
        : this.database
            .prepare(
              `SELECT * FROM bindings WHERE agent_id = ? AND active = 1
             ORDER BY updated_at DESC, generation DESC`,
            )
            .all(agentId)
    ) as BindingRow[];
    const now = this.now();
    const active = rows.filter(
      (row) => row.lease_expires_at === null || row.lease_expires_at > now,
    );
    if (active.length === 0) {
      fail("BINDING_NOT_FOUND", `Active binding not found: ${agentId}`);
    }
    if (active.length > 1) {
      fail("BINDING_CONFLICT", `Agent ${agentId} has multiple matching active bindings.`);
    }
    return bindingFromRow(active[0] as BindingRow);
  }

  listBindings(
    agentId: string,
    input: PageRequest & { readonly includeInactive?: boolean } = {},
  ): Page<AgentBinding> {
    this.getAgent(agentId);
    const limit = pageLimit(input);
    const rows = this.database
      .prepare(
        `SELECT * FROM bindings WHERE agent_id = ? AND binding_id > ?
           AND (? = 1 OR active = 1)
         ORDER BY binding_id LIMIT ?`,
      )
      .all(agentId, input.after ?? "", input.includeInactive ? 1 : 0, limit + 1) as BindingRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(bindingFromRow);
    return { items, next: hasMore ? (items.at(-1)?.bindingId ?? null) : null };
  }

  beginOperation(input: BeginOperationInput): BeginOperationResult {
    validateIdentifier(input.principalId, "principalId");
    validateIdentifier(input.idempotencyKey, "idempotencyKey");
    validateIdentifier(input.adapter, "adapter");
    this.getAgent(input.agentId);
    const requestHash = sha256(canonicalJson(input.request));
    return this.database.transaction(() => {
      const prior = this.findIdempotency(input.principalId, input.kind, input.idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) {
          fail("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another request.");
        }
        return { operation: this.getOperation(prior.resource_id), replay: true };
      }
      const now = this.now();
      const operationId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO operations (
            operation_id, principal_id, idempotency_key, request_hash, kind, adapter,
            agent_id, binding_id, message_id, correlation_id, stage, dispatch_owner_id,
            dispatch_started_at, host_receipt_id, detail_json, error_code, error_message,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, '{}', NULL, NULL, ?, ?)`,
        )
        .run(
          operationId,
          input.principalId,
          input.idempotencyKey,
          requestHash,
          input.kind,
          input.adapter,
          input.agentId,
          input.bindingId ?? null,
          input.messageId ?? null,
          input.correlationId ?? null,
          now,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO idempotency_records
            (principal_id, operation, idempotency_key, request_hash, resource_type, resource_id, created_at)
           VALUES (?, ?, ?, ?, 'operation', ?, ?)`,
        )
        .run(input.principalId, input.kind, input.idempotencyKey, requestHash, operationId, now);
      this.appendEvent({
        type: "operation.queued",
        entityType: "operation",
        entityId: operationId,
        actorPrincipalId: input.principalId,
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        payload: { kind: input.kind, adapter: input.adapter, agentId: input.agentId },
        occurredAt: now,
      });
      return { operation: this.getOperation(operationId), replay: false };
    })();
  }

  findOperationByIdempotency(input: {
    principalId: string;
    idempotencyKey: string;
    kind: OperationRecord["kind"];
    request: unknown;
  }): OperationRecord | null {
    validateIdentifier(input.principalId, "principalId");
    validateIdentifier(input.idempotencyKey, "idempotencyKey");
    const requestHash = sha256(canonicalJson(input.request));
    const prior = this.findIdempotency(input.principalId, input.kind, input.idempotencyKey);
    if (!prior) return null;
    if (prior.resource_type !== "operation" || prior.request_hash !== requestHash) {
      fail("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another request.");
    }
    return this.getOperation(prior.resource_id);
  }

  claimOperationDispatch(input: {
    operationId: string;
    dispatchOwnerId: string;
  }): ClaimOperationDispatchResult {
    validateIdentifier(input.dispatchOwnerId, "dispatchOwnerId");
    return this.database.transaction(() => {
      const current = this.getOperation(input.operationId);
      if (current.stage !== "queued") return { operation: current, acquired: false };
      const now = this.now();
      const claimed = this.database
        .prepare(
          `UPDATE operations SET stage = 'dispatching', dispatch_owner_id = ?,
             dispatch_started_at = ?, updated_at = ?
           WHERE operation_id = ? AND stage = 'queued'`,
        )
        .run(input.dispatchOwnerId, now, now, input.operationId);
      if (claimed.changes !== 1) {
        return { operation: this.getOperation(input.operationId), acquired: false };
      }
      this.appendEvent({
        type: "operation.dispatching",
        entityType: "operation",
        entityId: input.operationId,
        actorPrincipalId: current.principalId,
        ...(current.correlationId === null ? {} : { correlationId: current.correlationId }),
        payload: { dispatchOwnerId: input.dispatchOwnerId },
        occurredAt: now,
      });
      return { operation: this.getOperation(input.operationId), acquired: true };
    })();
  }

  recordOperationReceipt(input: RecordOperationReceiptInput): OperationRecord {
    return this.database.transaction(() => {
      const current = this.getOperation(input.operationId);
      if (
        current.stage === input.receipt.stage &&
        current.hostReceiptId === input.receipt.receiptId
      ) {
        return current;
      }
      if (current.stage === input.receipt.stage) {
        fail(
          "IDEMPOTENCY_CONFLICT",
          `Operation ${input.operationId} already has a different ${current.stage} receipt.`,
        );
      }
      if (["observed", "failed"].includes(current.stage)) {
        const sameReceipt =
          current.stage === input.receipt.stage &&
          current.hostReceiptId === input.receipt.receiptId;
        if (!sameReceipt) {
          fail("IDEMPOTENCY_CONFLICT", `Operation ${input.operationId} is already terminal.`);
        }
        return current;
      }
      if (!this.validOperationTransition(current.stage, input.receipt.stage)) {
        fail(
          "INVALID_ARGUMENT",
          `Invalid operation transition ${current.stage} -> ${input.receipt.stage}.`,
        );
      }
      const detail = input.receipt.detail ?? {};
      const failure = input.receipt.stage === "failed" || input.receipt.stage === "indeterminate";
      const now = this.now();
      this.database
        .prepare(
          `UPDATE operations SET stage = ?, host_receipt_id = ?, detail_json = ?,
             error_code = ?, error_message = ?, updated_at = ? WHERE operation_id = ?`,
        )
        .run(
          input.receipt.stage,
          input.receipt.receiptId,
          canonicalJson(detail),
          failure ? input.receipt.errorCode : null,
          failure ? input.receipt.errorMessage : null,
          now,
          input.operationId,
        );
      const binding = input.binding ? this.bindAgentInTransaction(input.binding) : null;
      if (binding) {
        this.database
          .prepare("UPDATE operations SET binding_id = ? WHERE operation_id = ?")
          .run(binding.bindingId, input.operationId);
      }
      this.appendEvent({
        type: "operation.updated",
        entityType: "operation",
        entityId: input.operationId,
        actorPrincipalId: current.principalId,
        ...(current.correlationId === null ? {} : { correlationId: current.correlationId }),
        ...(input.receipt.receiptId === null ? {} : { causationId: input.receipt.receiptId }),
        payload: { stage: input.receipt.stage, receiptId: input.receipt.receiptId },
        occurredAt: now,
      });
      return this.getOperation(input.operationId);
    })();
  }

  private validOperationTransition(
    from: OperationRecord["stage"],
    to: HostOperationReceipt["stage"],
  ): boolean {
    if (from === "queued") return false;
    if (from === "dispatching" || from === "indeterminate") return true;
    if (from === "accepted")
      return ["accepted", "adopted", "observed", "failed", "indeterminate"].includes(to);
    if (from === "adopted") return ["adopted", "observed", "failed", "indeterminate"].includes(to);
    return from === to;
  }

  getOperation(operationId: string): OperationRecord {
    const row = this.database
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .get(operationId) as OperationRow | undefined;
    if (!row) fail("OPERATION_NOT_FOUND", `Operation not found: ${operationId}`);
    return operationFromRow(row);
  }

  listEvents(input: { afterSequence: number; limit: number }): readonly SidebandEvent[] {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      fail("INVALID_ARGUMENT", "afterSequence must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
      fail("INVALID_ARGUMENT", `limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
    }
    const rows = this.database
      .prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?")
      .all(input.afterSequence, input.limit) as EventRow[];
    return rows.map((row) => ({
      schemaVersion: 1,
      sequence: row.sequence,
      eventId: row.event_id,
      type: row.type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      actorPrincipalId: row.actor_principal_id,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      payload: parseObject(row.payload_json),
      occurredAt: row.occurred_at,
    }));
  }

  getEventHead(): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS head FROM events")
      .get() as {
      head: number;
    };
    return row.head;
  }

  close(): void {
    this.database.close();
  }
}
