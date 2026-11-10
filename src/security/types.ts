import type { AgentBinding } from "../core/types.js";

/** Narrow tool grants carried by an agent credential. None confers management authority. */
export type AgentGrant =
  | "identity:read"
  | "inbox:read"
  | "inbox:ack"
  | "messages:send"
  | "presence:write"
  | "schedules:create"
  | "schedules:read"
  | "schedules:cancel"
  | "agents:spawn";

export const DEFAULT_AGENT_GRANTS: readonly AgentGrant[] = [
  "identity:read",
  "inbox:read",
  "inbox:ack",
  "messages:send",
  "presence:write",
  "schedules:create",
  "schedules:read",
  "schedules:cancel",
];

/**
 * Grants an operator may opt a daemon into. Never part of the defaults: a provisioned agent
 * gains lifecycle authority only when the service is explicitly configured with it.
 */
export const OPTIONAL_AGENT_GRANTS: readonly AgentGrant[] = ["agents:spawn"];

/** Operator authority. Only trusted server code may construct one; never expose it to a model. */
export interface OperatorPrincipal {
  readonly kind: "operator";
  readonly principalId: string;
}

/** Credential holder trusted for exactly one adapter host instance. */
export interface HostConnectorPrincipal {
  readonly kind: "connector";
  readonly connectorId: string;
  readonly principalId: string;
  readonly adapter: string;
  readonly hostInstanceId: string;
}

/** Connector-only; never a model-facing argument. */
export interface HostSessionRegistration {
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
  readonly providerSessionId: string;
  /** Changes every host process boot. */
  readonly hostEpoch: string;
  readonly leaseSeconds: number;
  readonly displayName?: string;
  /** Allowed only when the connector's alias policy lists it. */
  readonly requestedAgentId?: string;
  /** Verified spawn provenance: the parent must hold a live session on the same host. */
  readonly parentAgentId?: string;
}

/** The only response that carries a raw token. It is never retrievable afterward. */
export interface IssuedAgentAccess {
  readonly principalId: string;
  readonly agentId: string;
  readonly hostSessionId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly credentialId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly leaseExpiresAt: string;
}

export interface IssuedConnectorCredential {
  readonly connectorId: string;
  readonly principalId: string;
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly token: string;
  readonly expiresAt: string | null;
}

/** What a resolved agent bearer authenticates. Stamped by the server, never by a payload. */
export interface AuthenticatedAgent {
  readonly kind: "agent";
  readonly principalId: string;
  readonly agentId: string;
  readonly credentialId: string;
  readonly hostSessionId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
  readonly grants: ReadonlySet<AgentGrant>;
  readonly accessEpoch: number;
  readonly expiresAt: string;
  readonly leaseExpiresAt: string;
}

export interface HostSessionRecord {
  readonly hostSessionId: string;
  readonly connectorId: string;
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
  readonly agentId: string;
  readonly principalId: string;
  readonly parentAgentId: string | null;
  readonly providerSessionId: string;
  readonly hostEpoch: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly status: "active" | "offline";
  readonly leaseExpiresAt: string;
  readonly online: boolean;
}

export type ScheduleAction = "create" | "cancel" | "read";

export type ScheduleAuthorization =
  | {
      readonly allowed: true;
      readonly action: ScheduleAction;
      readonly ownerPrincipalId: string;
      readonly ownerAgentId: string | null;
      readonly targetAgentId: string;
      /** Null for operator-owned schedules, which carry no per-target grant. */
      readonly grantId: string | null;
      readonly grantEpoch: number;
    }
  | {
      readonly allowed: false;
      readonly action: ScheduleAction;
      readonly reason: string;
    };

export type ScheduleDeliveryReason =
  | "ok"
  | "owner_unknown"
  | "owner_retired"
  | "owner_access_revoked"
  | "target_unknown"
  | "target_retired"
  | "target_access_revoked"
  | "grant_missing"
  | "grant_revoked"
  | "grant_epoch_changed"
  | "binding_invalid"
  | "target_offline";

export interface ScheduleDeliveryDecision {
  readonly allowed: boolean;
  readonly reason: ScheduleDeliveryReason;
  /** True when authority may return without operator action (e.g. the target is offline). */
  readonly retryable: boolean;
}

export type BindingReference = Pick<AgentBinding, "bindingId" | "agentId" | "generation">;

/** The grant identity a schedule recorded at acceptance, re-checked at dispatch. */
export interface PinnedScheduleAuthorization {
  readonly grantId: string | null;
  readonly grantEpoch: number;
}
