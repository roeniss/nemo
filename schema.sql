CREATE TABLE IF NOT EXISTS memos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  hidden_at INTEGER -- trashed memo permanently hidden from the trash view (row kept)
);

CREATE INDEX IF NOT EXISTS idx_memos_updated_at ON memos (updated_at DESC);

-- session-snapshot history: one row per preserved past state of a memo. A new
-- snapshot is written when a fresh editing session begins (see worker PUT).
CREATE TABLE IF NOT EXISTS memo_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memo_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL -- the source save's updated_at = the session's end time
);

CREATE INDEX IF NOT EXISTS idx_memo_versions ON memo_versions (memo_id, created_at DESC);

-- api tokens for the external integration surface (/api/ext/*, e.g. Siri).
-- Only the SHA-256 hash is stored; the plaintext is shown once at creation.
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER, -- stamped on each successful /api/ext/* call
  revoked_at INTEGER    -- soft-revoke: row kept, token stops authenticating
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash);
