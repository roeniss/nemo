CREATE TABLE IF NOT EXISTS memos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memos_updated_at ON memos (updated_at DESC);

-- Login circuit breaker: after 10 failed logins, `locked` flips to 1 and the
-- login system stays disabled until manually reset:
--   UPDATE auth_state SET locked = 0, failed_count = 0 WHERE id = 1;
CREATE TABLE IF NOT EXISTS auth_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO auth_state (id) VALUES (1);
