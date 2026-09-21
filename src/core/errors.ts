export type SidebandErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_CONFLICT"
  | "TEAM_NOT_FOUND"
  | "TEAM_CONFLICT"
  | "TEAM_PARENT_NOT_FOUND"
  | "TEAM_PARENT_CYCLE"
  | "CHANNEL_NOT_FOUND"
  | "CHANNEL_CONFLICT"
  | "MESSAGE_NOT_FOUND"
  | "MESSAGE_CLAIM_CONFLICT"
  | "MESSAGE_DELIVERY_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "BINDING_NOT_FOUND"
  | "BINDING_CONFLICT"
  | "OPERATION_NOT_FOUND"
  | "ADAPTER_NOT_FOUND"
  | "ADAPTER_CAPABILITY_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "UNAUTHORIZED";

export class SidebandError extends Error {
  readonly code: SidebandErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: SidebandErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SidebandError";
    this.code = code;
    this.details = details;
  }
}
