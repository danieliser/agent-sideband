#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildAgentSidebandServer } from "./api/server.js";
import { allApiGrants, staticBearerAuthenticator } from "./api/auth.js";
import { T3HostAdapter } from "./adapters/t3.js";
import type { HostAdapter } from "./core/host-adapter.js";
import { AgentSideband } from "./core/sideband.js";
import { SqliteSidebandStore } from "./store/sqlite.js";

interface CliOptions {
  readonly database: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly t3Url: string | null;
  readonly t3Token: string | null;
  readonly allowRemoteT3: boolean;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function loadOrCreateToken(path: string): string {
  try {
    const token = readFileSync(path, "utf8").trim();
    chmodSync(path, 0o600);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    return token;
  }
}

function options(): CliOptions {
  const stateDirectory = resolve(process.env.AGENT_SIDEBAND_STATE_DIR ?? ".agent-sideband");
  const stateDirectoryExists = existsSync(stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  if (!stateDirectoryExists) chmodSync(stateDirectory, 0o700);
  const database = resolve(
    argument("--database") ??
      process.env.AGENT_SIDEBAND_DATABASE ??
      `${stateDirectory}/sideband.sqlite`,
  );
  const host = argument("--host") ?? process.env.AGENT_SIDEBAND_HOST ?? "127.0.0.1";
  const portText = argument("--port") ?? process.env.AGENT_SIDEBAND_PORT ?? "7341";
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const token =
    process.env.AGENT_SIDEBAND_TOKEN ??
    loadOrCreateToken(
      resolve(process.env.AGENT_SIDEBAND_TOKEN_FILE ?? `${stateDirectory}/sideband.token`),
    );
  if (token.length < 32)
    throw new Error("Agent Sideband bearer tokens must be at least 32 characters.");
  const t3Url = argument("--t3-url") ?? process.env.AGENT_SIDEBAND_T3_URL ?? null;
  const t3Token = process.env.AGENT_SIDEBAND_T3_TOKEN ?? null;
  if ((t3Url === null) !== (t3Token === null)) {
    throw new Error("T3 integration requires both a URL and a token.");
  }
  const allowRemoteT3 = process.env.AGENT_SIDEBAND_T3_ALLOW_REMOTE === "true";
  return { database, host, port, token, t3Url, t3Token, allowRemoteT3 };
}

const config = options();
const store = SqliteSidebandStore.open(config.database);
store.registerAgent({
  agentId: "operator",
  displayName: "Local operator",
  actorPrincipalId: "operator",
});
const adapters: HostAdapter[] = [];
if (config.t3Url !== null && config.t3Token !== null) {
  adapters.push(
    new T3HostAdapter({
      baseUrl: config.t3Url,
      token: config.t3Token,
      allowRemote: config.allowRemoteT3,
    }),
  );
}
const sideband = new AgentSideband({ store, adapters });
const app = buildAgentSidebandServer({
  sideband,
  store,
  authenticate: staticBearerAuthenticator({
    token: config.token,
    principal: {
      principalId: "operator",
      agentId: "operator",
      source: "http",
      sourceInstanceId: "local-daemon",
      grants: allApiGrants,
    },
  }),
  logger: true,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}

await app.listen({ host: config.host, port: config.port });
