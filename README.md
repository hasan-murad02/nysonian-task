# Refund Triage Console

Internal console that replaces manual Shopify refund handling: idempotent
webhook ingest, an exactly-once refund ledger, an LLM eligibility decision
grounded in a policy knowledge base, and a review queue / reconciliation UI.

See [PLAN.md](PLAN.md) for the full build plan and [DIAGRAMS.md](DIAGRAMS.md)
for flow diagrams. `DECISIONS.md` and `AI_USAGE.md` will be added in a later
stage.

## Status

Stage 0 (scaffolding) only — no database, workflow, or UI logic yet.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL, MONGODB_URI, OPENAI_API_KEY
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

See [`.env.example`](.env.example):

- `DATABASE_URL` — Neon Postgres connection string.
- `MONGODB_URI` — MongoDB Atlas connection string.
- `OPENAI_API_KEY` — used for `gpt-4o-mini` (eligibility decisions) and
  `text-embedding-3-small` (policy retrieval).

## Scripts

Not yet added (migrations, seeding, replay, retrieval eval land in later
stages — this section will be filled in as they're built).
