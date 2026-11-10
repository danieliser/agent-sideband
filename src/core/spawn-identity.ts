/**
 * Managed spawn identity. A spawn that Sideband initiates reserves the host tuple it will create
 * as a durable intent, in the same store transaction that claims the dispatch and before any host
 * I/O. Enrollment of that tuple later adopts the intent instead of minting a second identity.
 *
 * The coordinator is generic: core knows nothing about how authority is verified. The spawner is
 * an opaque handle that only trusted server code can hold (an operator principal or a verified
 * agent credential), never a field a caller or model can write.
 */

export interface SpawnIdentityTuple {
  readonly adapter: string;
  readonly hostInstanceId: string;
  readonly externalId: string;
}

/** Who a verified spawner is. The agent id becomes the spawned agent's parent. */
export interface SpawnAuthority {
  readonly principalId: string;
  /** The spawning agent, or null for an operator or service. */
  readonly agentId: string | null;
}

export interface SpawnReservation extends SpawnIdentityTuple {
  readonly spawnOperationId: string;
  readonly intendedAgentId: string;
}

export interface SpawnIdentityCoordinator {
  /** Verifies the spawner handle against live state. No writes. Throws UNAUTHORIZED. */
  verifySpawner(spawner: unknown): SpawnAuthority;
  /**
   * Re-verifies the spawner and reserves the tuple, authorized and idempotent. Synchronous so the
   * caller can run it in the same transaction as the dispatch claim; it joins an open transaction.
   */
  reserve(spawner: unknown, reservation: SpawnReservation): void;
  /**
   * Abandons the operation's intent after a DEFINITE host failure. Only a pending, unadopted
   * intent changes; an already adopted intent is left alone and reported as "adopted".
   */
  abandon(spawnOperationId: string, reason: string): "abandoned" | "adopted";
  /** The current managed binding of the intended agent for exactly this tuple, if enrolled. */
  managedBindingId(tuple: SpawnIdentityTuple, agentId: string): string | null;
}
