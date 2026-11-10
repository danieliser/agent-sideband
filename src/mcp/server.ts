import { McpServer } from "@modelcontextprotocol/server";

import type { SidebandMcpApiClient } from "./http-client.js";
import { registerSidebandTools, type SidebandToolAudience } from "./tools.js";

export type { SidebandMcpApiClient, SidebandMcpRequestOptions } from "./http-client.js";
export { registerSidebandTools } from "./tools.js";

export interface AgentSidebandMcpServerOptions {
  readonly api: SidebandMcpApiClient;
  /** Tool audiences to expose. Default: agent and operator tools, as in earlier releases. */
  readonly audiences?: readonly SidebandToolAudience[];
}

export function buildAgentSidebandMcpServer(options: AgentSidebandMcpServerOptions): McpServer {
  const server = new McpServer({ name: "agent-sideband", version: "0.2.1" });
  registerSidebandTools(server, options.api, {
    ...(options.audiences === undefined ? {} : { audiences: options.audiences }),
  });
  return server;
}
