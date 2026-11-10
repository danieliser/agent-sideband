import { randomUUID } from "node:crypto";

import { SidebandError } from "./errors.js";
import type {
  HostAdapter,
  HostAdapterCapabilities,
  HostBindingProof,
  HostDeliveryLeg,
  HostOperationReceipt,
  HostPreparedRequest,
  HostPrepareFailure,
  HostSendRequest,
  HostSpawnPlan,
  HostSpawnReceipt,
} from "./host-adapter.js";
import type { SpawnIdentityCoordinator } from "./spawn-identity.js";
import type { AgentBinding, MessageRecord, OperationRecord } from "./types.js";
import { RAW_BIND_REFUSED } from "../store/sqlite.js";
import type { RecordOperationReceiptInput, SidebandStore } from "../store/store.js";

export interface AgentSidebandOptions {
  readonly store: SidebandStore;
  readonly adapters: readonly HostAdapter[];
  /**
   * Opts spawns on adapters that implement planSpawn into managed identity: the host tuple is
   * reserved as an authorized intent before any host I/O. Without it every spawn is unmanaged.
   */
  readonly spawnIdentity?: SpawnIdentityCoordinator;
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
  /**
   * Managed spawns only: the trusted spawner handle (an operator principal or a verified agent
   * credential) that trusted server code obtained from authentication. Never request input.
   * Provenance and authority derive from it; `principalId` and `parentAgentId` are only checked
   * against it.
   */
  readonly spawner?: unknown;
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
  /**
   * Explicitly resend an indeterminate operation's stored requests. Allowed only when every
   * unfinished leg was prepared replay-safe by the adapter; otherwise HOST_OUTCOME_INDETERMINATE.
   */
  readonly replayIndeterminate?: boolean;
}

type FailureReceipt = Extract<HostOperationReceipt, { readonly stage: "failed" | "indeterminate" }>;

const isFailure = (receipt: HostOperationReceipt): receipt is FailureReceipt =>
  receipt.stage === "failed" || receipt.stage === "indeterminate";

const legsFor = (mode: "wake" | "context" | "both"): readonly HostDeliveryLeg[] =>
  mode === "wake" ? ["wake"] : mode === "context" ? ["context"] : ["context", "wake"];

/**
 * A failed replay proves nothing about the first attempt, which may already have taken effect.
 * The outcome stays unknown, and no retry hint survives to invite a new operation.
 */
function replayUnknown(failure: FailureReceipt): FailureReceipt {
  if (failure.stage === "indeterminate") return failure;
  const detail: Record<string, unknown> = { ...failure.detail };
  delete detail.retryable;
  return {
    stage: "indeterminate",
    receiptId: failure.receiptId,
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    detail: { ...detail, replayFailed: true },
  };
}

/** A later leg failing after an earlier leg took effect must not be retried as a fresh operation. */
function partialFailure(receipt: FailureReceipt, contextReceiptId: string | null): FailureReceipt {
  if (contextReceiptId === null) return receipt;
  return {
    stage: receipt.stage,
    receiptId: receipt.receiptId,
    errorCode: receipt.errorCode,
    errorMessage: receipt.errorMessage,
    detail: { ...receipt.detail, contextReceiptId },
  };
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

  hostAdapter(name: string): HostAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new SidebandError("ADAPTER_NOT_FOUND", `Host adapter not found: ${name}`);
    return adapter;
  }

  private adapter(name: string): HostAdapter {
    return this.hostAdapter(name);
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

  /** True when spawns on this adapter reserve their host tuple as a managed identity intent. */
  managesSpawnIdentity(adapterName: string): boolean {
    return this.managedSpawnAdapter(adapterName) !== null;
  }

  private managedSpawnAdapter(adapterName: string): HostAdapter | null {
    const adapter = this.adapters.get(adapterName);
    return this.options.spawnIdentity !== undefined && adapter?.planSpawn !== undefined
      ? adapter
      : null;
  }

  private refuseSpawner(reason: string, message: string): never {
    throw new SidebandError("UNAUTHORIZED", message, { reason });
  }

  /**
   * Managed spawn. Order matters: verify the trusted spawner (no writes), begin the operation,
   * plan the tuple, then claim the dispatch and reserve the authorized intent in ONE transaction.
   * Only after that commits does the adapter touch the host. The receipt and, after a definite
   * failure, the abandon commit together. The binding comes from identity enrollment, never from
   * a raw bind here.
   */
  private async spawnManaged(
    input: SpawnAgentInput,
    adapter: HostAdapter,
    coordinator: SpawnIdentityCoordinator,
  ): Promise<HostOperationResult> {
    if (input.spawner === undefined) {
      this.refuseSpawner("SPAWNER_REQUIRED", "Managed spawns require a trusted spawner.");
    }
    const authority = coordinator.verifySpawner(input.spawner);
    if (input.principalId !== undefined && input.principalId !== authority.principalId) {
      this.refuseSpawner("PRINCIPAL_MISMATCH", "The principal differs from the verified spawner.");
    }
    if (input.parentAgentId !== authority.agentId) {
      this.refuseSpawner("PARENT_MISMATCH", "The parent differs from the verified spawner.");
    }
    for (const key of adapter.reservedSpawnMetadata ?? []) {
      if (key in input.metadata) {
        throw new SidebandError(
          "INVALID_ARGUMENT",
          `Spawn metadata '${key}' is chosen by Sideband and cannot be set by the caller.`,
        );
      }
    }
    const principalId = authority.principalId;
    try {
      this.options.store.getAgent(input.agentId);
    } catch (error) {
      if (!(error instanceof SidebandError) || error.code !== "AGENT_NOT_FOUND") throw error;
      this.options.store.registerAgent({ agentId: input.agentId, actorPrincipalId: principalId });
    }
    const request = {
      agentId: input.agentId,
      adapter: input.adapter,
      parentAgentId: authority.agentId,
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
    // A replay re-verified the spawner above, so a revoked caller cannot read an old outcome back.
    if (begun.operation.stage !== "queued") {
      return {
        operation: begun.operation,
        binding: this.bindingForCompletedOperation(begun.operation),
      };
    }
    await this.requireCapability(adapter, "spawn");
    const operationId = begun.operation.operationId;
    let plan: HostSpawnPlan;
    try {
      plan = await (adapter.planSpawn as NonNullable<HostAdapter["planSpawn"]>)({
        operationId,
        agentId: input.agentId,
        provider: input.provider,
        metadata: input.metadata,
      });
    } catch {
      throw new SidebandError(
        "ADAPTER_CAPABILITY_UNAVAILABLE",
        `Adapter ${adapter.name} could not plan the spawn; nothing was sent.`,
      );
    }
    const tuple = { adapter: input.adapter, ...plan };
    const dispatch = this.options.store.inTransaction(() => {
      const claimed = this.options.store.claimOperationDispatch({
        operationId,
        dispatchOwnerId: randomUUID(),
      });
      if (claimed.acquired) {
        coordinator.reserve(input.spawner, {
          spawnOperationId: operationId,
          ...tuple,
          intendedAgentId: input.agentId,
        });
      }
      return claimed;
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
        operationId,
        plan: { hostInstanceId: plan.hostInstanceId, externalId: plan.externalId },
      });
    } catch {
      receipt = this.indeterminate();
    }
    receipt = this.requirePlannedTuple(receipt, plan);
    const operation = this.options.store.inTransaction(() => {
      const succeeded =
        receipt.stage === "accepted" || receipt.stage === "adopted" || receipt.stage === "observed";
      // Enrollment may already have created the managed binding while the host call was in flight.
      const bindingId = succeeded ? coordinator.managedBindingId(tuple, input.agentId) : null;
      const recorded = this.options.store.recordOperationReceipt({
        operationId,
        receipt,
        ...(bindingId === null ? {} : { bindingId }),
      });
      // Only a definite failure releases the intent; unknown outcomes keep the tuple reserved.
      if (receipt.stage === "failed") {
        coordinator.abandon(operationId, `${receipt.errorCode}: ${receipt.errorMessage}`);
      }
      return recorded;
    });
    return { operation, binding: this.bindingForCompletedOperation(operation) };
  }

  /** A host that reports a tuple other than the reserved one acted somewhere unplanned. */
  private requirePlannedTuple(receipt: HostSpawnReceipt, plan: HostSpawnPlan): HostSpawnReceipt {
    if (!("externalId" in receipt)) return receipt;
    if (receipt.hostInstanceId === plan.hostInstanceId && receipt.externalId === plan.externalId) {
      return receipt;
    }
    return {
      stage: "indeterminate",
      receiptId: receipt.receiptId,
      errorCode: "SPAWN_TUPLE_MISMATCH",
      errorMessage: "The host reported a different thread than the one Sideband reserved.",
      detail: {
        plannedHostInstanceId: plan.hostInstanceId,
        plannedExternalId: plan.externalId,
        reportedHostInstanceId: receipt.hostInstanceId,
        reportedExternalId: receipt.externalId,
      },
    };
  }

  /**
   * Records a receipt that carries a raw binding. If the tuple belongs to identity enrollment the
   * raw-bind guard refuses it; the host did act, so the outcome stays unknown instead of
   * stranding the operation mid-dispatch.
   */
  private recordReceiptWithBinding(input: RecordOperationReceiptInput): OperationRecord {
    try {
      return this.options.store.recordOperationReceipt(input);
    } catch (error) {
      if (
        input.binding === undefined ||
        !(error instanceof SidebandError) ||
        error.code !== "BINDING_CONFLICT" ||
        error.details.reason !== RAW_BIND_REFUSED
      ) {
        throw error;
      }
      return this.options.store.recordOperationReceipt({
        operationId: input.operationId,
        receipt: {
          stage: "indeterminate",
          receiptId: input.receipt.receiptId,
          errorCode: "BINDING_REFUSED",
          errorMessage: error.message,
        },
      });
    }
  }

  async spawnAgent(input: SpawnAgentInput): Promise<HostOperationResult> {
    const managedAdapter = this.managedSpawnAdapter(input.adapter);
    if (managedAdapter !== null && this.options.spawnIdentity !== undefined) {
      return this.spawnManaged(input, managedAdapter, this.options.spawnIdentity);
    }
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
    const operation = this.recordReceiptWithBinding({
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
    // Refuse a tuple that identity enrollment manages before the host is touched.
    this.options.store.assertRawBindAllowed({
      agentId: input.agentId,
      adapter: input.adapter,
      hostInstanceId: input.hostInstanceId,
      externalId: input.externalId,
    });
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
    const operation = this.recordReceiptWithBinding({
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
    const replayed = this.options.store.findOperationByIdempotency({
      principalId,
      idempotencyKey: input.idempotencyKey,
      kind: "send",
      request,
    });
    if (replayed !== null) {
      if (input.replayIndeterminate && replayed.stage === "indeterminate") {
        return this.replayIndeterminate(replayed, input.mode);
      }
      return { operation: replayed, binding };
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
    const dispatch = this.options.store.claimOperationDispatch({
      operationId: begun.operation.operationId,
      dispatchOwnerId: randomUUID(),
    });
    if (!dispatch.acquired) {
      return { operation: dispatch.operation, binding };
    }
    let receipt: HostOperationReceipt;
    try {
      receipt = await this.deliver(
        adapter,
        {
          idempotencyKey: input.idempotencyKey,
          operationId: dispatch.operation.operationId,
          binding: controllableBinding,
          messageId: message.messageId,
          fromAgentId: message.fromAgentId,
          correlationId: message.correlationId,
          body: message.body,
          messageClass: message.messageClass,
          metadata: message.metadata,
        },
        input.mode,
      );
    } catch {
      receipt = this.indeterminate();
    }
    const completedOperation = this.options.store.recordOperationReceipt({
      operationId: dispatch.operation.operationId,
      receipt,
    });
    return { operation: completedOperation, binding };
  }

  /**
   * Adapters with prepare/execute get each leg persisted before I/O. Adapters with injectContext
   * get a separate context leg that must succeed before any wake. Others keep send(mode).
   */
  private async deliver(
    adapter: HostAdapter,
    request: Omit<HostSendRequest, "mode">,
    mode: "wake" | "context" | "both",
  ): Promise<HostOperationReceipt> {
    if (adapter.prepare && adapter.execute) {
      return this.deliverPrepared(adapter, request, mode);
    }
    if (mode === "wake" || !adapter.injectContext) {
      return adapter.send({ ...request, mode });
    }
    const context = await adapter.injectContext({
      idempotencyKey: `${request.idempotencyKey}:context`,
      binding: request.binding,
      messageId: request.messageId,
      body: request.body,
      metadata: request.metadata,
    });
    if (mode === "context" || context.stage === "failed" || context.stage === "indeterminate") {
      return context;
    }
    const wake = await adapter.send({ ...request, mode: "wake" });
    return isFailure(wake) ? partialFailure(wake, context.receiptId) : wake;
  }

  /**
   * Prepares, persists, then executes each leg. A leg with a successful stored receipt is a
   * checkpoint and never runs twice; a stored leg without one is resent byte-for-byte.
   */
  private async deliverPrepared(
    adapter: HostAdapter,
    request: Omit<HostSendRequest, "mode">,
    mode: "wake" | "context" | "both",
    replaying = false,
  ): Promise<HostOperationReceipt> {
    const prepare = adapter.prepare as NonNullable<HostAdapter["prepare"]>;
    const execute = adapter.execute as NonNullable<HostAdapter["execute"]>;
    let contextReceiptId: string | null = null;
    let last: HostOperationReceipt | undefined;
    for (const leg of legsFor(mode)) {
      let stored = this.options.store.getPreparedRequest(request.operationId, leg);
      if (stored?.receipt && !isFailure(stored.receipt)) {
        last = stored.receipt;
        if (leg === "context") contextReceiptId = stored.receipt.receiptId;
        continue;
      }
      if (!stored) {
        let prepared: HostPreparedRequest | HostPrepareFailure;
        try {
          prepared = await prepare.call(adapter, { ...request, leg });
        } catch {
          prepared = {
            stage: "failed",
            receiptId: null,
            errorCode: "HOST_ADAPTER_ERROR",
            errorMessage: "Host adapter failed while preparing the request; nothing was sent.",
          };
        }
        if ("stage" in prepared) {
          return partialFailure(replaying ? replayUnknown(prepared) : prepared, contextReceiptId);
        }
        stored = this.options.store.savePreparedRequest({
          operationId: request.operationId,
          adapter: adapter.name,
          bindingId: request.binding.bindingId,
          prepared,
        });
      }
      let receipt: HostOperationReceipt;
      try {
        receipt = await execute.call(adapter, {
          operationId: request.operationId,
          binding: request.binding,
          prepared: stored.prepared,
        });
      } catch {
        receipt = this.indeterminate();
      }
      if (replaying && receipt.stage === "failed") {
        // Keep the leg's stored (unknown) outcome so a later explicit replay can still resolve it.
        return partialFailure(replayUnknown(receipt), contextReceiptId);
      }
      this.options.store.recordPreparedReceipt({ operationId: request.operationId, leg, receipt });
      if (isFailure(receipt)) return partialFailure(receipt, contextReceiptId);
      if (leg === "context") contextReceiptId = receipt.receiptId;
      last = receipt;
    }
    return last as HostOperationReceipt;
  }

  private async replayIndeterminate(
    operation: OperationRecord,
    mode: "wake" | "context" | "both",
  ): Promise<HostOperationResult> {
    const adapter = this.adapter(operation.adapter);
    const unsafe = (reason: string): never => {
      throw new SidebandError(
        "HOST_OUTCOME_INDETERMINATE",
        `Operation ${operation.operationId} cannot be replayed safely: ${reason}`,
        { operationId: operation.operationId },
      );
    };
    if (!adapter.prepare || !adapter.execute) unsafe("the adapter has no stored-request replay.");
    if (operation.bindingId === null || operation.messageId === null) unsafe("no stored route.");
    for (const leg of legsFor(mode)) {
      const stored = this.options.store.getPreparedRequest(operation.operationId, leg);
      // A missing row means the leg was never sent: requests are persisted before any I/O.
      if (stored && (stored.receipt === null || isFailure(stored.receipt))) {
        if (stored.receipt?.stage === "failed") unsafe(`the ${leg} leg already failed.`);
        if (!stored.prepared.replaySafe) unsafe(`the ${leg} leg is not replay-safe.`);
      }
    }
    const binding = this.options.store.getControllableBinding(operation.bindingId as string);
    const message = this.options.store.getMessage(operation.messageId as string);
    const dispatch = this.options.store.reclaimIndeterminateDispatch({
      operationId: operation.operationId,
      dispatchOwnerId: randomUUID(),
    });
    if (!dispatch.acquired) return { operation: dispatch.operation, binding };
    let receipt: HostOperationReceipt;
    try {
      receipt = await this.deliverPrepared(
        adapter,
        {
          idempotencyKey: operation.idempotencyKey,
          operationId: operation.operationId,
          binding,
          messageId: message.messageId,
          fromAgentId: message.fromAgentId,
          correlationId: message.correlationId,
          body: message.body,
          messageClass: message.messageClass,
          metadata: message.metadata,
        },
        mode,
        true,
      );
    } catch {
      receipt = this.indeterminate();
    }
    const completed = this.options.store.recordOperationReceipt({
      operationId: operation.operationId,
      receipt,
    });
    return { operation: completed, binding };
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
