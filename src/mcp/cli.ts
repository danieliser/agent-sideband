#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { SidebandHttpClient } from "./http-client.js";
import { buildAgentSidebandMcpServer } from "./server.js";

function loadToken(): string {
  const environmentToken = process.env.AGENT_SIDEBAND_TOKEN;
  if (environmentToken !== undefined) return environmentToken;
  const path = resolve(process.env.AGENT_SIDEBAND_TOKEN_FILE ?? ".agent-sideband/sideband.token");
  return readFileSync(path, "utf8").trim();
}

function timeout(): number | undefined {
  const value = process.env.AGENT_SIDEBAND_TIMEOUT_MS;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("AGENT_SIDEBAND_TIMEOUT_MS must be a positive integer.");
  }
  return parsed;
}

const requestTimeout = timeout();
const baseUrl = process.env.AGENT_SIDEBAND_URL;
const api = new SidebandHttpClient({
  ...(baseUrl === undefined ? {} : { baseUrl }),
  token: loadToken(),
  allowRemote: process.env.AGENT_SIDEBAND_ALLOW_REMOTE === "true",
  ...(requestTimeout === undefined ? {} : { timeoutMs: requestTimeout }),
});
const handle = serveStdio(() => buildAgentSidebandMcpServer({ api }), {
  onerror: (error) => console.error(error.message),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
