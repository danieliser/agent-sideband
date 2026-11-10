import { SidebandError } from "../core/errors.js";

/**
 * Raised when a credential was already minted for the request. The raw token
 * is only ever returned by the call that created it; callers must rotate.
 */
export class CredentialAlreadyIssuedError extends SidebandError {
  constructor(details: Readonly<Record<string, unknown>>) {
    super(
      "CREDENTIAL_ALREADY_ISSUED",
      "A credential was already issued for this request; rotate it with a new rotationId.",
      details,
    );
    this.name = "CredentialAlreadyIssuedError";
  }
}

export type UnauthorizedReason =
  | "ACCESS_REVOKED"
  | "CONNECTOR_INVALID"
  | "CONNECTOR_SCOPE"
  | "ALIAS_NOT_PERMITTED"
  | "PARENT_NOT_VERIFIED"
  | "SESSION_NOT_OWNED"
  | "HOST_EPOCH_MISMATCH"
  | "SESSION_NOT_ACTIVE"
  | "LEASE_EXPIRED"
  | "OPERATOR_REQUIRED"
  | "SPAWNER_NOT_VERIFIED"
  | "SPAWN_NOT_PERMITTED";

export function unauthorized(reason: UnauthorizedReason, message: string): never {
  throw new SidebandError("UNAUTHORIZED", message, { reason });
}
