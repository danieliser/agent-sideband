import type { HostOperationReceipt } from "../core/host-adapter.js";
import type {
  AgentBinding,
  AgentRecord,
  ChannelRecord,
  ClaimRecord,
  DeliveryRecord,
  DeliveryStage,
  HostOperationKind,
  MessageClass,
  MessageProvenance,
  MessageRecord,
  MessageTarget,
  OperationRecord,
  Page,
  PageRequest,
  PresenceRecord,
  SidebandEvent,
  TeamMember,
  TeamRecord,
} from "../core/types.js";

export interface SendMessageInput {
  readonly idempotencyKey: string;
  readonly fromAgentId: string;
  readonly target: MessageTarget;
  readonly correlationId: string;
  readonly body: string;
  readonly messageClass: MessageClass;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly provenance: MessageProvenance;
}

export interface BindAgentInput {
  readonly bindingId?: string;
  readonly agentId: string;
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
  readonly providerSessionId?: string;
  readonly generation?: number;
  readonly state: AgentBinding["state"];
  readonly active?: boolean;
  readonly capabilities?: Readonly<Record<string, boolean>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly leaseExpiresAt?: string;
  readonly actorPrincipalId: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface BeginOperationInput {
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly kind: HostOperationKind;
  readonly adapter: string;
  readonly agentId: string;
  readonly bindingId?: string;
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly request: unknown;
}

export interface BeginOperationResult {
  readonly operation: OperationRecord;
  readonly replay: boolean;
}

export interface ClaimOperationDispatchResult {
  readonly operation: OperationRecord;
  readonly acquired: boolean;
}

export interface RecordOperationReceiptInput {
  readonly operationId: string;
  readonly receipt: HostOperationReceipt;
  readonly binding?: BindAgentInput;
}

export interface SidebandStore {
  registerAgent(input: {
    agentId: string;
    displayName?: string | undefined;
    actorPrincipalId?: string;
  }): AgentRecord;
  getAgent(agentId: string): AgentRecord;
  listAgents(input?: PageRequest): readonly AgentRecord[];
  pageAgents(input?: PageRequest): Page<AgentRecord>;
  getPresence(agentId: string): PresenceRecord;
  touchPresence(input: {
    agentId: string;
    signal: string;
    actorPrincipalId?: string;
  }): PresenceRecord;

  createTeam(input: {
    teamId: string;
    displayName?: string | undefined;
    actorPrincipalId?: string;
  }): TeamRecord;
  addTeamMember(input: {
    teamId: string;
    agentId: string;
    role: string;
    parentAgentId?: string | undefined;
    actorPrincipalId?: string;
  }): TeamMember;
  getTeam(teamId: string): TeamRecord;

  createChannel(input: {
    channelId: string;
    displayName?: string | undefined;
    teamId?: string | undefined;
    leadAgentId?: string | undefined;
    actorPrincipalId?: string;
  }): ChannelRecord;
  addChannelMember(input: {
    channelId: string;
    agentId: string;
    actorPrincipalId?: string;
  }): ChannelRecord;
  getChannel(channelId: string): ChannelRecord;

  sendMessage(input: SendMessageInput): MessageRecord;
  getMessage(messageId: string): MessageRecord;
  listInbox(agentId: string, input?: PageRequest): readonly MessageRecord[];
  pageInbox(agentId: string, input?: PageRequest): Page<MessageRecord>;
  claimMessage(input: {
    messageId: string;
    recipientAgentId: string;
    consumerId: string;
    leaseSeconds: number;
    actorPrincipalId?: string;
  }): ClaimRecord;
  acknowledgeMessage(input: {
    messageId: string;
    recipientAgentId: string;
    claimToken: string;
    receiptId?: string | undefined;
    actorPrincipalId?: string;
    /** @deprecated Ignored. Host-operation progress is separate. */
    stage?: DeliveryStage;
  }): DeliveryRecord;
  releaseMessage(input: {
    messageId: string;
    recipientAgentId: string;
    claimToken: string;
    actorPrincipalId?: string;
  }): DeliveryRecord;
  getDelivery(messageId: string, recipientAgentId: string): DeliveryRecord;

  bindAgent(input: BindAgentInput): AgentBinding;
  getBinding(bindingId: string): AgentBinding;
  getControllableBinding(bindingId: string): AgentBinding;
  getActiveBinding(agentId: string, adapter?: string): AgentBinding;
  listBindings(
    agentId: string,
    input?: PageRequest & { readonly includeInactive?: boolean },
  ): Page<AgentBinding>;

  beginOperation(input: BeginOperationInput): BeginOperationResult;
  findOperationByIdempotency(input: {
    principalId: string;
    idempotencyKey: string;
    kind: HostOperationKind;
    request: unknown;
  }): OperationRecord | null;
  claimOperationDispatch(input: {
    operationId: string;
    dispatchOwnerId: string;
  }): ClaimOperationDispatchResult;
  recordOperationReceipt(input: RecordOperationReceiptInput): OperationRecord;
  getOperation(operationId: string): OperationRecord;

  listEvents(input: { afterSequence: number; limit: number }): readonly SidebandEvent[];
  getEventHead(): number;
  close(): void;
}
