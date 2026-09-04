# Decisions

## Idempotency

Every event first tries an insert into raw_events with a unique constraint on event_id. If the insert returns no row, the event is a duplicate and processing stops there. This is checked before any topic specific logic runs.

Two more guarantees on top of that. ledger_entries has a unique constraint on workflow_run_id, so a refund can only be issued once per run even if issueRefund is called twice. Every status change is a guarded UPDATE with a WHERE clause on the expected current status, so two concurrent calls on the same run cannot both succeed.

Over refund across two different runs on the same order is prevented by locking the order row with FOR UPDATE inside issueRefund. This makes the second run see the first run's committed ledger entry instead of a stale balance.

All of this was tested, not just assumed. A full sequential replay, a second replay of the same file, and an 8 way parallel replay were all run against local dev and against the deployed Vercel URL. All passed. Results are in eval/replay-verification-results.md.

## Postgres connections

Most queries use Neon's HTTP driver (`sql` from lib/db/postgres.ts). Each query is a plain HTTP request, no held open connection. A Pool is only used for migrations and for the FOR UPDATE lock in issueRefund, since those need a real session.

The reason for HTTP over a pooled connection everywhere is that Vercel functions are short lived and can run many at once. Each one holding its own pooled connection is how serverless apps run out of Postgres connections. This was proven out, not just assumed. The 8 way concurrent replay against the live Vercel deployment ran with zero connection errors.

## Postgres vs Mongo

Postgres holds orders, events, workflow runs, step logs, and the ledger. This data is relational, needs exact integer math, and needs real constraints and locks. Mongo holds the policy documents and the decision log. Policies are documents with an embedded vector each, which fits a document store well. The decision log is one flexible document per LLM call with no relations to enforce.

Nothing that decides whether money moves depends on Mongo. Mongo is read only lookup and write only logging, so it does not need Postgres level guarantees.

## Model provider

The spec says Claude or the OpenAI API. This uses Azure AI Foundry instead, through the same openai npm package pointed at an Azure endpoint rather than api.openai.com, calling an OpenAI compatible model deployment. Same client, same request shape, different host. Picked it because it was the account already available, not because of any feature Azure has that OpenAI does not.

## Notify failure vs double refund

issueRefund and notify are separate steps. The ledger row is written and committed before notify ever runs. notify checks that a ledger row already exists for the run and throws if not, but it never writes to ledger_entries itself. It only retries the notification, three attempts with backoff.

If all three attempts fail, the run status becomes failed. Only the status changes, the ledger is untouched. A failed run means the refund was issued but the customer was not confirmed notified, not that the refund did not happen. This was checked directly in the replay tests: every run that ended failed still had exactly one ledger row.

notify is not the only step that calls an external API. decide calls the model too, and it does not retry at all, on purpose, not by accident. One Azure call, and if it fails for any reason, network error, timeout, the model returning something that does not match the schema, that single failure sends the run to review_pending instead of trying again. The thinking is that notify failing and retrying is safe because the refund is already committed before notify runs, but decide failing means there is no answer yet, and retrying a model call that just failed inside a workflow that is already in progress felt like the wrong place to spend the time budget. Sending it to a human is a safe default either way. It has not been tested under a real Azure outage, so this is a judgment call, not a proven one.

## Excluding the old policy, and the real eval numbers

retrievePolicies filters out any policy with a non null superseded_by before ranking. The old 2023 return window policy is never compared against a query at all.

Running npm run eval:retrieval against real Mongo and Azure gives hit@5 of 15 out of 15 and precision@1 of 14 out of 15. The one miss is a query that mixes a missing item claim with high value language, where missing item policy narrowly outranked the expected fraud signals policy. Full results are in eval/retrieval-results.md.

The eval also checks what would happen without the filter. Run against the unfiltered set, the old 2023 policy actually outranks the current 2026 one on one of the two return window questions, 0.6838 vs 0.6737. So the filter is doing real work, not guarding against something that would have lost anyway.

## One thing that did not work

The review queue detail dialog had a real race condition. Open one refund, close the dialog before its data loads, open a different refund, and the first request could return late and overwrite the second refund's data on screen, while the dialog still showed the second refund's order id in the title. Approve and reject always acted on the correct id, but the displayed context could be wrong, which matters a lot for a review screen.

The cause was a plain fetch inside a useEffect with no way to know a newer request had replaced it. The fix was a ref based counter, each fetch checks if it is still the latest one before applying its result. This was reproduced with an injected network delay before the fix, confirmed broken, then confirmed fixed, and reproduced again afterward to confirm it stayed fixed.

What this actually taught me is that this bug was never really about the dialog. Any fetch that fires from a user clicking something, then updates state when it resolves, has this same problem, because nothing stops an older click's response from arriving after a newer one. It just happened to show up here first. Worth checking the same pattern anywhere else a click triggers a fetch, not treating this as a one off dialog bug.

## Dark mode and the retrieval test tab

Dark mode is wired up now using next-themes, which was already a dependency from the start but never connected to anything. The toggle needs to know if it is still on the server render or already on the client, and the usual way to check that is a useEffect that sets state on mount. That trips the same set state in effect lint rule the review console's loading state hit earlier in the build. Used useSyncExternalStore instead, which is the actual tool meant for this exact question, not a workaround.

The retrieval test tab lets anyone type a refund scenario, or pick from twelve suggested ones, and see which policies come back with real scores. It calls the same retrievePolicies function the real eligibility decision uses, through one new API route, so nothing about retrieval is reimplemented just for the UI. The suggested questions are the same ones scripts/eval-retrieval.mjs already scores, so trying them here is checking the same thing the committed eval numbers are about, not a different untested set.

## What was cut

Nothing from the original brief was cut outright. Every part of it got built: idempotent ingest, the workflow, retrieval with the old policy excluded and measured, the review queue and reconciliation console, the eval script, and the replay checks against both local and the deployed URL.

What is below under two hours is not cut scope, it is rough edges and things left unverified rather than dropped. No pagination, no rate limiting on the new retrieval test route, notify's retry numbers picked for simplicity rather than tuned, and the Atlas Vector Search index's success was never rechecked after seeding. None of these were part of what the spec asked for directly, they are just the honest list of what is not fully finished.

## What would be done with another two hours

Add basic rate limiting to the retrieval test endpoint. It is public and unauthenticated, same as the webhook, but it exists purely for someone to click around, so an accidental loop calling it repeatedly would burn real Azure calls for no reason.

Add pagination to the review queue and reconciliation tables. Both run unbounded queries right now, fine at current scale, not fine forever.

Tune the notify retry settings properly. Three attempts and 200ms backoff were picked to be simple and safely under the 60 second function limit, not because they were tested against real failure data.

Add auth to the whole console but since it was not required for this task in the current time frame, I skipped that