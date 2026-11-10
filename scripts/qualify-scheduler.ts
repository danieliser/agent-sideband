/**
 * Packed-artifact qualification for Agent Sideband scheduler + identity.
 *
 * Usage: tsx scripts/qualify-scheduler.ts <extracted-package-dir>
 *
 * The package directory must be the contents of `npm pack` output (dist/, migrations/, ...), with
 * a node_modules reachable from it. This script never imports from the source tree. It checks:
 *   1. the declared exports import (".", "./t3", "./mcp") and the bin files exist
 *   2. migrations are resolvable from dist (daemon + identity find 0001-0004)
 *   3. the composed daemon runs from dist on a temp database
 *   4. the packaged stdio MCP bin (agent-sideband-mcp) works with the native MCP stdio client:
 *      an operator creates a 30 minute schedule for an explicit target agent (an operator call
 *      without a target is refused), the wire request normalizes to 1800 seconds, and the
 *      schedule lists back
 * The host is not involved: no adapter is configured, so this proves packaging only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const packageDir = resolve(process.argv[2] ?? "");
if (!existsSync(join(packageDir, "package.json"))) {
  console.error("usage: tsx scripts/qualify-scheduler.ts <extracted-package-dir>");
  process.exit(2);
}

const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
function record(check: string, ok: boolean, detail?: string): void {
  results.push({ check, ok, ...(detail === undefined ? {} : { detail }) });
}
const load = (path: string) => import(pathToFileURL(join(packageDir, path)).href);

const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const workDirectory = mkdtempSync(join(tmpdir(), "sideband-pack-"));
let executable: ChildProcess | undefined;
let client: Client | undefined;
let daemon:
  | undefined
  | {
      listen(i: { host: string; port: number }): Promise<string>;
      close(): Promise<void>;
      store: { registerAgent(input: { agentId: string; displayName?: string }): unknown };
    };

try {
  for (const [name, target] of Object.entries<{ import: string }>(manifest.exports)) {
    try {
      const module = await load(target.import);
      record(
        `export ${name}`,
        Object.keys(module).length > 0,
        `${Object.keys(module).length} names`,
      );
    } catch (error) {
      record(`export ${name}`, false, (error as Error).message);
    }
  }
  for (const bin of Object.values<string>(manifest.bin)) {
    record(`bin ${bin}`, existsSync(join(packageDir, bin)));
  }
  for (const file of [
    "0001_initial.sql",
    "0002_schedules.sql",
    "0003_identity.sql",
    "0004_spawn_intents.sql",
  ]) {
    record(`migration ${file}`, existsSync(join(packageDir, "migrations", file)));
  }

  const root = await load("dist/index.js");
  for (const name of [
    "createSidebandDaemon",
    "IdentityService",
    "Scheduler",
    "DEFAULT_AGENT_GRANTS",
    "sidebandToolCatalog",
  ]) {
    record(`root exports ${name}`, name in root);
  }

  const operatorToken = "operator-token-for-packed-artifact-qualification";
  const databasePath = join(workDirectory, "pack.sqlite");
  const targetAgentId = "pack-target-agent";
  const packed: NonNullable<typeof daemon> = root.createSidebandDaemon({
    database: databasePath,
    operatorToken,
    scheduler: { autoStart: false },
  });
  daemon = packed;
  packed.store.registerAgent({ agentId: targetAgentId, displayName: "Pack Target" });
  const base = await packed.listen({ host: "127.0.0.1", port: 0 });
  const operator = { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" };
  const health = (await (await fetch(`${base}/health`)).json()) as {
    status?: string;
    scheduler?: unknown;
  };
  record("packed daemon /health", health.status === "ok", JSON.stringify(health.scheduler));

  // Operator-level MCP over the packaged stdio bin proves the bin, SDK transport and catalog.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageDir, manifest.bin["agent-sideband-mcp"])],
    env: {
      PATH: process.env.PATH ?? "",
      AGENT_SIDEBAND_URL: base,
      AGENT_SIDEBAND_TOKEN: operatorToken,
    },
  });
  client = new Client({ name: "pack-qualification", version: "0.0.0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  record(
    "stdio MCP lists schedule tools",
    tools.includes("sideband_schedule_create") && tools.includes("sideband_schedules_list"),
    `${tools.length} tools`,
  );
  const thirtyMinutes = { type: "after", delay: { value: 30, unit: "minutes" } };

  const untargeted = await client.callTool({
    name: "sideband_schedule_create",
    arguments: { idempotencyKey: "pack-untargeted", body: "no target", trigger: thirtyMinutes },
  });
  record(
    "stdio MCP operator create without targetAgentId is refused",
    untargeted.isError === true,
    JSON.stringify(untargeted.structuredContent ?? untargeted.content).slice(0, 160),
  );

  const wallBefore = Date.now();
  const created = await client.callTool({
    name: "sideband_schedule_create",
    arguments: {
      idempotencyKey: "pack-1",
      body: "packed reminder",
      trigger: thirtyMinutes,
      targetAgentId,
    },
  });
  const wallAfter = Date.now();
  const structured = (created.structuredContent ?? {}) as {
    requestedTrigger?: { type?: string; delaySeconds?: number };
    schedule?: { scheduleId?: string; targetAgentId?: string; ownerAgentId?: string | null };
  };
  record(
    "stdio MCP 30 minute schedule normalizes to 1800 seconds",
    created.isError !== true &&
      structured.requestedTrigger?.type === "after" &&
      structured.requestedTrigger.delaySeconds === 1800,
    `delaySeconds=${structured.requestedTrigger?.delaySeconds}`,
  );
  record(
    "stdio MCP schedule targets the explicit agent with no owner agent",
    structured.schedule?.targetAgentId === targetAgentId &&
      structured.schedule.ownerAgentId === null,
    JSON.stringify(structured.schedule),
  );
  const listed = await client.callTool({ name: "sideband_schedules_list", arguments: {} });
  const items =
    ((listed.structuredContent ?? {}) as { items?: Array<{ scheduleId?: string }> }).items ?? [];
  record(
    "stdio MCP lists the created schedule",
    items.some((item) => item.scheduleId === structured.schedule?.scheduleId),
    `${items.length} item(s)`,
  );

  const sqlite = createRequire(join(packageDir, "package.json"))("better-sqlite3");
  const db = new sqlite(databasePath, { readonly: true });
  try {
    const versions = (
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((row) => row.version);
    record(
      "packed daemon applied migrations 1,2,3,4",
      [1, 2, 3, 4].every((version) => versions.includes(version)),
      `versions=${versions.join(",")}`,
    );
    const row = db
      .prepare("SELECT * FROM schedules WHERE schedule_id = ?")
      .get(structured.schedule?.scheduleId ?? "") as Record<string, unknown> | undefined;
    const due = Object.entries(row ?? {}).find(([column]) => /next_due|next_run/.test(column));
    const dueMs = typeof due?.[1] === "string" ? Date.parse(due[1]) : Number.NaN;
    const offsetSeconds = (dueMs - wallBefore) / 1000;
    record(
      "stored next-due instant is ~1800 real seconds after creation (wall clock)",
      offsetSeconds >= 1800 - 1 && offsetSeconds <= 1800 + (wallAfter - wallBefore) / 1000 + 1,
      `${due?.[0]}=${due?.[1]} offset=${offsetSeconds.toFixed(3)}s`,
    );
  } finally {
    db.close();
  }
  const me = await fetch(`${base}/v1/me`, { headers: operator });
  record("packed daemon operator /v1/me", me.status === 200);
  await client.close();
  client = undefined;

  // Exercise the shipped daemon executable with its default automatic scheduler.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const cliBase = `http://127.0.0.1:${port}`;
  const cliDatabase = join(workDirectory, "cli.sqlite");
  const start = async () => {
    const childEnv = { ...process.env };
    delete childEnv.AGENT_SIDEBAND_T3_URL;
    delete childEnv.AGENT_SIDEBAND_T3_TOKEN;
    executable = spawn(
      process.execPath,
      [join(packageDir, manifest.bin["agent-sideband"]), "--port", String(port)],
      {
        env: {
          ...childEnv,
          AGENT_SIDEBAND_STATE_DIR: join(workDirectory, "cli-state"),
          AGENT_SIDEBAND_DATABASE: cliDatabase,
          AGENT_SIDEBAND_TOKEN: operatorToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Absent adapter envs must actually be absent, not empty strings.
    let output = "";
    executable.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    executable.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (executable.exitCode !== null)
        throw new Error(`Packaged CLI exited: ${output.slice(-1000)}`);
      try {
        if ((await fetch(`${cliBase}/health`)).ok) return;
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Packaged CLI did not become healthy");
  };
  const stop = async () => {
    if (!executable || executable.exitCode !== null) return;
    const child = executable;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI shutdown timed out"));
      }, 5000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`CLI exit ${code}`));
      });
      child.kill("SIGTERM");
    });
    executable = undefined;
  };
  await start();
  const registered = await fetch(`${cliBase}/v1/agents/cli-target`, {
    method: "PUT",
    headers: operator,
    body: JSON.stringify({ displayName: "CLI Target" }),
  });
  if (!registered.ok) throw new Error(`CLI registration ${registered.status}`);
  const scheduled = await fetch(`${cliBase}/v1/schedules`, {
    method: "POST",
    headers: { ...operator, "idempotency-key": "cli-restart-reminder" },
    body: JSON.stringify({
      targetAgentId: "cli-target",
      body: "restart timer proof",
      trigger: { type: "after", delaySeconds: 4 },
    }),
  });
  if (!scheduled.ok) throw new Error(`CLI schedule ${scheduled.status}: ${await scheduled.text()}`);
  const cliSchedule = (await scheduled.json()) as { schedule: { scheduleId: string } };
  await stop();
  await start();
  const cliDb = new sqlite(cliDatabase, { readonly: true });
  try {
    const deadline = Date.now() + 10000;
    let rows: Array<{ state: string; error_code: string }> = [];
    while (Date.now() < deadline) {
      rows = cliDb
        .prepare("SELECT state, error_code FROM schedule_occurrences WHERE schedule_id = ?")
        .all(cliSchedule.schedule.scheduleId);
      if (rows.some((row) => row.state === "blocked")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    record(
      "packaged CLI automatic timer survives restart and materializes one hostless occurrence",
      rows.length === 1 && rows[0]?.state === "blocked" && rows[0]?.error_code === "TARGET_UNBOUND",
      JSON.stringify(rows),
    );
  } finally {
    cliDb.close();
  }
  await stop();
} catch (error) {
  record("unexpected failure", false, (error as Error).stack ?? String(error));
} finally {
  await client?.close().catch(() => undefined);
  executable?.kill("SIGTERM");
  await daemon?.close().catch(() => undefined);
  rmSync(workDirectory, { recursive: true, force: true });
}

for (const entry of results) {
  console.log(
    `${entry.ok ? "PASS" : "FAIL"} ${entry.check}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}
process.exit(results.every((entry) => entry.ok) ? 0 : 1);
