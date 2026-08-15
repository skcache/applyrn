# ApplyRN Open-Source Boundary

**Hard rule: this repository is public. Anything committed once may remain
recoverable from git history. When in doubt, leave it out.**

ApplyRN is published as open source. The entire codebase is reusable by any
developer who clones it, supplies their own configuration and secrets, and
runs their own instance. The repository must contain **zero** hard-coded
knowledge of the owner's identity or recruiting profile.

This document is the contract. Read it before committing anything.

## Public repository (safe to commit)

- Reusable engine and domain logic
- Provider adapters (Greenhouse, Ashby, Lever, future custom adapters)
- Normalized domain types
- D1 migrations
- Scheduler / sharding implementation
- Telegram client code
- Dashboard code
- Sanitized fixtures and synthetic test data
- Example configuration (`.env.example`, `.dev.vars.example`, example
  watchlist files with fake companies)
- Documentation, README, SECURITY, CONTRIBUTING
- CI configuration

## Private runtime state (never commit)

- Real Telegram bot tokens
- Real Telegram chat IDs
- Cloudflare secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
  every Worker secret)
- API keys and cookies / authenticated sessions
- Real private ATS credentials
- The owner's actual company watchlist
- Personal application history (jobs applied to, saved, ignored)
- OA / interview / rejection outcomes
- Private recruiting notes
- Resume-derived private matching configuration
- Citizenship / work authorization answers
- Private contact information or unnecessary PII
- Production D1 dumps
- Authenticated or private source responses

## Never, even temporarily

> Never use a real secret or personal value temporarily with the intention of
> removing it later. Assume anything committed once may remain recoverable
> from git history.

This includes: pasting a real board token into a fixture "just for a test",
committing a real `.env` "just to debug", or adding the real watchlist "just
to try it locally". It has to be private from commit one, or it never touches
the repo.

## Local storage layout

Private values live in gitignored locations:

| Path                        | Purpose                                          |
| --------------------------- | ------------------------------------------------ |
| `apps/worker/.dev.vars`     | local Worker secrets (gitignored)                |
| `.env`                      | local env files (gitignored)                     |
| `data/private/`             | real watchlist, recruiting history (gitignored)  |
| `config/private/`           | private config, real matching rules (gitignored) |
| `production-dumps/`         | D1 export dumps (gitignored)                     |
| `engineering-notebook.html` | local engineering notebook (gitignored)          |

Production secrets are stored as Cloudflare Worker secrets, never in the
repository. Cloudflare explicitly recommends keeping `.dev.vars` and `.env`
files out of git; this repository enforces that with `.gitignore` rules and a
CI secret scan (gitleaks).

## Enforcement

1. `.gitignore` covers all private paths and file variants.
2. CI runs a secret scan (gitleaks) on every push and pull request.
3. Code review checks fixtures for real data: every fixture uses synthetic
   companies, synthetic tokens, synthetic people.
4. The engineering notebook (local-only) records any boundary decision.

## Example: is this fixture OK?

| Fixture content                                                                  | Verdict             |
| -------------------------------------------------------------------------------- | ------------------- |
| `"boardToken": "example-ai"`, company `Example AI`, job titles like "SWE Intern" | Safe, synthetic     |
| A real company's real Greenhouse board token and real open roles                 | Leak, do not commit |
| Real chat ID `123456789`                                                         | Leak, do not commit |
| Synthetic chat ID `000000000` in a test fixture                                  | Safe                |

If you are unsure, leave the value out and use a placeholder.
