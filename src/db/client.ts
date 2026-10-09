import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Which timezone a "day" of query stats follows. Checked here because it is placed inside SQL text.
const timezone = process.env.STATS_TIMEZONE?.trim() || "Asia/Manila";
if (!/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
  throw new Error("STATS_TIMEZONE must be a timezone name such as Asia/Manila");
}
export const STATS_TIMEZONE = timezone;

export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per signed-in user (Firebase Auth uid). Passwords live in Firebase, never here.
CREATE TABLE IF NOT EXISTS clients (
  uid TEXT PRIMARY KEY,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS instances (
  id UUID PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  port INT UNIQUE,
  name TEXT,
  product_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'failed', 'deleting')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- name is the label for whoever manages the instance; product_name is what the assistant calls itself
ALTER TABLE instances ADD COLUMN IF NOT EXISTS name TEXT;

-- status is the only channel between the management API and the control agent:
-- 'pending' and 'deleting' are the agent's to-do signals, 'active' and 'failed' are its results.
-- Rows that existed before this column were provisioned by hand, hence the 'active' default.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('pending', 'active', 'failed', 'deleting'));
ALTER TABLE instances ADD COLUMN IF NOT EXISTS error_message TEXT;

-- the agent assigns the port while provisioning
ALTER TABLE instances ALTER COLUMN port DROP NOT NULL;

CREATE INDEX IF NOT EXISTS instances_owner_idx ON instances (owner_uid);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- at most one live version of a document per instance
CREATE UNIQUE INDEX IF NOT EXISTS documents_ready_source_idx
  ON documents (instance_id, source) WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS documents_instance_idx ON documents (instance_id);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  heading_path TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding VECTOR(768) NOT NULL
);

-- No ANN index on purpose: instances share this table, and an approximate index
-- filters by instance_id after the search, which can starve a small instance of results.
CREATE INDEX IF NOT EXISTS chunks_instance_idx ON chunks (instance_id);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id);

-- How many questions each instance answered per day
CREATE TABLE IF NOT EXISTS query_counts (
  instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id, day)
);
`;
