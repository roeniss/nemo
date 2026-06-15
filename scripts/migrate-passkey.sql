-- Migration: add WebAuthn/passkey support
-- Run with: wrangler d1 execute nemo-db --remote --file=./scripts/migrate-passkey.sql

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_id ON webauthn_credentials (credential_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
