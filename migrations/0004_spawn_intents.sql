-- Durable spawn intents: the host tuple a Sideband-initiated spawn is expected to produce,
-- reserved BEFORE any host I/O. Additive over 0001; its parent and tuple checks read the
-- identity tables from 0003, which must already exist. Applied once through the
-- schema_migrations ledger by the spawn-intent module, not by core open.

CREATE TABLE IF NOT EXISTS identity_spawn_intents (
  spawn_operation_id TEXT PRIMARY KEY,
  host_session_id TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  intended_agent_id TEXT NOT NULL,
  -- Derived from the authenticated spawner, never from a request or model output.
  parent_agent_id TEXT REFERENCES agents(agent_id),
  spawner_principal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'adopted', 'abandoned')),
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  adopted_at TEXT,
  abandoned_at TEXT,
  UNIQUE (adapter, host_instance_id, external_id),
  CHECK ((status = 'adopted') = (adopted_at IS NOT NULL)),
  CHECK ((status = 'abandoned') = (abandoned_at IS NOT NULL))
);

-- At most one in-flight spawn per agent per host.
CREATE UNIQUE INDEX IF NOT EXISTS identity_spawn_intents_pending_agent_idx
  ON identity_spawn_intents(intended_agent_id, adapter, host_instance_id)
  WHERE status = 'pending';

-- Intents are never deleted: an abandoned tuple stays burned because the host may have created it.
CREATE TRIGGER IF NOT EXISTS identity_spawn_intents_no_delete
BEFORE DELETE ON identity_spawn_intents
BEGIN
  SELECT RAISE(ABORT, 'spawn intents are permanent');
END;

-- Identity fields are fixed at reservation; only pending intents may change status, once.
CREATE TRIGGER IF NOT EXISTS identity_spawn_intents_immutable
BEFORE UPDATE ON identity_spawn_intents
WHEN NEW.spawn_operation_id IS NOT OLD.spawn_operation_id
  OR NEW.host_session_id IS NOT OLD.host_session_id
  OR NEW.adapter IS NOT OLD.adapter
  OR NEW.host_instance_id IS NOT OLD.host_instance_id
  OR NEW.external_id IS NOT OLD.external_id
  OR NEW.intended_agent_id IS NOT OLD.intended_agent_id
  OR NEW.parent_agent_id IS NOT OLD.parent_agent_id
  OR NEW.spawner_principal_id IS NOT OLD.spawner_principal_id
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'spawn intent is immutable');
END;
