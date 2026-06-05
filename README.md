# quick-memo

A minimal velog-style markdown memo app — left editor / right preview. Single Cloudflare Worker + D1. ~$0 to run.

## Stack
- **Deploy**: Cloudflare Worker + Static Assets, D1 (SQLite), domain `memo.roeni.ss`
- **Build**: Vite + React 19 + TS, Hono API, react-markdown, JWT cookie auth

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
