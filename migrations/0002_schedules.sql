-- Durable schedules and prepared host requests. Additive over 0001; applied once through the
-- schema_migrations ledger.

CREATE TABLE IF NOT EXISTS schedules (
  schedule_id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  -- Null for operator-owned schedules, which have no owning agent.
  owner_agent_id TEXT REFERENCES agents(agent_id),
  target_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  -- Authority pinned at acceptance by the trusted authorizer and re-checked at every dispatch.
  grant_id TEXT,
  grant_epoch INTEGER NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  context_json TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('at', 'interval', 'cron', 'event')),
  trigger_json TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('wake', 'context', 'both')),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'blocked', 'suspended')),
  status_reason TEXT,
  next_due_at TEXT,
  accepted_at TEXT NOT NULL,
  cancelled_at TEXT,
  last_occurrence_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status, next_due_at);
CREATE INDEX IF NOT EXISTS schedules_event ON schedules(owner_principal_id, trigger_type, status);

CREATE TABLE IF NOT EXISTS schedule_idempotency (
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'cancel')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS schedule_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id),
  occurrence_key TEXT NOT NULL,
  nominal_due_at TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'dispatching', 'host_accepted', 'host_adopted', 'observed',
    'blocked', 'indeterminate', 'cancelled', 'failed'
  )),
  message_id TEXT,
  operation_id TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  claim_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  skipped_slots INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  error_code TEXT,
  error_message TEXT,
  -- Persisted UTC retry instant for retryable blocks and definitive no-effect host failures.
  retry_at TEXT,
  -- Increments only after a definitive no-effect failure; selects a fresh host operation key.
  dispatch_attempt INTEGER NOT NULL DEFAULT 0,
  -- Set by the fenced dispatch authorization. Cancellation before it suppresses the effect.
  committed_at TEXT,
  binding_id TEXT,
  binding_generation INTEGER,
  UNIQUE (schedule_id, occurrence_key)
);

CREATE INDEX IF NOT EXISTS schedule_occurrences_due ON schedule_occurrences(state, nominal_due_at);

CREATE TABLE IF NOT EXISTS schedule_event_ingress (
  principal_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  matched_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, event_id)
);

-- Exact host request per operation leg, written before host I/O. Replay resends request_json
-- unchanged, and only when the adapter declared it replay-safe.
CREATE TABLE IF NOT EXISTS host_prepared_requests (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  leg TEXT NOT NULL CHECK (leg IN ('wake', 'context')),
  adapter TEXT NOT NULL,
  binding_id TEXT NOT NULL REFERENCES bindings(binding_id),
  protocol_version INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  replay_safe INTEGER NOT NULL CHECK (replay_safe IN (0, 1)),
  receipt_stage TEXT,
  receipt_id TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, leg)
);
