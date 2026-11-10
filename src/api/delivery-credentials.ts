import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AgentBinding } from "../core/types.js";
import { deriveHostSessionId } from "../security/ids.js";
import { ApiError, forbidden, invalidArgument } from "./errors.js";
import { integerValue, requiredObjectBody, stringValue } from "./request.js";

/**
 * Host-pushed delivery credentials: a host connector hands Sideband a narrow, thread-scoped host
 * credential so an adapter can reach a host route that refuses the environment token (for T3,
 * context injection). The raw token lives ONLY in this process's memory: never SQLite, events,
 * logs, prepared host requests, receipts, errors or MCP results. Every resolve re-checks the live
 * binding, host session and connector, so revocation, offline, lease expiry and generation
 * replacement take effect immediately. A restart starts empty and waits for the host to re-push.
 */

interface DeliveryScheme {
  /** The only host adapter whose sessions may carry this scheme. */
  readonly adapter: string;
  readonly capabilities: readonly string[];
}

const SCHEMES: Readonly<Record<string, DeliveryScheme>> = {
  "t3-thread-mcp-v1": { adapter: "t3", capabilities: ["context-injection"] },
};

const BODY_KEYS = [
  "capabilities",
  "expiresAt",
  "generation",
  "hostEpoch",
  "providerSessionId",
  "scheme",
  "token",
];
const MAX_LIFETIME_MS = 24 * 3_600_000;
const TOKEN_PATTERN = /^[\x21-\x7e]{16,8192}$/;

/** The non-secret session facts a delivery credential is pinned to. */
export interface LiveHostSession {
  readonly hostSessionId: string;
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly providerSessionId: string;
  readonly hostEpoch: string;
}

export interface DeliverySessionVerifier {
  /** Throws unless the connector handle is valid and owns this session, live under hostEpoch. */
  requireConnectorLiveSession(
    connector: unknown,
    hostSessionId: string,
    hostEpoch: string,
  ): LiveHostSession;
}

export interface ResolvedDeliveryCredential<S extends string = string> {
  readonly scheme: S;
  readonly token: string;
  readonly providerSessionId: string;
  readonly generation: number;
  readonly expiresAt: string;
}

interface Entry {
  readonly connector: unknown;
  readonly scheme: string;
  readonly hostSessionId: string;
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly providerSessionId: string;
  readonly hostEpoch: string;
  readonly token: string;
  readonly expiresAt: string;
}

export class DeliveryCredentialVault {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly verifier: DeliverySessionVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get size(): number {
    return this.#entries.size;
  }

  /** Validates and stores a pushed credential; returns only non-secret fields. */
  put(
    connector: unknown,
    hostSessionId: string,
    body: Readonly<Record<string, unknown>>,
  ): { hostSessionId: string; generation: number; expiresAt: string } {
    const extra = Object.keys(body).filter((key) => !BODY_KEYS.includes(key));
    if (extra.length > 0) throw invalidArgument("Unknown delivery credential fields.", { extra });
    const schemeName = stringValue(body.scheme, "scheme");
    const scheme = Object.hasOwn(SCHEMES, schemeName) ? SCHEMES[schemeName] : undefined;
    if (scheme === undefined) throw invalidArgument("Unsupported scheme.", { field: "scheme" });
    const hostEpoch = stringValue(body.hostEpoch, "hostEpoch");
    const generation = integerValue(body.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
    const providerSessionId = stringValue(body.providerSessionId, "providerSessionId");
    const capabilities = body.capabilities;
    if (
      !Array.isArray(capabilities) ||
      capabilities.length !== scheme.capabilities.length ||
      capabilities.some((capability, index) => capability !== scheme.capabilities[index])
    ) {
      throw invalidArgument("capabilities must match the scheme exactly.", {
        field: "capabilities",
      });
    }
    const token = body.token;
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token) || /^sb[act]t_/.test(token)) {
      throw invalidArgument("token is not an acceptable host credential.", { field: "token" });
    }
    const expiresAt = stringValue(body.expiresAt, "expiresAt");
    const expiresMs = Date.parse(expiresAt);
    const nowMs = this.now().getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs || expiresMs > nowMs + MAX_LIFETIME_MS) {
      throw invalidArgument("expiresAt must be a future time within 24 hours.", {
        field: "expiresAt",
      });
    }

    let session: LiveHostSession;
    try {
      session = this.verifier.requireConnectorLiveSession(connector, hostSessionId, hostEpoch);
    } catch (error) {
      // A session that is no longer live keeps nothing an earlier push left behind. Only the
      // owning connector reaches this point with a valid session id, so drop on its refusals.
      const reason = (error as { details?: { reason?: unknown } }).details?.reason;
      if (reason !== "SESSION_NOT_OWNED" && reason !== "CONNECTOR_INVALID") {
        this.#entries.delete(hostSessionId);
      }
      throw error;
    }
    if (session.adapter !== scheme.adapter) {
      throw forbidden("This scheme is not valid for the session's host adapter.", {
        reason: "ADAPTER_SCHEME_MISMATCH",
      });
    }
    if (generation !== session.generation) {
      throw new ApiError(
        "STALE_GENERATION",
        409,
        "generation is not the session's live generation.",
      );
    }
    if (providerSessionId !== session.providerSessionId) {
      throw new ApiError(
        "HOST_SESSION_MISMATCH",
        409,
        "providerSessionId is not the session's live provider session.",
      );
    }
    const normalized = new Date(expiresMs).toISOString();
    this.#entries.set(session.hostSessionId, {
      connector,
      scheme: schemeName,
      hostSessionId: session.hostSessionId,
      adapter: session.adapter,
      hostInstanceId: session.hostInstanceId,
      bindingId: session.bindingId,
      generation: session.generation,
      providerSessionId: session.providerSessionId,
      hostEpoch: session.hostEpoch,
      token,
      expiresAt: normalized,
    });
    return { hostSessionId: session.hostSessionId, generation, expiresAt: normalized };
  }

  /** The current credential for exactly this binding and scheme, or null. Never stale. */
  resolve<S extends string>(
    binding: AgentBinding,
    scheme: S,
  ): ResolvedDeliveryCredential<S> | null {
    const hostSessionId = deriveHostSessionId(
      binding.adapter,
      binding.hostInstanceId,
      binding.externalId,
    );
    const entry = this.#live(hostSessionId);
    if (
      entry === undefined ||
      entry.scheme !== scheme ||
      !binding.active ||
      binding.bindingId !== entry.bindingId ||
      binding.generation !== entry.generation
    ) {
      return null;
    }
    return {
      scheme,
      token: entry.token,
      providerSessionId: entry.providerSessionId,
      generation: entry.generation,
      expiresAt: entry.expiresAt,
    };
  }

  /** The host refused the credential for this provider session: forget it. */
  reject(binding: AgentBinding, providerSessionId: string): void {
    const hostSessionId = deriveHostSessionId(
      binding.adapter,
      binding.hostInstanceId,
      binding.externalId,
    );
    if (this.#entries.get(hostSessionId)?.providerSessionId === providerSessionId) {
      this.#entries.delete(hostSessionId);
    }
  }

  /** True for every vault; lets routes report held/missing so a host knows to re-push. */
  get supported(): boolean {
    return true;
  }

  isHeld(hostSessionId: string): boolean {
    return this.#live(hostSessionId) !== undefined;
  }

  drop(hostSessionId: string): void {
    this.#entries.delete(hostSessionId);
  }

  /** Re-checks every entry now, e.g. after a connector or access revocation. */
  sweep(): void {
    for (const hostSessionId of [...this.#entries.keys()]) this.#live(hostSessionId);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Serializes to a count only, so an accidental log or JSON dump never carries a token. */
  toJSON(): { readonly held: number } {
    return { held: this.#entries.size };
  }

  #live(hostSessionId: string): Entry | undefined {
    const entry = this.#entries.get(hostSessionId);
    if (entry === undefined) return undefined;
    let session: LiveHostSession | undefined;
    try {
      if (Date.parse(entry.expiresAt) > this.now().getTime()) {
        session = this.verifier.requireConnectorLiveSession(
          entry.connector,
          hostSessionId,
          entry.hostEpoch,
        );
      }
    } catch {
      session = undefined;
    }
    if (
      session === undefined ||
      session.bindingId !== entry.bindingId ||
      session.generation !== entry.generation ||
      session.providerSessionId !== entry.providerSessionId
    ) {
      this.#entries.delete(hostSessionId);
      return undefined;
    }
    return entry;
  }
}

/** PUT /v1/host-sessions/:hostSessionId/delivery-credential, for the owning connector only. */
export function registerDeliveryCredentialRoutes(
  app: FastifyInstance,
  vault: DeliveryCredentialVault,
  connector: (request: FastifyRequest) => unknown,
): void {
  app.put<{ Params: { hostSessionId: string } }>(
    "/v1/host-sessions/:hostSessionId/delivery-credential",
    async (request, reply) => {
      const handle = connector(request);
      const stored = vault.put(handle, request.params.hostSessionId, requiredObjectBody(request));
      return reply.header("cache-control", "no-store").send(stored);
    },
  );
}
