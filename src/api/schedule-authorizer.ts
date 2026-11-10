import type { ScheduleAuthorizer } from "../scheduling/scheduler.js";
import type { AuthenticatedAgent, IdentityService, OperatorPrincipal } from "../security/index.js";
import type { AuthenticatedPrincipal } from "./auth.js";

type ScheduleIdentity = Pick<IdentityService, "authorizeSchedule" | "explainScheduleDelivery">;

/**
 * The identity service's own principal object, as attached by the authenticator. Credentials
 * without one (such as a connector) can never own or cancel a schedule.
 */
function identityActor(
  caller: AuthenticatedPrincipal,
): AuthenticatedAgent | OperatorPrincipal | null {
  if (caller.kind !== "agent" && caller.kind !== "operator") return null;
  const handle = caller.handle as { kind?: unknown } | undefined;
  if (handle?.kind !== caller.kind) return null;
  return handle as AuthenticatedAgent | OperatorPrincipal;
}

/**
 * Binds the scheduler's create, cancel and dispatch checks to live identity state. Dispatch
 * authority deliberately ignores tool-token expiry: a self reminder created under a valid
 * credential still fires after that token expires or rotates, and stops only on explicit
 * revocation, retirement, an invalid binding or a revoked grant.
 */
export function identityScheduleAuthorizer(
  identity: ScheduleIdentity,
): ScheduleAuthorizer<AuthenticatedPrincipal> {
  return {
    authorizeCreate({ caller, principalId, targetAgentId }) {
      const actor = identityActor(caller);
      if (actor === null) {
        return { allowed: false, reason: "credential cannot own schedules" };
      }
      return identity.authorizeSchedule(actor, principalId, targetAgentId, "create");
    },
    authorizeDispatch({ ownerPrincipalId, targetAgentId, binding, pinned }) {
      return identity.explainScheduleDelivery(
        ownerPrincipalId,
        targetAgentId,
        binding ?? undefined,
        pinned,
      );
    },
    authorizeCancel({ caller, ownerPrincipalId, targetAgentId }) {
      const actor = identityActor(caller);
      if (actor === null) return { allowed: false, reason: "credential cannot cancel schedules" };
      const decision = identity.authorizeSchedule(actor, ownerPrincipalId, targetAgentId, "cancel");
      return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
    },
  };
}
