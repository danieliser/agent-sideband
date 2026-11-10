export { SidebandApiError, SidebandHttpClient } from "./http-client.js";
export type {
  SidebandApiErrorCode,
  SidebandApiErrorOptions,
  SidebandHttpClientOptions,
  SidebandMcpApiClient,
  SidebandMcpRequestOptions,
} from "./http-client.js";
export { buildAgentSidebandMcpServer, registerSidebandTools } from "./server.js";
export type { AgentSidebandMcpServerOptions } from "./server.js";
export {
  invokeSidebandTool,
  runSidebandTool,
  sidebandToolCatalog,
  sidebandToolFailure,
  sidebandToolSuccess,
  sidebandTools,
} from "./tools.js";
export type {
  SidebandToolAnnotations,
  SidebandToolAudience,
  SidebandToolDefinition,
  SidebandToolDescriptor,
  SidebandToolResult,
} from "./tools.js";
