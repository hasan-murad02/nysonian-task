# Concurrency + replay verification (Stage 7)

Run: 2026-09-04, via `node --env-file=.env.local scripts/verify.mjs replay-seq1`, then
`replay-seq2`, then `replay-parallel` — each against a running `npm run dev` and the
committed `events.ndjson` (787 events, including the 5 deliberately-injected bad
`refund.requested` events and the exact-duplicate lines `seed.mjs` re-inserts ~12% of
the time).

Each sub-phase was run separately rather than as one monolithic pass — a single full
sequential replay took long enough (dominated by a real Azure LLM call on every
`refund.requested` event) that a single ~30–60 minute script invocation risked losing
already-completed work to an unrelated timeout on a later step. `replay-seq2` and
`replay-parallel` are independently re-runnable without repeating `replay-seq1`'s reset
and first pass.

## Results

| # | Check | Sub-phase | Result |
|---|---|---|---|
| 1 | Every `event_id` appears in `raw_events` exactly once | `replay-seq1` | ✓ pass |
| 2 | Nothing stuck in `pending_order` except `ord_9999` | `replay-seq1` | ✓ pass |
| 3 | No order refunded beyond its captured amount (sequential) | `replay-seq1` | ✓ pass |
| 4 | Exactly 2 `raw_events` rejected (schema-invalid) | `replay-seq1` | ✓ pass |
| 4 | Exactly 3 `workflow_runs` rows for `ord_9999`, all `pending_order` | `replay-seq1` | ✓ pass |
| 5 | A second full sequential replay of the same file is a true no-op | `replay-seq2` | ✓ pass |
| 6 | No duplicate `event_id` rows under real 8-way concurrent replay | `replay-parallel` | ✓ pass |
| 6 | No order refunded beyond its captured amount under real 8-way concurrent replay | `replay-parallel` | ✓ pass |

**8/8 assertions passed. Zero bugs found** — no `fix:` commit was needed for this stage,
per PLAN.md's own instruction to only commit fixes for bugs actually discovered here,
not to manufacture one.

One informational note logged by the parallel pass (not a failure): the auto-approve vs.
review split can differ slightly between the sequential and parallel passes, since each
refund makes a real, non-deterministic LLM call rather than following a fixed function —
the hard guarantees above (never a duplicate, never an over-refund) are what must be
identical between passes, and were.
