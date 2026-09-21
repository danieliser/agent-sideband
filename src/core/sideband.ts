import { randomUUID } from "node:crypto";

import { SidebandError } from "./errors.js";
import type {
  HostAdapter,
  HostAdapterCapabilities,
  HostBindingProof,
  HostOperationReceipt,
  HostSpawnReceipt,
} from "./host-adapter.js";
import type { AgentBinding, MessageRecord, OperationRecord } from "./types.js";
import type { SidebandStore } from "../store/store.js";

export interface AgentSidebandOptions {
  readonly store: SidebandStore;
  readonly adapters: readonly HostAdapter[];
}

export interface HostOperationResult {
  readonly operation: OperationRecord;
  readonly binding: AgentBinding | null;
}

export interface SpawnAgentInput {
  readonly principalId?: string;
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly adapter: string;
  readonly parentAgentId: string | null;
  readonly prompt: string;
  readonly provider: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface BindAgentInput {
  readonly principalId?: string;
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly adapter: string;
  readonly externalId: string;
  readonly hostInstanceId: string;
  readonly providerSessionId?: string;
  readonly generation?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SendMessageToHostInput {
  readonly principalId?: string;
  readonly idempotencyKey: string;
  readonly bindingId: string;
  readonly messageId: string;
  readonly mode: "wake" | "context" | "both";
}

export class AgentSideband {
  private readonly adapters = new Map<string, HostAdapter>();

  constructor(private readonly options: AgentSidebandOptions) {
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.name)) {
        throw new SidebandError("ADAPTER_NOT_FOUND", `Duplicate host adapter: ${adapter.name}`);
      }
      this.adapters.set(adapter.name, adapter);
    }
  }

  private adapter(name: string): HostAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new SidebandError("ADAPTER_NOT_FOUND", `Host adapter not found: ${name}`);
    return adapter;
  }

  private async requireCapability(
    adapter: HostAdapter,
    capability: keyof HostAdapterCapabilities,
  ): Promise<HostAdapterCapabilities> {
    const capabilities = await adapter.capabilities();
    if (!capabilities[capability]) {
      throw new SidebandError(
        "ADAPTER_CAPABILITY_UNAVAILABLE",
        `Adapter ${adapter.name} does not support ${capability}.`,
      );
    }
    return capabilities;
  }

  private indeterminate(): Extract<
    HostOperationReceipt,
    { readonly stage: "failed" | "indeterminate" }
  > {
    return {
      stage: "indeterminate",
      receiptId: null,
      errorCode: "HOST_ADAPTER_ERROR",
      errorMessage: "Host adapter threw without a structured receipt.",
    };
  }

  async spawnAgent(input: SpawnAgentInput): Promise<HostOperationResult> {
    const principalId = input.principalId ?? "local-owner";
    try {
      this.options.store.getAgent(input.agentId);
    } catch (error) {
      if (!(error instanceof SidebandError) || error.code !== "AGENT_NOT_FOUND") throw error;
      this.options.store.registerAgent({ agentId: input.agentId, actorPrincipalId: principalId });
    }
    const request = {
      agentId: input.agentId,
      adapter: input.adapter,
      parentAgentId: input.parentAgentId,
      prompt: input.prompt,
      provider: input.provider,
      metadata: input.metadata,
    };
    const begun = this.options.store.beginOperation({
      principalId,
      idempotencyKey: input.idempotencyKey,
      kind: "spawn",
      adapter: input.adapter,
      agentId: input.agentId,
      request,
    });
    if (begun.operation.stage !== "queued") {
      return {
        operation: begun.operation,
        binding: this.bindingForCompletedOperation(begun.operation),
      };
    }
    const adapter = this.adapter(input.adapter);
    const capabilities = await this.requireCapability(adapter, "spawn");
    const dispatch = this.options.store.claimOperationDispatch({
      operationId: begun.operation.operationId,
      dispatchOwnerId: randomUUID(),
    });
    if (!dispatch.acquired) {
      return {
        operation: dispatch.operation,
        binding: this.bindingForCompletedOperation(dispatch.operation),
      };
    }
    let receipt: HostSpawnReceipt;
    try {
      receipt = await adapter.spawn({
        ...request,
        idempotencyKey: input.idempotencyKey,
        operationId: dispatch.operation.operationId,
      });
    } catch {
      receipt = this.indeterminate();
    }
    const bindingInput =
      receipt.stage === "accepted" || receipt.stage === "adopted" || receipt.stage === "observed"
        ? {
            agentId: input.agentId,
            adapter: input.adapter,
            hostInstanceId: receipt.hostInstanceId,
            externalId: receipt.externalId,
            ...(receipt.providerSessionId === undefined
              ? {}
              : { providerSessionId: receipt.providerSessionId }),
            ...(receipt.generation === undefined ? {} : { generation: receipt.generation }),
            state: receipt.state ?? "starting",
            active: true,
            capabilities: { ...capabilities },
            metadata: input.metadata,
            actorPrincipalId: principalId,
            causationId: dispatch.operation.operationId,
          }
        : undefined;
    const operation = this.options.store.recordOperationReceipt({
      operationId: dispatch.operation.operationId,
      receipt,
      ...(bindingInput === undefined ? {} : { binding: bindingInput }),
    });
    return { operation, binding: this.bindingForCompletedOperation(operation) };
  }

  async bindAgent(input: BindAgentInput): Promise<HostOperationResult> {
    const principalId = input.principalId ?? "local-owner";
    this.options.store.getAgent(input.agentId);
    const request = {
      agentId: input.agentId,
      adapter: input.adapter,
      externalId: input.externalId,
      hostInstanceId: input.hostInstanceId,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      metadata: input.metadata,
    };
    const begun = this.options.store.beginOperation({
      principalId,
      idempotencyKey: input.idempotencyKey,
      kind: "bind",
      adapter: input.adapter,
      agentId: input.agentId,
      request,
    });
    if (begun.operation.stage !== "queued") {
      return {
        operation: begun.operation,
        binding: this.bindingForCompletedOperation(begun.operation),
      };
    }
    const adapter = this.adapter(input.adapter);
    const capabilities = await this.requireCapability(adapter, "bind");
    const dispatch = this.options.store.claimOperationDispatch({
      operationId: begun.operation.operationId,
      dispatchOwnerId: randomUUID(),
    });
    if (!dispatch.acquired) {
      return {
        operation: dispatch.operation,
        binding: this.bindingForCompletedOperation(dispatch.operation),
      };
    }
    let receipt: HostBindingProof;
    try {
      receipt = await adapter.bind({
        ...request,
        idempotencyKey: input.idempotencyKey,
        operationId: dispatch.operation.operationId,
      });
    } catch {
      receipt = this.indeterminate();
    }
    const bindingInput =
      receipt.stage === "accepted" || receipt.stage === "adopted" || receipt.stage === "observed"
        ? {
            agentId: input.agentId,
            adapter: input.adapter,
            hostInstanceId: receipt.hostInstanceId,
            externalId: receipt.externalId,
            ...(receipt.providerSessionId === undefined
              ? {}
              : { providerSessionId: receipt.providerSessionId }),
            ...(receipt.generation === undefined ? {} : { generation: receipt.generation }),
            state: receipt.state ?? "unknown",
            active: true,
            capabilities: { ...capabilities },
            metadata: input.metadata,
            actorPrincipalId: principalId,
            causationId: dispatch.operation.operationId,
          }
        : undefined;
    const operation = this.options.store.recordOperationReceipt({
      operationId: dispatch.operation.operationId,
      receipt,
      ...(bindingInput === undefined ? {} : { binding: bindingInput }),
    });
    return { operation, binding: this.bindingForCompletedOperation(operation) };
  }

  async sendMessageToHost(input: SendMessageToHostInput): Promise<HostOperationResult> {
    const principalId = input.principalId ?? "local-owner";
    const binding = this.options.store.getBinding(input.bindingId);
    const message = this.options.store.getMessage(input.messageId);
    const request = {
      bindingId: binding.bindingId,
      messageId: message.messageId,
      mode: input.mode,
    };
    const begun = this.options.store.beginOperation({
      principalId,
      idempotencyKey: input.idempotencyKey,
      kind: "send",
      adapter: binding.adapter,
      agentId: binding.agentId,
      bindingId: binding.bindingId,
      messageId: message.messageId,
      correlationId: message.correlationId,
      request,
    });
    if (begun.operation.stage !== "queued") {
      return { operation: begun.operation, binding };
    }
    const controllableBinding = this.options.store.getControllableBinding(input.bindingId);
    const adapter = this.adapter(controllableBinding.adapter);
    const capabilities = await adapter.capabilities();
    if ((input.mode === "wake" || input.mode === "both") && !capabilities.wake) {
      throw new SidebandError("ADAPTER_CAPABILITY_UNAVAILABLE", "Adapter cannot wake an agent.");
    }
    if ((input.mode === "context" || input.mode === "both") && !capabilities.context) {
      throw new SidebandError("ADAPTER_CAPABILITY_UNAVAILABLE", "Adapter cannot inject context.");
    }
    if (!message.recipientAgentIds.includes(controllableBinding.agentId)) {
      throw new SidebandError("UNAUTHORIZED", "Binding does not belong to a message recipient.");
    }
    const dispatch = this.options.store.claimOperationDispatch({
      operationId: begun.operation.operationId,
      dispatchOwnerId: randomUUID(),
    });
    if (!dispatch.acquired) {
      return { operation: dispatch.operation, binding };
    }
    let receipt: HostOperationReceipt;
    try {
      receipt = await adapter.send({
        idempotencyKey: input.idempotencyKey,
        operationId: dispatch.operation.operationId,
        binding: controllableBinding,
        messageId: message.messageId,
        fromAgentId: message.fromAgentId,
        correlationId: message.correlationId,
        body: message.body,
        messageClass: message.messageClass,
        metadata: message.metadata,
        mode: input.mode,
      });
    } catch {
      receipt = this.indeterminate();
    }
    const completedOperation = this.options.store.recordOperationReceipt({
      operationId: dispatch.operation.operationId,
      receipt,
    });
    return { operation: completedOperation, binding };
  }

  /** Compatibility helper: notifies a host without claiming or acknowledging the mailbox row. */
  async dispatchNext(input: {
    readonly principalId?: string;
    readonly recipientAgentId: string;
    readonly consumerId: string;
    readonly mode: "wake" | "context" | "both";
    readonly leaseSeconds?: number;
  }): Promise<{
    readonly message: MessageRecord;
    readonly operation: OperationRecord;
    readonly binding: AgentBinding;
  } | null> {
    const message = this.options.store.listInbox(input.recipientAgentId, { limit: 1 })[0];
    if (!message) return null;
    const binding = this.options.store.getActiveBinding(input.recipientAgentId);
    const result = await this.sendMessageToHost({
      principalId: input.principalId ?? input.consumerId,
      idempotencyKey: `notify:${message.messageId}:${binding.bindingId}:${input.mode}`,
      bindingId: binding.bindingId,
      messageId: message.messageId,
      mode: input.mode,
    });
    return { message, operation: result.operation, binding };
  }

  async reconcileOperation(input: {
    readonly operationId: string;
    readonly receipt: HostOperationReceipt;
  }): Promise<OperationRecord> {
    return this.options.store.recordOperationReceipt(input);
  }

  /** @deprecated Use reconcileOperation with an operation ID. */
  async reconcileDelivery(input: {
    readonly messageId: string;
    readonly recipientAgentId: string;
    readonly receiptId: string;
    readonly stage: "queued" | "accepted" | "adopted" | "observed" | "failed" | "indeterminate";
  }): Promise<never> {
    void input;
    throw new SidebandError(
      "INVALID_ARGUMENT",
      "Host receipts reconcile by operationId and do not mutate mailbox delivery.",
    );
  }

  async interruptAgent(input: {
    readonly principalId?: string;
    readonly agentId: string;
    readonly idempotencyKey: string;
  }): Promise<HostOperationResult> {
    return this.control("interrupt", input);
  }

  async stopAgent(input: {
    readonly principalId?: string;
    readonly agentId: string;
    readonly idempotencyKey: string;
  }): Promise<HostOperationResult> {
    return this.control("stop", input);
  }

  private async control(
    kind: "interrupt" | "stop",
    input: {
      readonly principalId?: string;
      readonly agentId: string;
      readonly idempotencyKey: string;
    },
  ): Promise<HostOperationResult> {
    const principalId = input.principalId ?? "local-owner";
    const request = { agentId: input.agentId, kind };
    const replay = this.options.store.findOperationByIdempotency({
      principalId,
      idempotencyKey: input.idempotencyKey,
      kind,
      request,
    });
    if (replay && replay.stage !== "queued") {
      return { operation: replay, binding: this.bindingForCompletedOperation(replay) };
    }
    const routedBinding = replay
      ? this.bindingForCompletedOperation(replay)
      : this.options.store.getActiveBinding(input.agentId);
    if (!routedBinding) {
      throw new SidebandError(
        "BINDING_NOT_FOUND",
        `Operation has no binding route: ${replay?.operationId}`,
      );
    }
    const operation = replay
      ? replay
      : this.options.store.beginOperation({
          principalId,
          idempotencyKey: input.idempotencyKey,
          kind,
          adapter: routedBinding.adapter,
          agentId: input.agentId,
          bindingId: routedBinding.bindingId,
          request,
        }).operation;
    if (operation.stage !== "queued") {
      return { operation, binding: this.bindingForCompletedOperation(operation) };
    }
    const binding = this.options.store.getControllableBinding(routedBinding.bindingId);
    const adapter = this.adapter(binding.adapter);
    await this.requireCapability(adapter, kind);
    const dispatch = this.options.store.claimOperationDispatch({
      operationId: operation.operationId,
      dispatchOwnerId: randomUUID(),
    });
    if (!dispatch.acquired) {
      return { operation: dispatch.operation, binding };
    }
    let receipt: HostOperationReceipt;
    try {
      receipt = await adapter[kind]({
        idempotencyKey: input.idempotencyKey,
        operationId: dispatch.operation.operationId,
        binding,
      });
    } catch {
      receipt = this.indeterminate();
    }
    const completedOperation = this.options.store.recordOperationReceipt({
      operationId: dispatch.operation.operationId,
      receipt,
    });
    return { operation: completedOperation, binding };
  }

  private bindingForCompletedOperation(operation: OperationRecord): AgentBinding | null {
    if (operation.bindingId === null) return null;
    try {
      return this.options.store.getBinding(operation.bindingId);
    } catch (error) {
      if (error instanceof SidebandError && error.code === "BINDING_NOT_FOUND") return null;
      throw error;
    }
  }
}
