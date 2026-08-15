# ApplyRN

**Find it early. Apply right now.**

ApplyRN is a low-latency upstream job detection system and personal recruiting
terminal. It watches canonical employer publishing surfaces (ATS job boards),
detects newly published roles within ~2 minutes of appearance, filters only
obvious mismatches, pushes relevant roles to Telegram, and records timing data
so you can measure whether faster applications improve outcomes.

This repository is the public, reusable core. It contains zero private data:
bring your own watchlist, secrets, and preferences (see
`OPEN_SOURCE_BOUNDARY.md`).

## Status

V0, under active development. The V0 roadmap is tracked in GitHub issues; the
engineering notebook (`engineering-notebook.html`, local-only) records the
architecture.

Currently built:

- Monorepo foundation (TypeScript, pnpm workspaces, Vitest, ESLint, Prettier,
  GitHub Actions CI)
- Core domain types (`NormalizedJob`, company config, D1 schema)
- Greenhouse adapter (public Job Board API) with fixtures and failure tests
- Baseline + idempotent detection state machine
- Telegram notification path with delivery persistence and retry

Planned next (see issues): Ashby and Lever adapters, two-minute scheduler and
sharding, deterministic relevance scoring, the dashboard, application
tracking, observability, and the production soak.

## How it works

```
Employer / ATS publishes role
        ↓
ApplyRN polls canonical source (target: every 120s)
        ↓
normalize
        ↓
dedupe
        ↓
broad deterministic relevance check
        ↓
persist (D1)
        ↓
Telegram alert
        ↓
you apply manually
```

## Repository layout

```
apps/
  worker/       Cloudflare Worker: scheduler, pollers, D1, HTTP API
  dashboard/    React + Vite dashboard (in progress)
packages/
  domain/       Provider-independent types and contracts
  adapters/     Provider adapters (greenhouse/, ashby/, lever/) + fixtures
  detection/    Baseline + dedupe + lifecycle state machine (pure logic)
  telegram/     Telegram client and message rendering
apps/worker/
  migrations/   D1 schema migrations
fixtures/       Synthetic example watchlist
```

## Getting started

Prerequisites: Node.js 22+, pnpm.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

### Local Worker development

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# fill in your own Telegram bot token and chat ID
pnpm --filter @applyrn/worker dev
```

The Worker runs with a local D1 database (`.wrangler` state is gitignored).
Example watchlist fixtures live in `fixtures/`; your real watchlist goes in
`data/private/` (gitignored, never committed).

### Configuration

See `.env.example` and `apps/worker/.dev.vars.example` for every supported
setting. All values are placeholders; replace them with your own.

## Security

- All secrets are Cloudflare Worker secrets or local gitignored files.
- CI runs a gitleaks secret scan on every push and PR.
- See `SECURITY.md` for reporting and `OPEN_SOURCE_BOUNDARY.md` for what may
  never be committed.

## License

MIT. See `LICENSE`.
