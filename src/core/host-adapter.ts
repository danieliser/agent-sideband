import type {
  AgentBinding,
  AgentId,
  BindingState,
  HostOperationStage,
  MessageClass,
  MessageId,
} from "./types.js";

export interface HostAdapterCapabilities {
  readonly spawn: boolean;
  readonly bind: boolean;
  readonly wake: boolean;
  readonly context: boolean;
  readonly interrupt: boolean;
  readonly stop: boolean;
  readonly adoptionReceipts: boolean;
}

export type HostOperationReceipt =
  | {
      readonly stage: "accepted" | "adopted" | "observed";
      readonly receiptId: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly stage: "failed" | "indeterminate";
      readonly receiptId: string | null;
      readonly errorCode: string;
      readonly errorMessage: string;
      /**
       * Set on a failed receipt only when the host definitely did not act and the same intent
       * may be retried later as a new operation (for example, the host was unreachable).
       */
      readonly retryable?: boolean;
      readonly detail?: Readonly<Record<string, unknown>>;
    };

export interface HostSpawnRequest {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly parentAgentId: AgentId | null;
  readonly prompt: string;
  readonly provider: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Present only for managed spawns. The host tuple Sideband reserved before this call; the
   * adapter must create exactly this thread and report exactly this tuple.
   */
  readonly plan?: HostSpawnPlan;
}

/** What an adapter needs to choose the host tuple of a managed spawn. */
export interface HostSpawnPlanRequest {
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly provider: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** The host tuple a managed spawn will create. Chosen by the adapter, never by the caller. */
export interface HostSpawnPlan {
  readonly hostInstanceId: string;
  readonly externalId: string;
}

type SuccessfulHostReceipt = Extract<
  HostOperationReceipt,
  { readonly stage: "accepted" | "adopted" | "observed" }
>;

export type HostSpawnReceipt =
  | (SuccessfulHostReceipt & {
      readonly externalId: string;
      readonly hostInstanceId: string;
      readonly providerSessionId?: string;
      readonly generation?: number;
      readonly state?: BindingState;
    })
  | Exclude<HostOperationReceipt, SuccessfulHostReceipt>;

export interface HostBindRequest {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly externalId: string;
  readonly hostInstanceId: string;
  readonly providerSessionId?: string;
  readonly generation?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type HostBindingProof =
  | (SuccessfulHostReceipt & {
      readonly externalId: string;
      readonly hostInstanceId: string;
      readonly providerSessionId?: string;
      readonly generation?: number;
      readonly state?: BindingState;
    })
  | Exclude<HostOperationReceipt, SuccessfulHostReceipt>;

export interface HostSendRequest {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly binding: AgentBinding;
  readonly messageId: MessageId;
  readonly fromAgentId: AgentId;
  readonly correlationId: string;
  readonly body: string;
  readonly messageClass: MessageClass;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly mode: "wake" | "context" | "both";
}

export interface HostControlRequest {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly binding: AgentBinding;
}

export interface HostContextInjectionRequest {
  readonly idempotencyKey: string;
  readonly binding: AgentBinding;
  readonly messageId: MessageId;
  readonly body: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type HostDeliveryLeg = "wake" | "context";

export interface HostPrepareRequest extends Omit<HostSendRequest, "mode"> {
  readonly leg: HostDeliveryLeg;
}

/**
 * The exact host request for one delivery leg. It is persisted before any host I/O and resent
 * byte-for-byte on replay, so it must not depend on the clock or host state at execution time.
 */
export interface HostPreparedRequest {
  readonly protocolVersion: 1;
  readonly leg: HostDeliveryLeg;
  /** Exact host JSON. Never contains host credentials. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The host deduplicates this exact payload, so resending after an unknown outcome is safe. */
  readonly replaySafe: boolean;
}

/** prepare performed no host mutation, so this failure is always a definitive no-effect. */
export type HostPrepareFailure = Extract<
  HostOperationReceipt,
  { readonly stage: "failed" | "indeterminate" }
> & {
  readonly stage: "failed";
};

export interface HostExecuteRequest {
  readonly operationId: string;
  readonly binding: AgentBinding;
  readonly prepared: HostPreparedRequest;
}

export interface HostInspection {
  readonly state: BindingState;
  readonly providerSessionId?: string;
  readonly generation?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * A host-issued credential for one live binding generation. The daemon keeps it in memory only;
 * adapters resolve it immediately before each use and never persist, log or return it.
 */
export interface HostDeliveryCredential {
  readonly token: string;
  readonly providerSessionId: string;
  readonly generation: number;
  readonly expiresAt: string;
  /** Drops exactly this credential after the host rejected it. */
  discard(): void;
}

/** Returns the current credential for this exact binding, or null when none is usable. */
export type HostDeliveryCredentialResolver = (
  binding: AgentBinding,
) => HostDeliveryCredential | null;

export interface HostAdapter {
  readonly name: string;
  /** Adapter-wide support metadata. Work is accepted or refused against this. */
  capabilities(): Promise<HostAdapterCapabilities>;
  /**
   * Optional per-target readiness for one binding right now (for example, whether a host-pushed
   * context credential is held). Never performs host I/O and never gates acceptance: temporary
   * readiness is enforced at prepare/dispatch, with no fallback to another delivery mode.
   */
  capabilitiesForBinding?(binding: AgentBinding): Promise<HostAdapterCapabilities>;
  /**
   * Optional. Opts the adapter into managed spawn identity: Sideband asks for the tuple the spawn
   * will create, reserves it as a durable intent before any host mutation, and passes it back as
   * `plan`. Must be deterministic for an operation id, must not mutate the host, and may only read
   * trusted host state (for example the environment id). The tuple must not depend on caller input.
   */
  planSpawn?(request: HostSpawnPlanRequest): Promise<HostSpawnPlan>;
  /**
   * Spawn metadata keys that would let a caller choose or collide with the host tuple (for
   * example an existing thread id). Managed spawns refuse requests that set any of them.
   */
  readonly reservedSpawnMetadata?: readonly string[];
  spawn(request: HostSpawnRequest): Promise<HostSpawnReceipt>;
  bind(request: HostBindRequest): Promise<HostBindingProof>;
  send(request: HostSendRequest): Promise<HostOperationReceipt>;
  interrupt(request: HostControlRequest): Promise<HostOperationReceipt>;
  stop(request: HostControlRequest): Promise<HostOperationReceipt>;
  inspect(binding: AgentBinding): Promise<HostInspection>;
  /** Present only on adapters whose capabilities().context is true. */
  injectContext?(request: HostContextInjectionRequest): Promise<HostOperationReceipt>;
  /**
   * Optional two-step delivery. prepare builds the exact request without side effects; Sideband
   * persists it, then execute performs the host I/O. Adapters with both are used instead of
   * send/injectContext and become eligible for explicit replay of replay-safe requests.
   */
  prepare?(request: HostPrepareRequest): Promise<HostPreparedRequest | HostPrepareFailure>;
  execute?(request: HostExecuteRequest): Promise<HostOperationReceipt>;
}

/** @deprecated Use HostSendRequest. */
export type HostDeliveryRequest = HostSendRequest;
/** @deprecated Use HostOperationReceipt. */
export type HostReceipt = HostOperationReceipt;
export type { HostOperationStage };
