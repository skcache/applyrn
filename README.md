# ApplyRN

I'm testing to see if being fast lands me a j o b .

ApplyRN watches 154 company job boards (Greenhouse, Ashby, Lever, SmartRecruiters, Workday, Taleo) and pings you on Telegram within a couple minutes of a new role going up. It's a personal radar for internships and early-career jobs: you see it first, you apply first.

## Stack

TypeScript · Cloudflare Workers · D1 · React + Vite dashboard · Telegram Bot API · puppeteer-core (V2)

## How it works

1. **Detect** — a Cloudflare Worker polls every board on a rotating shard schedule, with two independent fallback triggers (GitHub Actions + cron-job.org) so a dead cron never means missed jobs. Relevance scoring keeps the phone quiet for anything outside your scope.
2. **Alert** — exactly one Telegram message per in-scope job: title, location, match reasons, APPLY NOW / DETAILS buttons. Nothing else ever pings you.
3. **Track** — the dashboard tape shows everything detected; mark statuses as you move through APPLIED → OA → INTERVIEW → OFFER.
4. **Apply (V2)** — optional local agent: approve an application from Telegram, the browser fills your factual fields from your profile, pauses on anything unknown or sensitive, shows you the full review, and submits only when you tap SUBMIT.

## Packages

- `apps/worker` — detection pipeline + HTTP API
- `apps/dashboard` — the daily surface (local)
- `apps/apply-cli` — `applyrn-apply`, human-supervised application runner (V2)
- `packages/adapters` — one adapter per ATS provider
- `packages/detection` / `relevance` — diffing + scope gates
- `packages/apply` — V2 profile mapping, session state machine, browser agent

## License

MIT
