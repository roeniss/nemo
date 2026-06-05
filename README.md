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

CI deploys automatically on push to `main` (`.github/workflows/deploy.yml`). Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Optional GitHub **variable** `VITE_TURNSTILE_SITEKEY` (see Bot protection below).

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

## Bot protection (Cloudflare Turnstile)

Login is protected by [Turnstile](https://developers.cloudflare.com/turnstile/).
It is **enforced only when configured**, so the app keeps working before keys are
set up. To enable it:

1. Cloudflare dashboard → Turnstile → add a widget for `memo.roeni.ss`. Copy the
   **site key** (public) and **secret key**.
2. Set the secret as a Worker secret:
   ```bash
   npx wrangler secret put TURNSTILE_SECRET
   ```
3. Expose the site key to the build — add a GitHub Actions **variable** (not secret)
   named `VITE_TURNSTILE_SITEKEY` (Settings → Secrets and variables → Actions →
   Variables), then re-run the deploy.

Local dev: put `VITE_TURNSTILE_SITEKEY=1x00000000000000000000AA` (Cloudflare's
"always passes" test key) in `.env.local` to render the widget; leave
`TURNSTILE_SECRET` unset so the worker skips verification offline.

## Backup / recovery (D1 Time Travel)

D1 keeps an automatic point-in-time history for the last ~30 days — no setup
or export needed. If memos are lost or corrupted, restore the database:

```bash
# see available restore points (bookmarks)
npx wrangler d1 time-travel info quick-memo-db --remote

# restore to a timestamp or bookmark
npx wrangler d1 time-travel restore quick-memo-db --remote --timestamp="2026-06-05T00:00:00Z"
```
