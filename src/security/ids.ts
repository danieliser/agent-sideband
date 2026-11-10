import { createHash, randomBytes } from "node:crypto";

/** Hash a tuple with length-prefixed fields so field boundaries cannot be forged. */
export function framedHash(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

/** Stable agent id for a host thread: length-framed hash of adapter, host and external id. */
export function deriveHostAgentId(
  adapter: string,
  hostInstanceId: string,
  externalId: string,
): string {
  return `ha_${framedHash(["agent", adapter, hostInstanceId, externalId]).slice(0, 48)}`;
}

/** Stable id of the natural host-session tuple. */
export function deriveHostSessionId(
  adapter: string,
  hostInstanceId: string,
  externalId: string,
): string {
  return `hs_${framedHash(["session", adapter, hostInstanceId, externalId]).slice(0, 48)}`;
}

export function deriveConnectorId(adapter: string, hostInstanceId: string): string {
  return `hc_${framedHash(["connector", adapter, hostInstanceId]).slice(0, 48)}`;
}

export function principalIdForAgent(agentId: string): string {
  return `agent:${agentId}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const AGENT_TOKEN_PREFIX = "sbat_";
export const CONNECTOR_TOKEN_PREFIX = "sbct_";
export const TOKEN_BYTES = 32;

export type TokenBytes = (size: number) => Uint8Array;

export function mintToken(prefix: string, tokenBytes: TokenBytes = randomBytes): string {
  const bytes = tokenBytes(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) throw new Error("token entropy source returned wrong size");
  return `${prefix}${Buffer.from(bytes).toString("base64url")}`;
}
