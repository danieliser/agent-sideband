import type { ReadableStreamReadResult } from "node:stream/web";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface SidebandMcpRequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

export interface SidebandMcpApiClient {
  request(path: string, options?: SidebandMcpRequestOptions): Promise<unknown>;
}

export type SidebandApiErrorCode =
  | "SIDEBAND_INVALID_URL"
  | "SIDEBAND_REMOTE_URL_REJECTED"
  | "SIDEBAND_INVALID_TOKEN"
  | "SIDEBAND_INVALID_REQUEST"
  | "SIDEBAND_TIMEOUT"
  | "SIDEBAND_NETWORK_ERROR"
  | "SIDEBAND_HTTP_ERROR"
  | "SIDEBAND_INVALID_RESPONSE";

export class SidebandApiError extends Error {
  readonly code: SidebandApiErrorCode;
  readonly status?: number;

  constructor(code: SidebandApiErrorCode, message: string, options: { status?: number } = {}) {
    super(message);
    this.name = "SidebandApiError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

export interface SidebandHttpClientOptions {
  readonly baseUrl?: string | URL;
  readonly token: string;
  readonly allowRemote?: boolean;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

class BodyReadAbortedError extends Error {}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split(".").every((part) => Number(part) <= 255);
  }
  return /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeBaseUrl(input: string | URL, allowRemote: boolean): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SidebandApiError("SIDEBAND_INVALID_URL", "Agent Sideband URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SidebandApiError(
      "SIDEBAND_INVALID_URL",
      "Agent Sideband URL must use HTTP or HTTPS.",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SidebandApiError(
      "SIDEBAND_INVALID_URL",
      "Agent Sideband URL must not contain credentials.",
    );
  }
  if (
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new SidebandApiError(
      "SIDEBAND_INVALID_URL",
      "Agent Sideband URL must contain only an origin.",
    );
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (!loopback && !allowRemote) {
    throw new SidebandApiError(
      "SIDEBAND_REMOTE_URL_REJECTED",
      "Agent Sideband URL must be loopback unless remote access is explicitly enabled.",
    );
  }
  if (!loopback && url.protocol !== "https:") {
    throw new SidebandApiError(
      "SIDEBAND_INVALID_URL",
      "Remote Agent Sideband URLs must use HTTPS.",
    );
  }
  url.pathname = "/";
  return url;
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new BodyReadAbortedError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const invalid = () =>
    new SidebandApiError(
      "SIDEBAND_INVALID_RESPONSE",
      "Agent Sideband returned an invalid response.",
    );
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) throw invalid();
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) {
        completed = true;
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) throw invalid();
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (completed) reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw invalid();
  }
}

function responseError(value: unknown, status: number): SidebandApiError {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return new SidebandApiError("SIDEBAND_HTTP_ERROR", message, { status });
      }
    }
  }
  return new SidebandApiError("SIDEBAND_HTTP_ERROR", `Agent Sideband returned HTTP ${status}.`, {
    status,
  });
}

export class SidebandHttpClient implements SidebandMcpApiClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: SidebandHttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? "http://127.0.0.1:7341",
      options.allowRemote ?? false,
    );
    if (options.token.length === 0 || options.token.trim() !== options.token) {
      throw new SidebandApiError(
        "SIDEBAND_INVALID_TOKEN",
        "Agent Sideband token must be non-empty and contain no surrounding whitespace.",
      );
    }
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new SidebandApiError(
        "SIDEBAND_INVALID_REQUEST",
        "Agent Sideband timeout must be a positive integer.",
      );
    }
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async request(path: string, options: SidebandMcpRequestOptions = {}): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new SidebandApiError(
        "SIDEBAND_INVALID_REQUEST",
        "Agent Sideband request path must be origin-relative.",
      );
    }
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new SidebandApiError(
        "SIDEBAND_INVALID_REQUEST",
        "Agent Sideband request path changed origin.",
      );
    }
    const method = options.method ?? "GET";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": options.idempotencyKey }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const text = await readBoundedBody(response, controller.signal);
      let value: unknown = null;
      if (text.length > 0) {
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          throw new SidebandApiError(
            "SIDEBAND_INVALID_RESPONSE",
            "Agent Sideband returned invalid JSON.",
          );
        }
      }
      if (!response.ok) throw responseError(value, response.status);
      return value;
    } catch (error) {
      if (error instanceof SidebandApiError) throw error;
      if (controller.signal.aborted || error instanceof BodyReadAbortedError) {
        throw new SidebandApiError("SIDEBAND_TIMEOUT", "Agent Sideband request timed out.");
      }
      throw new SidebandApiError(
        "SIDEBAND_NETWORK_ERROR",
        "Agent Sideband request failed before a response was received.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
