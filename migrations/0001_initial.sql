PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
  agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  last_seen_at TEXT,
  last_signal TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  parent_agent_id TEXT,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, agent_id),
  FOREIGN KEY (team_id, parent_agent_id)
    REFERENCES team_members(team_id, agent_id)
);

CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  display_name TEXT,
  team_id TEXT REFERENCES teams(team_id),
  lead_agent_id TEXT REFERENCES agents(agent_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  from_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('agent', 'channel')),
  target_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  body TEXT NOT NULL,
  message_class TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  recipient_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'delivered', 'dead_letter')),
  consumer_id TEXT,
  claim_expires_at TEXT,
  receipt_id TEXT,
  ack_token_hash TEXT,
  delivered_at TEXT,
  PRIMARY KEY (message_id, recipient_agent_id)
);
CREATE INDEX IF NOT EXISTS deliveries_inbox_idx
  ON deliveries(recipient_agent_id, status, message_id);

CREATE TABLE IF NOT EXISTS claims (
  message_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, recipient_agent_id),
  FOREIGN KEY (message_id, recipient_agent_id)
    REFERENCES deliveries(message_id, recipient_agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS claims_expiry_idx ON claims(expires_at);

CREATE TABLE IF NOT EXISTS bindings (
  binding_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  adapter TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  provider_session_id TEXT,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  capabilities_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bindings_one_active_generation_idx
  ON bindings(agent_id, adapter, host_instance_id)
  WHERE active = 1;
CREATE INDEX IF NOT EXISTS bindings_agent_idx
  ON bindings(agent_id, active, adapter, binding_id);

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  adapter TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  binding_id TEXT REFERENCES bindings(binding_id),
  message_id TEXT REFERENCES messages(message_id),
  correlation_id TEXT,
  stage TEXT NOT NULL,
  dispatch_owner_id TEXT,
  dispatch_started_at TEXT,
  host_receipt_id TEXT,
  detail_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_id, kind, idempotency_key)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
