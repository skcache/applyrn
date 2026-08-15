# Security Policy

## Reporting a vulnerability

ApplyRN is personal infrastructure that is published as open source. If you find
a security issue, please report it privately before opening an issue:

- Email the maintainers (see the repository profile) with a subject line of
  `ApplyRN security report`.
- Do not include real secrets, real watchlist data, or personal application
  history in your report.

## What this project protects

ApplyRN intentionally separates public source code from private runtime state:

- **Public:** reusable engine, provider adapters, migrations, dashboard, tests,
  sanitized fixtures, example configuration, CI, documentation.
- **Private, never committed:** secrets (Telegram bot token, chat ID, API keys),
  the real company watchlist, personal application history, production D1 data,
  `.dev.vars` / `.env` files, database dumps, and any identifying personal data.

## Secret handling

- All secrets live in Cloudflare Worker secrets or local `.dev.vars` /
  `.env` files that are gitignored.
- `.env.example` / `.dev.vars.example` contain placeholders only.
- CI runs a secret-scanning step (gitleaks) on every push and pull request.
- Anything committed once may remain recoverable from git history. Never commit
  a real secret, even temporarily.

## Reporting scope

The following are in scope for this policy:

- Exfiltration or exposure of secrets, private watchlist data, or personal
  application history via the repository, the Worker, or the dashboard.
- Authorization bypass in the dashboard or Worker API.
- Data integrity issues that cause duplicate or lost job notifications.

Out of scope: abuse of the public job-board APIs that ApplyRN consumes, and
vulnerabilities in upstream dependencies (report those upstream).
