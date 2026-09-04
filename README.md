# Refund Triage Console

Internal console that replaces manual Shopify refund handling: idempotent
webhook ingest, an exactly-once refund ledger, an LLM eligibility decision
grounded in a policy knowledge base, and a review queue / reconciliation UI.

Live: **[nysonian-task.vercel.app](https://nysonian-task.vercel.app)**

See [DIAGRAMS.md](DIAGRAMS.md) for flow diagrams, [DECISIONS.md](DECISIONS.md)
for the architectural decisions and trade-offs behind this build, and
[AI_USAGE.md](AI_USAGE.md) for how AI tools were used throughout.

## Status

Stages 0–8 complete: idempotent ingest, the workflow engine, the policy
knowledge base + retrieval, the LLM eligibility decision, the console UI,
a retrieval evaluation harness, a full concurrency/replay verification pass
(against both local dev and the deployed Vercel URL — see
[`eval/`](eval/)), and deployment itself.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL, MONGODB_URI, and the Azure AI Foundry vars
npm run db:migrate
npm run seed:policies         # embeds and upserts the 15 docs in content/policies/ — costs real API calls, run once
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

See [`.env.example`](.env.example):

- `DATABASE_URL` — Neon Postgres connection string.
- `MONGODB_URI` — MongoDB Atlas connection string. If the `mongodb+srv://`
  form fails locally with `querySrv ECONNREFUSED` (seen on some Windows
  dev machines), use Atlas's non-SRV "standard connection string" instead.
- `AZURE_OPENAI_ENDPOINT` (base endpoint only, e.g.
  `https://<project>.services.ai.azure.com` — no path suffix),
  `AZURE_OPENAI_API_KEY` — Azure AI Foundry credentials.
- `AZURE_OPENAI_CHAT_DEPLOYMENT` — deployment name for the
  `gpt-4o-mini`-equivalent chat model (eligibility decisions).
- `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` — deployment name for the
  `text-embedding-3-small`-equivalent embedding model (policy retrieval).

The same four Azure vars plus `DATABASE_URL`/`MONGODB_URI` are also set in
Vercel's project settings for the deployed app above — pointed at the same
Neon/Atlas instances as local dev, not a separate environment.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Next.js dev server. |
| `npm run build` / `npm run start` | Production build / run it. |
| `npm run lint` | ESLint. |
| `npm run db:migrate` | Apply `db/migrations/*.sql` (tracked in `schema_migrations`, safe to re-run). |
| `npm run db:reset` | Drop and recreate the Postgres schema; clear Mongo's `decision_log` (the `policies` collection is preserved — it's seeded knowledge, not per-run test data). |
| `npm run seed:events` | Regenerate `events.ndjson` from `scripts/seed.mjs`'s deterministic PRNG (already committed — only needed if you want to confirm it's reproducible). |
| `npm run seed:policies` | Embed and upsert `content/policies/*.json` into Mongo; best-effort creates an Atlas Vector Search index (falls back to brute-force cosine in Node either way — see [DECISIONS.md](DECISIONS.md)). |
| `npm run eval:retrieval` | Run the retrieval evaluation (15 hand-written scenarios, hit@5 / precision@1) against live Mongo/Azure; writes [`eval/retrieval-results.md`](eval/retrieval-results.md). |
| `npm run verify` | Live end-to-end checks (idempotent ingest, workflow concurrency guarantees, retrieval exclusion, console API contract) against a running dev server — see `scripts/verify.mjs`'s header comment for the full phase list. |

## Running the full replay / acceptance checks

The six acceptance checks from the original spec (idempotent ingest,
nothing left stuck, no over-refund, correct bad-event classification,
double-replay is a no-op, sequential vs. 8-way-parallel replay agree) are
implemented as three sub-phases of `scripts/verify.mjs`, each independently
re-runnable:

```bash
npm run dev   # terminal 1

# terminal 2 — each of these can be re-run on its own without repeating
# the others; the first and third reset the database, the second doesn't.
node --env-file=.env.local scripts/verify.mjs replay-seq1     # reset + one sequential pass, checks 1-4
node --env-file=.env.local scripts/verify.mjs replay-seq2     # a second sequential pass, check 5
node --env-file=.env.local scripts/verify.mjs replay-parallel # reset + 8-way concurrent pass, check 6
```

Each pass replays the full committed `events.ndjson` (787 events,
including the 5 deliberately-malformed/unfulfillable ones and the
exact-duplicate lines the generator injects) and is dominated by real Azure
LLM latency on every `refund.requested` event — expect 20–30+ minutes per
sequential pass. Point at the deployed app instead of localhost with
`BASE=https://nysonian-task.vercel.app` prefixed on the same commands (both
share the same database, so this replays and verifies against the exact
environment the app is actually graded on). Results from both are recorded
in [`eval/replay-verification-results.md`](eval/replay-verification-results.md).

## Project structure

```
app/                    Next.js App Router — pages + API routes
  api/webhooks/orders/   ingest endpoint
  api/refunds/           queue, detail, approve, reject
  api/reconciliation/    reconciliation data
components/             console UI (review queue, reconciliation, shared shadcn/ui primitives)
lib/
  db/                    Postgres (Neon) and Mongo client wrappers
  workflow/              the state machine (advance.ts) and the LLM decision step (decide.ts)
  retrieval/             policy retrieval (embedding search + superseded-doc exclusion)
  ai/                    Azure AI Foundry client
  money.ts               single source of truth for dollars <-> integer minor units
db/                      SQL migrations, reset/migrate scripts
content/policies/        the 15 policy documents (source of truth; seeded into Mongo)
scripts/                 seed data generator, policy seeder, retrieval eval, live verification
eval/                    committed, reproducible output from eval:retrieval and the replay verification
```
