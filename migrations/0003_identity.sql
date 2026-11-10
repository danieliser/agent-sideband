PRAGMA foreign_keys = ON;

-- Host-attested agent identity and credentials.
-- Additive: depends only on the agents and bindings tables from 0001.
-- Every statement is idempotent so the migration can be applied on each open.
-- Raw tokens are never stored; token_hash holds a SHA-256 digest.

CREATE TABLE IF NOT EXISTS identity_connectors (
  connector_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  allowed_agent_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  expires_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (adapter, host_instance_id)
);

CREATE TABLE IF NOT EXISTS identity_principals (
  principal_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id),
  access_state TEXT NOT NULL CHECK (access_state IN ('active', 'revoked')),
  access_epoch INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT,
  revoke_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per natural host tuple. The tuple maps to exactly one logical agent,
-- and one agent holds at most one session per adapter host instance.
CREATE TABLE IF NOT EXISTS identity_host_sessions (
  host_session_id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES identity_connectors(connector_id),
  adapter TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
  parent_agent_id TEXT REFERENCES agents(agent_id),
  provider_session_id TEXT NOT NULL,
  host_epoch TEXT NOT NULL,
  binding_id TEXT NOT NULL REFERENCES bindings(binding_id),
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'offline')),
  lease_expires_at TEXT NOT NULL,
  offline_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (adapter, host_instance_id, external_id),
  UNIQUE (agent_id, adapter, host_instance_id)
);

CREATE TABLE IF NOT EXISTS identity_credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
  host_session_id TEXT NOT NULL REFERENCES identity_host_sessions(host_session_id),
  binding_id TEXT NOT NULL REFERENCES bindings(binding_id),
  generation INTEGER NOT NULL,
  access_epoch INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  grants_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS identity_credentials_session_idx
  ON identity_credentials(host_session_id, revoked_at);
CREATE INDEX IF NOT EXISTS identity_credentials_principal_idx
  ON identity_credentials(principal_id, revoked_at);

-- Idempotency ledger for provision and rotate. The raw credential is never
-- recoverable from it; a replay reports the already-issued credential ids.
CREATE TABLE IF NOT EXISTS identity_operations (
  principal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  host_session_id TEXT,
  credential_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, kind, idempotency_key)
);

-- Durable schedule authority. Independent of tool-token expiry: a row stays
-- valid until explicitly revoked, even after every credential has lapsed.
CREATE TABLE IF NOT EXISTS identity_schedule_grants (
  grant_id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
  target_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  kind TEXT NOT NULL CHECK (kind IN ('self', 'child', 'explicit')),
  epoch INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT,
  revoke_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_principal_id, target_agent_id)
);
