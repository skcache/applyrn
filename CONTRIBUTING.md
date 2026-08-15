# Contributing to ApplyRN

Thanks for helping. ApplyRN is a low-latency job detection system: poll
canonical employer sources, normalize, dedupe, alert on Telegram, track
applications. Keep every contribution aligned with the PRD and the
open-source boundary.

## The open-source boundary (read this first)

This repository is public. Never commit real secrets or personal data. In short:

- **Public-safe:** engine code, adapters, migrations, dashboard, tests,
  sanitized fixtures, example config, docs, CI.
- **Never commit:** real bot tokens, chat IDs, Cloudflare secrets, API keys,
  the real watchlist, personal application history, production dumps,
  `.dev.vars` / `.env` files, or anything identifying an individual applicant.

If you are adding fixtures or examples, use synthetic data only. If a test
needs a "company", invent one (`Example AI`, `Infra Co`). Never paste a real
board token into a fixture.

## Engineering workflow

1. Read the engineering notebook (`engineering-notebook.html`, local-only) for
   the current architecture before making architectural changes.
2. Architectural changes (new services, storage, queues, auth boundaries,
   scraping strategy) go through the EDN Architecture Check and owner approval
   before implementation. See the `edn` skill.
3. Work from the issue dependency order. Every issue lists its dependencies.
4. Keep PRs small and reviewable. Each PR closes one issue.
5. Run tests before declaring an issue done:
   `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build`

## Development

```bash
pnpm install
pnpm dev            # dashboard + worker (local)
pnpm test           # vitest across packages
pnpm typecheck
pnpm lint
pnpm build
```

Local Worker development uses `wrangler dev` with a local D1 database. Local
secrets go in `apps/worker/.dev.vars` (gitignored). See `.env.example` for the
shape.

## Provider adapters

Every adapter must include:

- fixture payloads (synthetic)
- parser tests
- normalization tests
- malformed response test
- timeout test
- 429 test
- 5xx test

Provider-specific logic lives only inside its adapter directory. The core
engine never knows a provider's JSON shape.

## Tests

- Unit tests: Vitest, per package.
- Worker integration tests: Vitest pool with D1 (local, no network).
- Never assert against live production data in CI.

## Code style

- Prettier for formatting, ESLint (flat config) for linting.
- TypeScript strict mode.
- Timestamps are UTC ISO strings everywhere.
- No em dashes in copy; short lines; honest labels. No fake stats, no "AI
  slop" flourishes.

## Commit conventions

- Conventional commits: `feat(adapter):`, `fix(dedupe):`, `test(baseline):`.
- No generated files, no `node_modules`, no `*.sqlite`/`*.db` files, no
  `.env` variants, no notebook.
- Sweep stray `* 2.*` duplicate files before committing (known tooling quirk
  in this checkout).
