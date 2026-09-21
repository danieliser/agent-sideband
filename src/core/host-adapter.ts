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

export interface HostInspection {
  readonly state: BindingState;
  readonly providerSessionId?: string;
  readonly generation?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface HostAdapter {
  readonly name: string;
  capabilities(): Promise<HostAdapterCapabilities>;
  spawn(request: HostSpawnRequest): Promise<HostSpawnReceipt>;
  bind(request: HostBindRequest): Promise<HostBindingProof>;
  send(request: HostSendRequest): Promise<HostOperationReceipt>;
  interrupt(request: HostControlRequest): Promise<HostOperationReceipt>;
  stop(request: HostControlRequest): Promise<HostOperationReceipt>;
  inspect(binding: AgentBinding): Promise<HostInspection>;
}

/** @deprecated Use HostSendRequest. */
export type HostDeliveryRequest = HostSendRequest;
/** @deprecated Use HostOperationReceipt. */
export type HostReceipt = HostOperationReceipt;
export type { HostOperationStage };
