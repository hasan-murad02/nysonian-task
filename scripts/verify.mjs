// Live end-to-end verification against a running dev server and real
// Postgres/Mongo — no mocks, consistent with every other stage of this
// project. Mirrors PLAN.md's stage-by-stage acceptance checks.
//
// Usage (two terminals):
//   terminal 1: npm run dev
//   terminal 2: node --env-file=.env.local scripts/verify.mjs [phases...]
//
// Phases: ingest workflow retrieval review replay
//   (no args)  -> ingest, workflow, retrieval, review — fast, non-destructive,
//                 uses per-run-namespaced test data so re-running is always safe.
//   replay/all -> ALSO runs the full 786-event replay + PLAN.md's 6 acceptance
//                 checks. Slow (live LLM call per refund) and DESTRUCTIVE
//                 (resets the database first) — must be requested explicitly.
//
// Set BASE=http://localhost:PORT if the dev server isn't on 3000.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import dns from "node:dns";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { MongoClient } from "mongodb";

neonConfig.webSocketConstructor = ws;
// Same Windows-only DNS workaround as lib/db/mongo.ts / db/reset.mjs.
if (!process.env.VERCEL) dns.setServers(["1.1.1.1", "8.8.8.8"]);

const BASE = process.env.BASE ?? "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL;
const MONGODB_URI = process.env.MONGODB_URI;

if (!DATABASE_URL || !MONGODB_URI) {
  console.error("Missing DATABASE_URL/MONGODB_URI — run with: node --env-file=.env.local scripts/verify.mjs");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const mongoClient = new MongoClient(MONGODB_URI);
let mongoDb;

// Namespaces every fixture this run creates, so re-running the script twice
// in a row never collides with the previous run's event_ids/order_ids.
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------- harness --
const RESET = "\x1b[0m", GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m";
let pass = 0, fail = 0, info = 0;

function section(title, planRef) {
  console.log(`\n${BOLD}=== ${title}${planRef ? DIM + " (" + planRef + ")" + RESET + BOLD : ""} ===${RESET}`);
}
function explain(text) {
  console.log(`${DIM}${text}${RESET}`);
}
function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ${GREEN}✓${RESET} ${label}`);
  } else {
    fail++;
    console.log(`  ${RED}✗ ${label}${RESET}${detail ? `\n    ${RED}${detail}${RESET}` : ""}`);
  }
}
function note(label, detail) {
  info++;
  console.log(`  ${YELLOW}i${RESET} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function q(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}
async function postEvent(event) {
  const res = await fetch(`${BASE}/api/webhooks/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  return { status: res.status, body: await res.json() };
}
async function serverReachable() {
  try {
    const res = await fetch(`${BASE}/api/refunds/queue?status=review_pending`);
    return res.ok;
  } catch {
    return false;
  }
}
// Creates an order via the real webhook path (order.created + order.paid),
// captured_amount = dollars. Used as fixture setup, not itself the thing
// under test — phase 1 already verifies this exact path in isolation.
async function ensureFundedOrder(orderId, dollars) {
  await postEvent({ event_id: `${orderId}_oc`, topic: "order.created", occurred_at: "2026-09-04T00:00:00Z", payload: { order_id: orderId, currency: "USD", subtotal: dollars, shipping: 0, tax: 0 } });
  await postEvent({ event_id: `${orderId}_op`, topic: "order.paid", occurred_at: "2026-09-04T00:01:00Z", payload: { order_id: orderId, amount: dollars, currency: "USD" } });
  return orderId;
}

// -------------------------------------------------------- phase: ingest ---
async function phaseIngest() {
  section("1. Idempotent webhook ingest", "PLAN Stage 2");
  const orderA = `verify_${RUN}_a1`;

  explain("order.created should be accepted and stored, even though it will be replayed next.");
  const oc1 = await postEvent({ event_id: `${RUN}_oc_a1`, topic: "order.created", occurred_at: "2026-09-04T00:00:00Z", payload: { order_id: orderA, currency: "USD", subtotal: 90, shipping: 0, tax: 10 } });
  check("order.created stored", oc1.body.status === "stored", JSON.stringify(oc1.body));

  explain("Replaying the identical event_id must be recognized as a duplicate, not reprocessed — the UNIQUE(event_id) claim on raw_events is the app's core idempotency guarantee.");
  const oc1Again = await postEvent({ event_id: `${RUN}_oc_a1`, topic: "order.created", occurred_at: "2026-09-04T00:00:00Z", payload: { order_id: orderA, currency: "USD", subtotal: 90, shipping: 0, tax: 10 } });
  check("duplicate event_id -> {status:\"duplicate\"}", oc1Again.body.status === "duplicate", JSON.stringify(oc1Again.body));
  const rawCount = await q("SELECT count(*)::int c FROM raw_events WHERE event_id = $1", [`${RUN}_oc_a1`]);
  check("raw_events holds exactly one row for that event_id", rawCount[0].c === 1, `found ${rawCount[0].c}`);

  explain("order.paid should upsert captured_amount, converted to integer minor units (dollars * 100).");
  const op1 = await postEvent({ event_id: `${RUN}_op_a1`, topic: "order.paid", occurred_at: "2026-09-04T00:05:00Z", payload: { order_id: orderA, amount: 100, currency: "USD" } });
  check("order.paid stored", op1.body.status === "stored", JSON.stringify(op1.body));
  const orderRow = await q("SELECT captured_amount, currency FROM orders WHERE order_id = $1", [orderA]);
  check("captured_amount == 10000 ($100.00 in cents)", String(orderRow[0]?.captured_amount) === "10000", `got ${orderRow[0]?.captured_amount}`);

  explain("A refund.requested for an order that doesn't exist yet must still be accepted (not dropped) and parked in pending_order.");
  const ghost = `verify_${RUN}_ghost`;
  const rrGhost = await postEvent({ event_id: `${RUN}_rr_ghost`, topic: "refund.requested", occurred_at: "2026-09-04T00:10:00Z", payload: { order_id: ghost, refund_amount: 20, reason: "damaged" } });
  check("out-of-order refund.requested still accepted", rrGhost.body.status === "stored", JSON.stringify(rrGhost.body));
  let ghostRun = await q("SELECT status FROM workflow_runs WHERE event_id = $1", [`${RUN}_rr_ghost`]);
  check("parked run is in pending_order", ghostRun[0]?.status === "pending_order", `got ${ghostRun[0]?.status}`);

  explain("Once the missing order actually arrives, the parked run must re-drive itself — nobody re-sends the refund event.");
  await postEvent({ event_id: `${RUN}_oc_ghost`, topic: "order.created", occurred_at: "2026-09-04T00:15:00Z", payload: { order_id: ghost, currency: "USD", subtotal: 90, shipping: 0, tax: 10 } });
  await postEvent({ event_id: `${RUN}_op_ghost`, topic: "order.paid", occurred_at: "2026-09-04T00:16:00Z", payload: { order_id: ghost, amount: 100, currency: "USD" } });
  ghostRun = await q("SELECT status FROM workflow_runs WHERE event_id = $1", [`${RUN}_rr_ghost`]);
  check("parked run auto-advanced past pending_order once its order arrived", ghostRun[0]?.status !== "pending_order", `still ${ghostRun[0]?.status}`);

  explain("A refund_amount that isn't a number, with no order_id, is schema-invalid — reject before it ever becomes a workflow_runs row.");
  const badShape = await postEvent({ event_id: `${RUN}_bad_shape`, topic: "refund.requested", occurred_at: "2026-09-04T00:20:00Z", payload: { refund_amount: "NaN" } });
  check("schema-invalid payload rejected", badShape.body.status === "rejected", JSON.stringify(badShape.body));
  const badShapeRun = await q("SELECT count(*)::int c FROM workflow_runs WHERE event_id = $1", [`${RUN}_bad_shape`]);
  check("no workflow_runs row created for it", badShapeRun[0].c === 0, `found ${badShapeRun[0].c}`);

  explain("A negative refund_amount is a valid *number* (passes zod) but an invalid *value* — a different rejection path (\"junk amount\") than the schema check above.");
  const junk = await postEvent({ event_id: `${RUN}_junk`, topic: "refund.requested", occurred_at: "2026-09-04T00:21:00Z", payload: { order_id: orderA, refund_amount: -5, reason: "test" } });
  check("shape-valid junk value rejected with \"junk amount\"", junk.body.status === "rejected" && junk.body.error === "junk amount", JSON.stringify(junk.body));

  explain("Firing the exact same event_id twice at once must still land exactly one raw_events row — atomic under real concurrency, not just sequential retries.");
  const concurrentId = `${RUN}_concurrent`;
  const concurrentOrder = `verify_${RUN}_c1`;
  const [r1, r2] = await Promise.all([
    postEvent({ event_id: concurrentId, topic: "order.created", occurred_at: "2026-09-04T00:25:00Z", payload: { order_id: concurrentOrder, currency: "USD", subtotal: 50, shipping: 0, tax: 5 } }),
    postEvent({ event_id: concurrentId, topic: "order.created", occurred_at: "2026-09-04T00:25:00Z", payload: { order_id: concurrentOrder, currency: "USD", subtotal: 50, shipping: 0, tax: 5 } }),
  ]);
  const statuses = [r1.body.status, r2.body.status].sort();
  check("concurrent duplicate submission resolves to one stored + one duplicate", JSON.stringify(statuses) === JSON.stringify(["duplicate", "stored"]), JSON.stringify(statuses));

  return { orderA };
}

// ------------------------------------------------------ phase: workflow ---
async function phaseWorkflow(ctx) {
  section("2. Workflow engine — exactly-once refunds", "PLAN Stage 3");
  const orderA = ctx?.orderA ?? (await ensureFundedOrder(`verify_${RUN}_w1`, 100));

  explain("A refund larger than the order's remaining balance must be hard-rejected by checkEligibility BEFORE any LLM call — a plain arithmetic guardrail, not a policy judgment.");
  await postEvent({ event_id: `${RUN}_toolarge`, topic: "refund.requested", occurred_at: "2026-09-04T00:35:00Z", payload: { order_id: orderA, refund_amount: 9999, reason: "test overdraft" } });
  const [tooLargeRun] = await q(
    `SELECT wr.status, wr.decision, wsl.step, wsl.error
     FROM workflow_runs wr JOIN workflow_step_log wsl ON wsl.run_id = wr.id
     WHERE wr.event_id = $1 ORDER BY wsl.id DESC LIMIT 1`,
    [`${RUN}_toolarge`],
  );
  check("over-refund request lands on status=rejected", tooLargeRun?.status === "rejected", `got ${tooLargeRun?.status}`);
  check("rejection happened at checkEligibility, never reached the model", tooLargeRun?.step === "checkEligibility" && tooLargeRun?.decision === null, JSON.stringify(tooLargeRun));

  explain("Test fixture: insert a workflow_runs row directly at status=review_pending, bypassing the LLM entirely. This isolates the approve endpoint's own concurrency guard from the model's routing choice (covered separately in the retrieval phase).");
  const fixtureOrder = await ensureFundedOrder(`verify_${RUN}_w2`, 50);
  const [fixtureRun] = await q(
    `INSERT INTO workflow_runs (event_id, order_id, requested_amount, reason, status)
     VALUES ($1, $2, 1000, 'concurrency fixture', 'review_pending') RETURNING id`,
    [`${RUN}_fixture_concurrency`, fixtureOrder],
  );
  const [approveA, approveB] = await Promise.all([
    fetch(`${BASE}/api/refunds/${fixtureRun.id}/approve`, { method: "POST" }),
    fetch(`${BASE}/api/refunds/${fixtureRun.id}/approve`, { method: "POST" }),
  ]);
  const approveCodes = [approveA.status, approveB.status].sort();
  check("exactly one concurrent approve wins (200), the other is refused (409)", JSON.stringify(approveCodes) === JSON.stringify([200, 409]), JSON.stringify(approveCodes));
  const ledgerCount = await q("SELECT count(*)::int c FROM ledger_entries WHERE workflow_run_id = $1", [fixtureRun.id]);
  check("ledger_entries has exactly one row for that run — never two", ledgerCount[0].c === 1, `found ${ledgerCount[0].c}`);

  explain("sendNotification() fails ~15% of the time by design. Forcing 25 runs through review_pending -> approve makes at least one notify failure ~97.6% likely (1 - 0.85^25), without needing the full 786-event replay.");
  const notifyOrder = await ensureFundedOrder(`verify_${RUN}_notify`, 2500);
  const fixtureIds = [];
  for (let i = 0; i < 25; i++) {
    const [row] = await q(
      `INSERT INTO workflow_runs (event_id, order_id, requested_amount, reason, status)
       VALUES ($1, $2, 100, 'notify fixture', 'review_pending') RETURNING id`,
      [`${RUN}_notify_${i}`, notifyOrder],
    );
    fixtureIds.push(row.id);
  }
  await Promise.all(fixtureIds.map((id) => fetch(`${BASE}/api/refunds/${id}/approve`, { method: "POST" })));
  const notifyFailures = await q(
    "SELECT DISTINCT run_id FROM workflow_step_log WHERE step = 'notify' AND status = 'failed' AND run_id = ANY($1::bigint[])",
    [fixtureIds],
  );
  if (notifyFailures.length > 0) {
    note(`observed ${notifyFailures.length} real notify failure(s) in this batch of 25`);
    const failedRunIds = notifyFailures.map((r) => r.run_id);
    const ledgerForFailed = await q("SELECT workflow_run_id FROM ledger_entries WHERE workflow_run_id = ANY($1::bigint[])", [failedRunIds]);
    check("every run with a failed notify still has its ledger entry — the refund was issued, only the notification didn't confirm", ledgerForFailed.length === failedRunIds.length, `${ledgerForFailed.length}/${failedRunIds.length} have a ledger row`);
  } else {
    note("no notify failures landed in this batch of 25 (statistically ~2.4% chance) — re-run to try again if you want this check exercised");
  }
}

// ----------------------------------------------------- phase: retrieval ---
async function phaseRetrieval() {
  section("3. Policy retrieval & LLM decision", "PLAN Stage 4");

  explain("retrievePolicies() filters {superseded_by: null} before ranking — the dead 2023 return-window policy structurally cannot reach the model for ANY decision, ever. Deterministic and code-level, independent of model behavior.");
  const superseded = await mongoDb.collection("decision_log").find({ retrieved_policy_ids: "return-window-2023" }).toArray();
  check("return-window-2023 has never been retrieved for any decision", superseded.length === 0, `found ${superseded.length} decision_log entries citing it`);

  explain("A refund >= $500 should be escalated to human review per policy — a MODEL judgment call the LLM is instructed to make, not a code-level guardrail like the over-refund check. Reporting what actually happened, not asserting it.");
  const hvOrder = await ensureFundedOrder(`verify_${RUN}_hv`, 550);
  await postEvent({ event_id: `${RUN}_rr_hv`, topic: "refund.requested", occurred_at: "2026-09-04T00:42:00Z", payload: { order_id: hvOrder, refund_amount: 550, reason: "wrong size" } });
  const [hvRun] = await q("SELECT id, status, decision, citation_ids, confidence FROM workflow_runs WHERE event_id = $1", [`${RUN}_rr_hv`]);
  note(`$550 refund on a $550 order landed on status=${hvRun?.status}, decision=${hvRun?.decision}, confidence=${hvRun?.confidence}`, `citations: ${JSON.stringify(hvRun?.citation_ids)}`);

  explain("Every decision_log entry should carry a full audit trail: the retrieval query, which policies were retrieved, the exact prompts sent, and the raw model response.");
  const entry = await mongoDb.collection("decision_log").findOne({ run_id: String(hvRun?.id) });
  check(
    "decision_log entry has the full audit shape",
    !!entry && "query" in entry && "retrieved_policy_ids" in entry && "prompt" in entry && "raw_response" in entry,
    entry ? JSON.stringify(Object.keys(entry)) : "no entry found",
  );
}

// --------------------------------------------------------- phase: review ---
async function phaseReview() {
  section("5. Console API — review queue & reconciliation", "PLAN Stage 5");

  explain("The queue endpoint must return an array (possibly empty) for every one of the 10 CHECK-constraint status values, not just the ones with data.");
  const STATUSES = ["pending_order", "loading_order", "checking_eligibility", "deciding", "issuing_refund", "notifying", "completed", "review_pending", "rejected", "failed"];
  for (const status of STATUSES) {
    const res = await fetch(`${BASE}/api/refunds/queue?status=${status}`);
    const body = await res.json();
    check(`GET /api/refunds/queue?status=${status} -> 200 + runs[]`, res.ok && Array.isArray(body.runs), `status ${res.status}`);
  }

  explain("Test fixture: a fresh review_pending run to exercise the detail endpoint and the reject action end-to-end.");
  const rejOrder = await ensureFundedOrder(`verify_${RUN}_rej`, 40);
  const [rejFixture] = await q(
    `INSERT INTO workflow_runs (event_id, order_id, requested_amount, reason, status)
     VALUES ($1, $2, 1500, 'reject fixture', 'review_pending') RETURNING id`,
    [`${RUN}_reject_fixture`, rejOrder],
  );
  const detailRes = await fetch(`${BASE}/api/refunds/${rejFixture.id}`);
  const detail = await detailRes.json();
  check(
    "GET /api/refunds/:id returns run/order/steps/citations/modelReason",
    detailRes.ok && "run" in detail && "order" in detail && "steps" in detail && "citations" in detail && "modelReason" in detail,
    JSON.stringify(Object.keys(detail)),
  );

  const rejectRes = await fetch(`${BASE}/api/refunds/${rejFixture.id}/reject`, { method: "POST" });
  check("POST /api/refunds/:id/reject succeeds on a review_pending run", rejectRes.ok, `status ${rejectRes.status}`);
  const rejectAgain = await fetch(`${BASE}/api/refunds/${rejFixture.id}/reject`, { method: "POST" });
  check("rejecting an already-rejected run is refused with 409", rejectAgain.status === 409, `status ${rejectAgain.status}`);
  const ledgerAfterReject = await q("SELECT count(*)::int c FROM ledger_entries WHERE workflow_run_id = $1", [rejFixture.id]);
  check("a rejected run never wrote a ledger entry", ledgerAfterReject[0].c === 0, `found ${ledgerAfterReject[0].c}`);

  explain("Reconciliation must never show integrity_alarm — an order refunded beyond its captured amount should be structurally impossible given the guards checked in phase 2.");
  const reconRes = await fetch(`${BASE}/api/reconciliation`);
  const recon = await reconRes.json();
  const alarms = (recon.orders ?? []).filter((o) => o.flag === "integrity_alarm");
  check("GET /api/reconciliation -> 200, no integrity_alarm rows anywhere", reconRes.ok && alarms.length === 0, `found ${alarms.length} alarm(s): ${JSON.stringify(alarms)}`);
}

// --------------------------------------------------------- phase: replay ---
// Split into three independently-runnable sub-phases rather than one
// monolithic function. A full sequential pass over ~787 events is
// dominated by real Azure LLM latency on refund.requested events and can
// take 20-30+ minutes — long enough that a single all-in-one run risks
// losing already-completed, expensive work (an earlier reset + full
// sequential pass) to an unrelated timeout on the *next* step. Each
// sub-phase below can be re-run on its own without re-paying for the
// ones that already succeeded.
const EVENTS_FILE = "events.ndjson";

function resetAndMigrate() {
  execSync("npm run db:reset", { stdio: "inherit" });
  execSync("npm run db:migrate", { stdio: "inherit" });
}
function loadEventLines() {
  return readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
}
async function replaySequential(lines) {
  let i = 0;
  for (const line of lines) {
    await fetch(`${BASE}/api/webhooks/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: line });
    i++;
    if (i % 100 === 0) console.log(`  ...${i}/${lines.length}`);
  }
}
async function replayParallel(lines) {
  let i = 0;
  async function worker() {
    while (i < lines.length) {
      const line = lines[i++];
      await fetch(`${BASE}/api/webhooks/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: line });
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
}

// Sub-phase 1: reset, one full sequential pass, checks 1-4. Run this first
// — the other two sub-phases assume a DB already in this state.
async function phaseReplaySeq1() {
  section("4a. Sequential replay — checks 1-4", "PLAN Stage 7");
  console.log(`${YELLOW}This RESETS your database and replays ${EVENTS_FILE} once, sequentially.${RESET}`);
  console.log(`${YELLOW}Expect 20-30+ minutes — most refund.requested events trigger a real LLM call.${RESET}`);

  const lines = loadEventLines();
  resetAndMigrate();
  console.log(`\nSequential replay: ${lines.length} events...`);
  await replaySequential(lines);

  explain("Check 1 — every event_id appears in raw_events exactly once, even though the file itself contains deliberate exact-duplicate lines.");
  const dupes = await q("SELECT event_id FROM raw_events GROUP BY event_id HAVING count(*) > 1");
  check("no duplicate event_id rows", dupes.length === 0, `${dupes.length} duplicated`);

  explain("Check 2 — nothing is stuck waiting for an order that will actually arrive. ord_9999 is the one deliberate exception (see check 4).");
  const stuck = await q("SELECT id, order_id FROM workflow_runs WHERE status = 'pending_order' AND order_id != 'ord_9999'");
  check("nothing stuck in pending_order except ord_9999", stuck.length === 0, `${stuck.length} stuck: ${JSON.stringify(stuck.slice(0, 5))}`);

  explain("Check 3 — no order was ever refunded beyond what it captured, in exact integer cents, no float drift.");
  const overRefunded = await q(
    `SELECT o.order_id FROM orders o JOIN ledger_entries l ON l.order_id = o.order_id
     GROUP BY o.order_id, o.captured_amount HAVING COALESCE(SUM(l.amount),0) > o.captured_amount`,
  );
  check("no order refunded beyond its captured amount", overRefunded.length === 0, `${overRefunded.length} violations`);

  explain("Check 4 — of the 5 injected bad refund.requested events, exactly 2 are schema-invalid (rejected) and 3 are shape-valid but reference ord_9999, which never arrives.");
  const rejectedCount = await q("SELECT count(*)::int c FROM raw_events WHERE status = 'rejected'");
  check("exactly 2 raw_events rows rejected", rejectedCount[0].c === 2, `got ${rejectedCount[0].c}`);
  const ghost9999 = await q("SELECT status FROM workflow_runs WHERE order_id = 'ord_9999'");
  check("exactly 3 workflow_runs rows for ord_9999, all pending_order", ghost9999.length === 3 && ghost9999.every((r) => r.status === "pending_order"), JSON.stringify(ghost9999));

  console.log(`\n${DIM}Next: run \`replay-seq2\` (no reset — builds on this DB state) for check 5.${RESET}`);
}

// Sub-phase 2: assumes seq1 already ran against the current DB. Replays
// the same file again, unchanged, and confirms nothing moved — check 5.
async function phaseReplaySeq2() {
  section("4b. Second sequential replay — check 5 (idempotency)", "PLAN Stage 7");
  console.log(`${YELLOW}Does NOT reset the DB — assumes replay-seq1 already ran. Replays the same ${EVENTS_FILE} again.${RESET}`);

  const lines = loadEventLines();
  const before = await q("SELECT count(*)::int c FROM raw_events");
  if (before[0].c === 0) {
    console.error("raw_events is empty — run `replay-seq1` first, this sub-phase assumes that already happened.");
    process.exit(1);
  }

  explain("Check 5 — replaying the entire file a second time must change nothing at all.");
  const [beforeCounts] = await q("SELECT (SELECT count(*) FROM raw_events) raw, (SELECT count(*) FROM ledger_entries) ledger");
  console.log(`Second sequential replay: ${lines.length} events...`);
  await replaySequential(lines);
  const [afterCounts] = await q("SELECT (SELECT count(*) FROM raw_events) raw, (SELECT count(*) FROM ledger_entries) ledger");
  check(
    "second full replay is a true no-op",
    beforeCounts.raw === afterCounts.raw && beforeCounts.ledger === afterCounts.ledger,
    `before ${JSON.stringify(beforeCounts)} after ${JSON.stringify(afterCounts)}`,
  );
}

// Sub-phase 3: resets on its own (needs a clean slate to compare fairly
// against seq1's sequential result) and replays with concurrency 8.
async function phaseReplayParallel() {
  section("4c. Parallel replay — check 6 (concurrency)", "PLAN Stage 7");
  console.log(`${YELLOW}This RESETS your database again and replays ${EVENTS_FILE} once, with concurrency 8.${RESET}`);

  const lines = loadEventLines();
  resetAndMigrate();
  console.log(`Parallel replay (concurrency 8): ${lines.length} events...`);
  await replayParallel(lines);

  explain("Check 6 — the same correctness guarantees (checks 1 and 3) must hold under real 8-way concurrency, not just sequentially.");
  const dupesParallel = await q("SELECT event_id FROM raw_events GROUP BY event_id HAVING count(*) > 1");
  check("[parallel] no duplicate event_id rows", dupesParallel.length === 0, `${dupesParallel.length} duplicated`);
  const overRefundedParallel = await q(
    `SELECT o.order_id FROM orders o JOIN ledger_entries l ON l.order_id = o.order_id
     GROUP BY o.order_id, o.captured_amount HAVING COALESCE(SUM(l.amount),0) > o.captured_amount`,
  );
  check("[parallel] no order refunded beyond its captured amount", overRefundedParallel.length === 0, `${overRefundedParallel.length} violations`);
  note("auto-approve vs. review split can differ slightly from the sequential pass — each refund makes a live LLM call, not a deterministic function. The hard guarantees above (never a duplicate, never an over-refund) must be identical; the exact routing is allowed to vary.");
}

// Convenience alias: all three sub-phases back to back. Prefer running the
// three separately (each is independently resumable) unless you're
// confident this will complete well within your available time.
async function phaseReplay() {
  await phaseReplaySeq1();
  await phaseReplaySeq2();
  await phaseReplayParallel();
}

// ------------------------------------------------------------------ main --
const PHASE_ORDER = ["ingest", "workflow", "retrieval", "review", "replay-seq1", "replay-seq2", "replay-parallel", "replay"];
const DEFAULT_PHASES = ["ingest", "workflow", "retrieval", "review"];
// "all" expands to the three granular, independently-resumable replay
// sub-phases — not also the "replay" alias, which would just re-run them.
const ALL_PHASES = ["ingest", "workflow", "retrieval", "review", "replay-seq1", "replay-seq2", "replay-parallel"];

async function main() {
  const args = process.argv.slice(2);
  const requested = args.length === 0 ? DEFAULT_PHASES : args.includes("all") ? ALL_PHASES : args;
  const invalid = requested.filter((p) => !PHASE_ORDER.includes(p));
  if (invalid.length) {
    console.error(`Unknown phase(s): ${invalid.join(", ")}. Valid: ${PHASE_ORDER.join(", ")} (or "all")`);
    process.exit(1);
  }

  if (!(await serverReachable())) {
    console.error(`Cannot reach ${BASE} — is \`npm run dev\` running in another terminal? (set BASE=http://localhost:PORT if it's not on 3000)`);
    process.exit(1);
  }

  console.log(`${BOLD}Refund Triage Console — live verification${RESET}`);
  console.log(`${DIM}Target: ${BASE}   Run id: ${RUN}   Phases: ${requested.join(", ")}${RESET}`);
  const replayRequested = requested.some((p) => p.startsWith("replay"));
  if (!replayRequested) {
    console.log(
      `${DIM}(pass "replay-seq1", "replay-seq2", "replay-parallel" one at a time — or "all"/"replay" to chain them — for the full ${EVENTS_FILE} replay + 6 acceptance checks. Each takes 20-30+ minutes and replay-seq1/replay-parallel reset the DB.)${RESET}`,
    );
  }

  await mongoClient.connect();
  mongoDb = mongoClient.db("refund_triage");

  try {
    let ctx;
    if (requested.includes("ingest")) ctx = await phaseIngest();
    if (requested.includes("workflow")) await phaseWorkflow(ctx);
    if (requested.includes("retrieval")) await phaseRetrieval();
    if (requested.includes("review")) await phaseReview();
    if (requested.includes("replay-seq1")) await phaseReplaySeq1();
    if (requested.includes("replay-seq2")) await phaseReplaySeq2();
    if (requested.includes("replay-parallel")) await phaseReplayParallel();
    if (requested.includes("replay")) await phaseReplay();
  } finally {
    await pool.end();
    await mongoClient.close();
  }

  console.log(`\n${BOLD}=== Summary ===${RESET}`);
  console.log(`${GREEN}${pass} passed${RESET}, ${fail > 0 ? RED : ""}${fail} failed${RESET}, ${YELLOW}${info} informational${RESET}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
