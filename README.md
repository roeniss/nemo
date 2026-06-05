# quick-memo

A minimal velog-style markdown memo app — left editor / right preview. Single Cloudflare Worker + D1. ~$0 to run.

## Stack
- **Deploy**: Cloudflare Worker + Static Assets, D1 (SQLite), domain `memo.roeni.ss`
- **Build**: Vite + Preact + TS, Hono API, `marked`, JWT cookie auth

## Local development
```bash
npm install

# Create the D1 database (once) → put the printed database_id into wrangler.jsonc
npx wrangler d1 create quick-memo-db

# Apply the schema (local)
npm run db:local

npm run dev          # http://localhost:5173
```
Local credentials live in `.dev.vars` (AUTH_USER / AUTH_PASS / JWT_SECRET).

## Deploy

CI deploys automatically on push to `main` (`.github/workflows/deploy.yml`). Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

Manual deploy from your machine:
```bash
# Register production secrets (once)
npx wrangler secret put AUTH_USER
npx wrangler secret put AUTH_PASS
npx wrangler secret put JWT_SECRET

# Apply the schema to the remote D1 (once)
npm run db:remote

npm run deploy
```
The `memo.roeni.ss` custom domain is wired via the `routes` (custom_domain) entry in `wrangler.jsonc` — the `roeni.ss` zone must be on the same Cloudflare account.

## Login lockout recovery (circuit breaker)

After 10 failed logins the app locks itself (`auth_state.locked = 1`) and rejects
**every** login — even with the correct password — until it is manually reset.
Flip the breaker back on:

```bash
npx wrangler d1 execute quick-memo-db --remote --command "UPDATE auth_state SET locked = 0, failed_count = 0 WHERE id = 1;"
```

(Or run the same `UPDATE` in the Cloudflare dashboard → D1 → quick-memo-db console.)

## Backup / recovery (D1 Time Travel)

D1 keeps an automatic point-in-time history for the last ~30 days — no setup
or export needed. If memos are lost or corrupted, restore the database:

```bash
# see available restore points (bookmarks)
npx wrangler d1 time-travel info quick-memo-db --remote

# restore to a timestamp or bookmark
npx wrangler d1 time-travel restore quick-memo-db --remote --timestamp="2026-06-05T00:00:00Z"
```
