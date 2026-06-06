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

- Single-user app: one hard-coded credential (`AUTH_USER` / `AUTH_PASS`) plus a
  signed JWT in an httpOnly, `Secure`, `SameSite=Lax` cookie.
- Login is gated by Cloudflare Turnstile when `TURNSTILE_SECRET` is configured,
  which blocks automated/distributed brute-force without locking the owner out.
- Markdown is rendered with `marked` and injected via `innerHTML`. Content is
  authored by the authenticated owner only — do not paste untrusted markdown.
- Secrets live as Cloudflare Worker secrets and GitHub Actions secrets; they are
  never committed (`.dev.vars` is gitignored).
