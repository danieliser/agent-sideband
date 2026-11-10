import type { HostAdapter, HostAdapterCapabilities } from "../core/host-adapter.js";
import type { AgentSideband } from "../core/sideband.js";
import type { AgentBinding } from "../core/types.js";
import type { SidebandStore } from "../store/store.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { AGENT_EVENT_SUBSCRIPTIONS } from "./schedules.js";

const CAPABILITY_TIMEOUT_MS = 2_000;

export interface CapabilityContext {
  readonly sideband: AgentSideband;
  readonly store: SidebandStore;
  readonly adapters: readonly HostAdapter[];
  readonly schedulingAvailable: boolean;
  readonly identityAvailable: boolean;
}

type AdapterProbe =
  | ({ readonly available: true } & HostAdapterCapabilities)
  | { readonly available: false; readonly reason: string };

async function probe(adapter: HostAdapter): Promise<AdapterProbe> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const capabilities = await Promise.race([
      adapter.capabilities(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CAPABILITY_TIMEOUT_MS);
      }),
    ]);
    return { available: true, ...capabilities };
  } catch {
    // Adapter failures never leak raw transport errors and never fail the core response.
    return { available: false, reason: "ADAPTER_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
}

function principalBinding(
  context: CapabilityContext,
  principal: AuthenticatedPrincipal,
): AgentBinding | null {
  try {
    if (principal.session !== undefined)
      return context.store.getBinding(principal.session.bindingId);
    if (principal.agentId !== null) return context.store.getActiveBinding(principal.agentId);
  } catch {
    return null;
  }
  return null;
}

function bindingSummary(binding: AgentBinding) {
  return {
    bindingId: binding.bindingId,
    adapter: binding.adapter,
    hostInstanceId: binding.hostInstanceId,
    externalId: binding.externalId,
    generation: binding.generation,
    state: binding.state,
    active: binding.active,
    leaseExpiresAt: binding.leaseExpiresAt,
  };
}

/** Per-target readiness when the adapter offers it; adapter-wide support otherwise. */
async function probeTarget(
  adapter: HostAdapter,
  binding: AgentBinding,
  supported: HostAdapterCapabilities,
): Promise<HostAdapterCapabilities> {
  if (adapter.capabilitiesForBinding === undefined) return supported;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      adapter.capabilitiesForBinding(binding),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CAPABILITY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { ...supported, context: false };
  } finally {
    clearTimeout(timer);
  }
}

async function deliveryFor(context: CapabilityContext, binding: AgentBinding | null) {
  if (binding === null || !binding.active) return null;
  let adapter: HostAdapter;
  try {
    adapter = context.sideband.hostAdapter(binding.adapter);
  } catch {
    return {
      adapter: binding.adapter,
      bindingId: binding.bindingId,
      available: false,
      wake: false,
      context: false,
      both: false,
    };
  }
  const result = await probe(adapter);
  if (!result.available) {
    return {
      adapter: binding.adapter,
      bindingId: binding.bindingId,
      available: false,
      wake: false,
      context: false,
      both: false,
    };
  }
  const target = await probeTarget(adapter, binding, result);
  const contextReady = result.context && target.context;
  return {
    adapter: binding.adapter,
    bindingId: binding.bindingId,
    available: true,
    wake: result.wake,
    // Ready for this target now; contextSupported is the adapter-wide support. A supported but
    // not-ready target may still schedule context: delivery waits, it never becomes a wake.
    context: contextReady,
    contextSupported: result.context,
    both: result.wake && contextReady,
    receiptLevel: result.adoptionReceipts ? "provider-adopted" : "host-accepted",
  };
}

export async function describeCapabilities(
  context: CapabilityContext,
  principal: AuthenticatedPrincipal,
) {
  const adapters = await Promise.all(
    context.adapters.map(async (adapter) => ({ name: adapter.name, ...(await probe(adapter)) })),
  );
  const scheduling = context.schedulingAvailable;
  return {
    protocolVersion: 1,
    scheduling: {
      available: scheduling,
      triggers: {
        after: scheduling,
        at: scheduling,
        interval: scheduling,
        cron: scheduling,
        event:
          scheduling && (AGENT_EVENT_SUBSCRIPTIONS || principal.grants.has("schedules:events")),
      },
      namedEventIngress: scheduling ? "operator-or-trusted-host" : "unavailable",
      cronFields: 5,
      cronDayMatch: "and",
      cronDowRange: "0-6",
      cronTimezone: "IANA name, default UTC",
      cronMissedWhileOffline: "skip",
      intervalMissed: "coalesce-one",
      defaultTarget: "self",
      allowedTargets: "self-or-explicit-grant",
      defaultDeliveryMode: "wake",
      creationReceipt: "scheduled",
    },
    delivery: await deliveryFor(context, principalBinding(context, principal)),
    adapters,
    identity: { automaticProvisioning: context.identityAvailable },
  };
}

export function describePrincipal(context: CapabilityContext, principal: AuthenticatedPrincipal) {
  let displayName: string | null = null;
  if (principal.agentId !== null) {
    try {
      displayName = context.store.getAgent(principal.agentId).displayName ?? null;
    } catch {
      displayName = null;
    }
  }
  const binding = principalBinding(context, principal);
  return {
    kind: principal.kind ?? (principal.grants.has("admin") ? "operator" : "agent"),
    principalId: principal.principalId,
    agentId: principal.agentId,
    displayName,
    grants: [...principal.grants].sort(),
    session:
      principal.session === undefined
        ? null
        : {
            hostSessionId: principal.session.hostSessionId,
            generation: principal.session.generation,
            adapter: principal.session.adapter,
            hostInstanceId: principal.session.hostInstanceId,
            externalId: principal.session.externalId,
            credentialExpiresAt: principal.session.expiresAt ?? null,
          },
    binding: binding === null ? null : bindingSummary(binding),
  };
}
