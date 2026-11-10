#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { T3_DELIVERY_CREDENTIAL_SCHEME, T3HostAdapter } from "./adapters/t3.js";
import { createSidebandDaemon, type HostAdapterFactory } from "./api/daemon.js";
import { SidebandHttpClient } from "./mcp/http-client.js";

const USAGE = `Usage:
  agent-sideband [serve] [--database PATH] [--host HOST] [--port PORT] [--t3-url URL]
  agent-sideband connector enroll --adapter NAME --host-instance ID [--allow-agent ID]... [--expires-at ISO] [--out FILE]
  agent-sideband connector rotate --adapter NAME --host-instance ID --rotation-id ID [--out FILE]
  agent-sideband connector revoke --adapter NAME --host-instance ID [--reason TEXT]
  agent-sideband access restore|revoke --agent ID [--reason TEXT]
  agent-sideband grant schedule|revoke-schedule --owner AGENT --target AGENT

Management commands talk to a running daemon (AGENT_SIDEBAND_URL, default http://127.0.0.1:7341)
with the local operator token. Issued connector tokens are written to a 0600 file, never printed.`;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function argumentList(name: string): string[] {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] !== undefined
      ? [process.argv[index + 1] as string]
      : [],
  );
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} is required.\n\n${USAGE}`);
  return value;
}

function stateDirectory(): string {
  const directory = resolve(process.env.AGENT_SIDEBAND_STATE_DIR ?? ".agent-sideband");
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(directory, 0o700);
  return directory;
}

function writeSecret(path: string, secret: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function loadOrCreateToken(path: string): string {
  try {
    const token = readFileSync(path, "utf8").trim();
    chmodSync(path, 0o600);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const token = randomBytes(32).toString("base64url");
    writeSecret(path, token);
    return token;
  }
}

function operatorToken(directory: string): string {
  const token =
    process.env.AGENT_SIDEBAND_TOKEN ??
    loadOrCreateToken(
      resolve(process.env.AGENT_SIDEBAND_TOKEN_FILE ?? `${directory}/sideband.token`),
    );
  if (token.length < 32)
    throw new Error("Agent Sideband bearer tokens must be at least 32 characters.");
  return token;
}

async function serve(): Promise<void> {
  const directory = stateDirectory();
  const database = resolve(
    argument("--database") ?? process.env.AGENT_SIDEBAND_DATABASE ?? `${directory}/sideband.sqlite`,
  );
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const host = argument("--host") ?? process.env.AGENT_SIDEBAND_HOST ?? "127.0.0.1";
  const port = Number(argument("--port") ?? process.env.AGENT_SIDEBAND_PORT ?? "7341");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  const t3Url = argument("--t3-url") ?? process.env.AGENT_SIDEBAND_T3_URL ?? null;
  const t3Token = process.env.AGENT_SIDEBAND_T3_TOKEN ?? null;
  if ((t3Url === null) !== (t3Token === null)) {
    throw new Error("T3 integration requires both a URL and a token.");
  }
  const adapters: HostAdapterFactory[] = [];
  if (t3Url !== null && t3Token !== null) {
    adapters.push({
      name: "t3",
      // Context uses only connector-pushed thread credentials; the environment token never does.
      create: ({ deliveryCredentials }) =>
        new T3HostAdapter({
          baseUrl: t3Url,
          token: t3Token,
          allowRemote: process.env.AGENT_SIDEBAND_T3_ALLOW_REMOTE === "true",
          resolveDeliveryCredential: (binding) =>
            deliveryCredentials.resolve(binding, T3_DELIVERY_CREDENTIAL_SCHEME),
          rejectDeliveryCredential: (binding, providerSessionId) =>
            deliveryCredentials.reject(binding, providerSessionId),
        }),
    });
  }
  const publicUrl = process.env.AGENT_SIDEBAND_PUBLIC_URL;
  const daemon = createSidebandDaemon({
    database,
    operatorToken: operatorToken(directory),
    adapters,
    logger: true,
    ...(publicUrl === undefined ? {} : { publicUrl }),
  });
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void daemon.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
  await daemon.listen({ host, port });
}

function operatorClient(): SidebandHttpClient {
  const baseUrl = process.env.AGENT_SIDEBAND_URL;
  return new SidebandHttpClient({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    token: operatorToken(stateDirectory()),
    allowRemote: process.env.AGENT_SIDEBAND_ALLOW_REMOTE === "true",
  });
}

function connectorTokenPath(adapter: string, hostInstanceId: string): string {
  const safe = `${adapter}-${hostInstanceId}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  return resolve(argument("--out") ?? `${stateDirectory()}/connectors/${safe}.token`);
}

function report(value: Record<string, unknown>): void {
  const visible = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "token"));
  process.stdout.write(`${JSON.stringify(visible, null, 2)}\n`);
}

async function connector(action: string | undefined): Promise<void> {
  const client = operatorClient();
  const adapter = required("--adapter");
  const hostInstanceId = required("--host-instance");
  if (action === "enroll" || action === "rotate") {
    const allowedAgentIds = argumentList("--allow-agent");
    const expiresAt = argument("--expires-at");
    const issued = (await client.request(
      action === "enroll" ? "/v1/connectors" : "/v1/connectors/rotate",
      {
        method: "POST",
        body:
          action === "enroll"
            ? {
                adapter,
                hostInstanceId,
                ...(allowedAgentIds.length === 0 ? {} : { allowedAgentIds }),
                ...(expiresAt === undefined ? {} : { expiresAt }),
              }
            : { adapter, hostInstanceId, rotationId: required("--rotation-id") },
      },
    )) as Record<string, unknown>;
    if (typeof issued.token !== "string") throw new Error("The daemon did not return a token.");
    const path = connectorTokenPath(adapter, hostInstanceId);
    writeSecret(path, issued.token);
    report({ ...issued, tokenFile: path });
    return;
  }
  if (action === "revoke") {
    report(
      (await client.request("/v1/connectors/revoke", {
        method: "POST",
        body: { adapter, hostInstanceId, reason: argument("--reason") ?? "revoked by operator" },
      })) as Record<string, unknown>,
    );
    return;
  }
  throw new Error(USAGE);
}

async function access(action: string | undefined): Promise<void> {
  if (action !== "restore" && action !== "revoke") throw new Error(USAGE);
  const agentId = encodeURIComponent(required("--agent"));
  report(
    (await operatorClient().request(`/v1/agents/${agentId}/access/${action}`, {
      method: "POST",
      body: action === "revoke" ? { reason: argument("--reason") ?? "revoked by operator" } : {},
    })) as Record<string, unknown>,
  );
}

async function grant(action: string | undefined): Promise<void> {
  if (action !== "schedule" && action !== "revoke-schedule") throw new Error(USAGE);
  report(
    (await operatorClient().request(
      action === "schedule" ? "/v1/schedule-grants" : "/v1/schedule-grants/revoke",
      {
        method: "POST",
        body: { ownerAgentId: required("--owner"), targetAgentId: required("--target") },
      },
    )) as Record<string, unknown>,
  );
}

async function main(): Promise<void> {
  const [command, action] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "connector") return connector(action);
  if (command === "access") return access(action);
  if (command === "grant") return grant(action);
  if (command === undefined || command === "serve" || command.startsWith("--")) return serve();
  throw new Error(USAGE);
}

main().catch((error: unknown) => {
  const code =
    (error as { remoteCode?: string; code?: string }).remoteCode ??
    (error as { code?: string }).code;
  process.stderr.write(
    `${code === undefined ? "" : `${code}: `}${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
