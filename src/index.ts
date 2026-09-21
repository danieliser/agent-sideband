export { buildAgentSidebandServer } from "./api/server.js";
export type { AgentSidebandServerOptions } from "./api/server.js";
export { allApiGrants, staticBearerAuthenticator } from "./api/auth.js";
export type { ApiGrant, AuthenticatedPrincipal, SidebandAuthenticator } from "./api/auth.js";
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
  HostControlRequest,
  HostDeliveryRequest,
  HostBindingProof,
  HostBindRequest,
  HostInspection,
  HostOperationReceipt,
  HostReceipt,
  HostSendRequest,
  HostSpawnReceipt,
  HostSpawnRequest,
} from "./core/host-adapter.js";
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
