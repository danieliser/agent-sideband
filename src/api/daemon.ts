import type { FastifyInstance } from "fastify";

import type { HostAdapter } from "../core/host-adapter.js";
import { AgentSideband } from "../core/sideband.js";
import { Scheduler } from "../scheduling/scheduler.js";
import { SqliteScheduleStore } from "../scheduling/store.js";
import { IdentityService, createOperatorPrincipal, identityMigration } from "../security/index.js";
import { SqliteSidebandStore } from "../store/sqlite.js";
import {
  allApiGrants,
  composeAuthenticators,
  staticBearerAuthenticator,
  type AuthenticatedPrincipal,
} from "./auth.js";
import { DeliveryCredentialVault } from "./delivery-credentials.js";
import { identityAuthenticator } from "./identity.js";
import { identityScheduleAuthorizer } from "./schedule-authorizer.js";
import { SchedulerLoop } from "./scheduler-loop.js";
import { buildAgentSidebandServer } from "./server.js";

export const OPERATOR_PRINCIPAL_ID = "operator";

/** Daemon-owned services an adapter may use. Nothing here is persisted or exposed over HTTP. */
export interface HostAdapterContext {
  /** Host-pushed delivery credentials, held in memory only and re-verified on every resolve. */
  readonly deliveryCredentials: Pick<DeliveryCredentialVault, "resolve" | "reject">;
}

/** An optional host adapter. A factory that throws is reported as degraded, never fatal. */
export interface HostAdapterFactory {
  readonly name: string;
  create(context: HostAdapterContext): HostAdapter;
}

export interface SidebandDaemonOptions {
  readonly database: string;
  /** Local management credential. Never distribute it to agent sessions. */
  readonly operatorToken: string;
  readonly adapters?: readonly HostAdapterFactory[];
  /** Requires a host that enrolls spawned sessions. Stock hosts use receipt-based bindings. */
  readonly managedSpawnIdentity?: boolean;
  readonly logger?: boolean;
  readonly publicUrl?: string;
  readonly now?: () => Date;
  readonly scheduler?: {
    readonly intervalMs?: number;
    readonly batchSize?: number;
    readonly leaseSeconds?: number;
    /** Tests drive passes by hand. */
    readonly autoStart?: boolean;
  };
}

export interface DegradedAdapter {
  readonly name: string;
  readonly reason: string;
}

export interface SidebandDaemon {
  readonly app: FastifyInstance;
  readonly store: SqliteSidebandStore;
  readonly identity: IdentityService;
  readonly deliveryCredentials: DeliveryCredentialVault;
  readonly scheduler: Scheduler<AuthenticatedPrincipal>;
  readonly loop: SchedulerLoop;
  readonly adapters: readonly HostAdapter[];
  readonly degradedAdapters: readonly DegradedAdapter[];
  listen(input: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

function adapterFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "ADAPTER_INIT_FAILED";
}

/**
 * Composes the store, versioned migrations, identity service, scheduler and HTTP API on one
 * SQLite connection. Only the store itself is required to start; adapters degrade.
 */
export function createSidebandDaemon(options: SidebandDaemonOptions): SidebandDaemon {
  if (options.operatorToken.length < 32) {
    throw new Error("The operator token must be at least 32 characters.");
  }
  const now = options.now ?? (() => new Date());
  const store = SqliteSidebandStore.open(options.database, { now });
  try {
    const schedules = SqliteScheduleStore.attach(store, { now });
    // Core migrations 0001-0002 are applied by the store; identity's additive 0003 is recorded
    // on the same versioned ledger so every schema change is journaled and checksummed.
    store.applyMigrations([identityMigration()]);
    // spawnIntents opts the daemon into managed spawn identity: it applies migration 0004 after
    // 0003 and exposes the coordinator below. It only changes spawns on adapters that implement
    // planSpawn; every other adapter keeps its unmanaged behavior.
    const identity = IdentityService.create(store, {
      now,
      operatorPrincipalIds: new Set([OPERATOR_PRINCIPAL_ID]),
      spawnIntents: true,
    });
    store.registerAgent({
      agentId: OPERATOR_PRINCIPAL_ID,
      displayName: "Local operator",
      actorPrincipalId: OPERATOR_PRINCIPAL_ID,
    });

    const deliveryCredentials = new DeliveryCredentialVault(identity, now);
    const adapterContext: HostAdapterContext = {
      deliveryCredentials: {
        resolve: (binding, scheme) => deliveryCredentials.resolve(binding, scheme),
        reject: (binding, providerSessionId) =>
          deliveryCredentials.reject(binding, providerSessionId),
      },
    };
    const adapters: HostAdapter[] = [];
    const degradedAdapters: DegradedAdapter[] = [];
    for (const factory of options.adapters ?? []) {
      try {
        adapters.push(factory.create(adapterContext));
      } catch (error) {
        degradedAdapters.push({ name: factory.name, reason: adapterFailureCode(error) });
      }
    }

    const spawnIdentity = options.managedSpawnIdentity === true ? identity.spawnIdentity : null;
    const sideband = new AgentSideband({
      store,
      adapters,
      ...(spawnIdentity === null ? {} : { spawnIdentity }),
    });
    const scheduler = new Scheduler<AuthenticatedPrincipal>({
      store,
      sideband,
      schedules,
      now,
      authorizer: identityScheduleAuthorizer(identity),
    });
    const leaseSeconds = options.scheduler?.leaseSeconds ?? 60;
    let onLoopError: (code: string) => void = () => undefined;
    const loop = new SchedulerLoop({
      runBatch: async (limit) => (await scheduler.runDue({ limit, leaseSeconds })).length,
      now,
      onError: (code) => onLoopError(code),
      ...(options.scheduler?.intervalMs === undefined
        ? {}
        : { intervalMs: options.scheduler.intervalMs }),
      ...(options.scheduler?.batchSize === undefined
        ? {}
        : { batchSize: options.scheduler.batchSize }),
    });

    const operator: AuthenticatedPrincipal = {
      kind: "operator",
      principalId: OPERATOR_PRINCIPAL_ID,
      agentId: OPERATOR_PRINCIPAL_ID,
      source: "http",
      sourceInstanceId: "local-daemon",
      grants: allApiGrants,
      handle: createOperatorPrincipal(OPERATOR_PRINCIPAL_ID),
    };
    const app = buildAgentSidebandServer({
      sideband,
      store,
      adapters,
      scheduling: { scheduler, schedules },
      identity,
      deliveryCredentials,
      authenticate: composeAuthenticators(
        identityAuthenticator(identity),
        staticBearerAuthenticator({ token: options.operatorToken, principal: operator }),
      ),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
      health: () => ({
        scheduler: loop.status(),
        degradedAdapters: degradedAdapters.map((adapter) => adapter.name),
      }),
    });
    onLoopError = (code) => app.log.warn({ code }, "scheduler pass failed");
    for (const adapter of degradedAdapters) {
      app.log.warn({ adapter: adapter.name, code: adapter.reason }, "host adapter unavailable");
    }

    let closing: Promise<void> | null = null;
    return {
      app,
      store,
      identity,
      deliveryCredentials,
      scheduler,
      loop,
      adapters,
      degradedAdapters,
      async listen(input) {
        const address = await app.listen(input);
        if (options.scheduler?.autoStart !== false) loop.start();
        return address;
      },
      close() {
        closing ??= (async () => {
          await loop.stop();
          await app.close();
          deliveryCredentials.clear();
          store.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
