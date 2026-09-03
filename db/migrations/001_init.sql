-- Money columns are bigint minor units (cents). Idempotency is enforced via
-- UNIQUE(raw_events.event_id), UNIQUE(workflow_runs.event_id), and
-- UNIQUE(ledger_entries.workflow_run_id) — not app-level check-then-write.

CREATE TABLE IF NOT EXISTS orders (
  order_id text PRIMARY KEY,
  currency text,
  subtotal_amount bigint,
  shipping_amount bigint,
  tax_amount bigint,
  captured_amount bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_events (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'stored'
    CHECK (status IN ('stored', 'rejected')),
  error text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  order_id text NOT NULL,
  requested_amount bigint NOT NULL CHECK (requested_amount > 0),
  reason text,
  status text NOT NULL DEFAULT 'pending_order' CHECK (status IN (
    'pending_order', 'loading_order', 'checking_eligibility', 'deciding',
    'issuing_refund', 'notifying', 'completed',
    'review_pending', 'rejected', 'failed'
  )),
  decision text CHECK (decision IS NULL OR decision IN ('auto_approve', 'review')),
  citation_ids jsonb,
  confidence numeric(3, 2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  result jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_order_id ON workflow_runs (order_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs (status);

CREATE TABLE IF NOT EXISTS workflow_step_log (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES workflow_runs (id),
  step text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_workflow_step_log_run_id ON workflow_step_log (run_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY,
  workflow_run_id bigint NOT NULL UNIQUE REFERENCES workflow_runs (id),
  order_id text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_order_id ON ledger_entries (order_id);

-- RLS guards against any non-owner role touching these tables (a future
-- reporting role, or Supabase's anon/authenticated roles if ever pointed
-- here) — this app's own connection is the table owner, so it stays
-- unaffected. No FORCE, no policies needed: the owner keeps full access
-- by Postgres default, every other role is denied by default.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_step_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON orders FROM PUBLIC;
REVOKE ALL ON raw_events FROM PUBLIC;
REVOKE ALL ON workflow_runs FROM PUBLIC;
REVOKE ALL ON workflow_step_log FROM PUBLIC;
REVOKE ALL ON ledger_entries FROM PUBLIC;
