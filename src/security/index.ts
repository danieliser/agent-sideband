export { CredentialAlreadyIssuedError } from "./errors.js";
export type { UnauthorizedReason } from "./errors.js";
export { deriveHostAgentId, deriveHostSessionId, principalIdForAgent } from "./ids.js";
export { IdentityService, createOperatorPrincipal, identityMigration } from "./service.js";
export type { IdentityServiceOptions } from "./service.js";
export { DEFAULT_AGENT_GRANTS, OPTIONAL_AGENT_GRANTS } from "./types.js";
export type {
  AgentGrant,
  AuthenticatedAgent,
  BindingReference,
  HostConnectorPrincipal,
  HostSessionRecord,
  HostSessionRegistration,
  IssuedAgentAccess,
  IssuedConnectorCredential,
  OperatorPrincipal,
  PinnedScheduleAuthorization,
  ScheduleAction,
  ScheduleAuthorization,
  ScheduleDeliveryDecision,
  ScheduleDeliveryReason,
} from "./types.js";
