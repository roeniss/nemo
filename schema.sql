CREATE TABLE IF NOT EXISTS memos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memos_updated_at ON memos (updated_at DESC);
