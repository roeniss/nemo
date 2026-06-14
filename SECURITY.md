# Security Policy

## Supported Versions

This is a single-maintainer personal project. Only the latest version deployed
from the `main` branch is supported — there are no tagged releases or backports.

| Version          | Supported |
| ---------------- | --------- |
| `main` (latest)  | ✅        |
| anything older   | ❌        |

## Reporting a Vulnerability

Please report security issues **privately** — do not open a public issue.

- Open a private advisory: <https://github.com/roeniss/nemo/security/advisories/new>
- Or email: roeniss2@gmail.com

Expect an initial response within a few days. As a hobby project maintained in
spare time, fixes are best-effort.

## Design notes

- Single-user app: one credential pair (`AUTH_USER` / `AUTH_PASS`) plus a signed
  JWT in an httpOnly, `Secure`, `SameSite=Lax` cookie. `AUTH_PASS` is stored as a
  salted **PBKDF2-HMAC-SHA256** hash (100k iterations — the Workers runtime cap),
  never plaintext — login
  compares in constant time and fails closed on a non-hash secret. Mint/rotate it
  with `scripts/hash-password.mjs` (see README → Deploy).
- Login is gated by Cloudflare Turnstile when `TURNSTILE_SECRET` is configured,
  which blocks automated/distributed brute-force without locking the owner out.
- Markdown is rendered with `marked`, then **sanitized with DOMPurify** before it
  is injected via `innerHTML`, so scripts/event-handlers in memo content cannot
  execute.
- File import is **client-side only**: a picked/dropped file's text is read in the
  browser and inserted into the editor — non-text (binary) files are rejected, and
  nothing is uploaded anywhere except, on save, the user's own authenticated memo
  store. Imported text renders through the same DOMPurify pipeline as typed/pasted
  content, so it carries no extra execution risk.
- A strict **Content-Security-Policy** (see `public/_headers`) is served on every
  document: no inline scripts, `object-src 'none'`, `frame-ancestors 'none'`,
  and an allowlist limited to self + Cloudflare Turnstile/Insights. Combined with
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS.
- Secrets live as Cloudflare Worker secrets and GitHub Actions secrets; they are
  never committed (`.dev.vars` is gitignored).
- CI (`.github/workflows/ci.yml`) runs the unit and Playwright e2e suites against
  an **ephemeral local worker** with throwaway credentials — production data and
  real secrets are never used in tests.
