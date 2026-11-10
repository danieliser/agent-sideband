export { buildAgentSidebandServer } from "./api/server.js";
export type { AgentSidebandServerOptions } from "./api/server.js";
export {
  agentApiGrants,
  allApiGrants,
  composeAuthenticators,
  connectorApiGrants,
  staticBearerAuthenticator,
} from "./api/auth.js";
export type {
  ApiGrant,
  AuthenticatedPrincipal,
  PrincipalKind,
  PrincipalSession,
  SidebandAuthenticator,
} from "./api/auth.js";
export { createSidebandDaemon, OPERATOR_PRINCIPAL_ID } from "./api/daemon.js";
export type {
  DegradedAdapter,
  HostAdapterFactory,
  SidebandDaemon,
  SidebandDaemonOptions,
} from "./api/daemon.js";
export { ApiError } from "./api/errors.js";
export { identityAuthenticator } from "./api/identity.js";
export type { SidebandIdentityApi } from "./api/identity.js";
export { identityScheduleAuthorizer } from "./api/schedule-authorizer.js";
export { SchedulerLoop } from "./api/scheduler-loop.js";
export type { SchedulerLoopOptions, SchedulerLoopStatus } from "./api/scheduler-loop.js";
export type { SchedulingSurface } from "./api/schedules.js";
export { Scheduler } from "./scheduling/scheduler.js";
export type {
  CreateScheduleInput,
  ScheduleAuthorizer,
  SchedulerOptions,
} from "./scheduling/scheduler.js";
export { SqliteScheduleStore } from "./scheduling/store.js";
export type { DeliveryMode, OccurrenceRecord, ScheduleRecord } from "./scheduling/store.js";
export type { TimeTrigger } from "./scheduling/triggers.js";
export {
  CredentialAlreadyIssuedError,
  IdentityService,
  createOperatorPrincipal,
  OPTIONAL_AGENT_GRANTS,
  DEFAULT_AGENT_GRANTS,
  deriveHostAgentId,
  identityMigration,
} from "./security/index.js";
export type {
  AuthenticatedAgent,
  HostConnectorPrincipal,
  HostSessionRegistration,
  IssuedAgentAccess,
  OperatorPrincipal,
} from "./security/index.js";
export { T3AdapterError, T3HostAdapter } from "./adapters/t3.js";
export type {
  T3AdapterErrorCode,
  T3EnvironmentDescriptor,
  T3HostAdapterOptions,
  T3OrchestrationSnapshot,
  T3ThreadDetailSnapshot,
  T3ThreadSession,
  T3ThreadSummary,
} from "./adapters/t3.js";
export { SidebandError } from "./core/errors.js";
export type { SidebandErrorCode } from "./core/errors.js";
export type {
  HostAdapter,
  HostAdapterCapabilities,
  HostContextInjectionRequest,
  HostControlRequest,
  HostDeliveryRequest,
  HostBindingProof,
  HostBindRequest,
  HostInspection,
  HostOperationReceipt,
  HostReceipt,
  HostSendRequest,
  HostSpawnPlan,
  HostSpawnPlanRequest,
  HostSpawnReceipt,
  HostSpawnRequest,
} from "./core/host-adapter.js";
export type {
  SpawnAuthority,
  SpawnIdentityCoordinator,
  SpawnIdentityTuple,
  SpawnReservation,
} from "./core/spawn-identity.js";
export { AgentSideband } from "./core/sideband.js";
export type {
  AgentSidebandOptions,
  BindAgentInput,
  HostOperationResult,
  SendMessageToHostInput,
  SpawnAgentInput,
} from "./core/sideband.js";
export type * from "./core/types.js";
export { SqliteSidebandStore } from "./store/sqlite.js";
export type { SidebandStore } from "./store/store.js";
export { SidebandApiError, SidebandHttpClient } from "./mcp/http-client.js";
export type {
  SidebandApiErrorCode,
  SidebandApiErrorOptions,
  SidebandHttpClientOptions,
  SidebandMcpApiClient,
  SidebandMcpRequestOptions,
} from "./mcp/http-client.js";
export { buildAgentSidebandMcpServer } from "./mcp/server.js";
export type { AgentSidebandMcpServerOptions } from "./mcp/server.js";
export {
  invokeSidebandTool,
  registerSidebandTools,
  runSidebandTool,
  sidebandToolCatalog,
  sidebandToolFailure,
  sidebandToolSuccess,
  sidebandTools,
} from "./mcp/tools.js";
export type {
  SidebandToolAnnotations,
  SidebandToolAudience,
  SidebandToolDefinition,
  SidebandToolDescriptor,
  SidebandToolResult,
} from "./mcp/tools.js";
