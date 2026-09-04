import { sql } from "@/lib/db/postgres";
import { decideEligibility } from "@/lib/workflow/decide";

// Statuses advanceWorkflow will keep dispatching through in one call. There's
// no background worker on Vercel Hobby, so a single call has to drive a run
// as far as it can go right now, not just one step — review_pending,
// rejected, completed, and failed are where it has to stop and wait.
const CONTINUABLE = new Set([
  "pending_order",
  "loading_order",
  "checking_eligibility",
  "deciding",
  "issuing_refund",
  "notifying",
]);

interface Run {
  id: string;
  order_id: string;
  status: string;
  requested_amount: string;
}

export async function advanceWorkflow(runId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const [run] = await sql`
      SELECT id, order_id, status, requested_amount FROM workflow_runs WHERE id = ${runId}
    `;
    if (!run || !CONTINUABLE.has(run.status)) return;

    const nextStatus = await dispatch(run as Run);
    if (nextStatus === run.status) return; // no progress — waiting, or no handler yet
  }
}

async function dispatch(run: Run): Promise<string> {
  switch (run.status) {
    case "pending_order":
      return loadOrder(run.id, run.order_id);
    case "loading_order":
      return checkEligibility(run.id, run.order_id, run.requested_amount);
    case "checking_eligibility":
      return decideEligibility(run.id, run.order_id);
    case "issuing_refund":
      return issueRefund(run.id, run.order_id, run.requested_amount);
    case "notifying":
      return notify(run.id);
    default:
      return run.status;
  }
}

async function logStep(
  runId: string,
  step: string,
  attempt: number,
  status: "succeeded" | "failed",
  startedAt: Date,
  error?: string,
): Promise<void> {
  await sql`
    INSERT INTO workflow_step_log (run_id, step, attempt, status, error, started_at, finished_at)
    VALUES (${runId}, ${step}, ${attempt}, ${status}, ${error ?? null}, ${startedAt.toISOString()}, now())
  `;
}

// Waits specifically for order.paid (captured_amount set), not just
// order.created — checkEligibility's math is meaningless without a captured
// total, and the two events can arrive in either order.
async function loadOrder(runId: string, orderId: string): Promise<string> {
  const startedAt = new Date();
  const [order] = await sql`
    SELECT order_id FROM orders WHERE order_id = ${orderId} AND captured_amount IS NOT NULL
  `;
  if (!order) return "pending_order";

  const updated = await sql`
    UPDATE workflow_runs SET status = 'loading_order', updated_at = now()
    WHERE id = ${runId} AND status = 'pending_order'
    RETURNING id
  `;
  if (updated.length === 0) return "pending_order"; // another concurrent call already advanced it

  await logStep(runId, "loadOrder", 1, "succeeded", startedAt);
  return "loading_order";
}

// The one guardrail that isn't policy: a plain arithmetic fact checked
// before any model is ever called. remaining is per order (captured minus
// every ledger entry for that order across all its runs), not per run.
async function checkEligibility(runId: string, orderId: string, requestedAmount: string): Promise<string> {
  const startedAt = new Date();
  const [order] = await sql`SELECT captured_amount FROM orders WHERE order_id = ${orderId}`;
  const [{ refunded }] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS refunded FROM ledger_entries WHERE order_id = ${orderId}
  `;
  const remaining = Number(order.captured_amount) - Number(refunded);
  const requested = Number(requestedAmount);

  if (requested > remaining) {
    const updated = await sql`
      UPDATE workflow_runs SET status = 'rejected', updated_at = now()
      WHERE id = ${runId} AND status = 'loading_order'
      RETURNING id
    `;
    if (updated.length === 0) return "loading_order";
    await logStep(runId, "checkEligibility", 1, "failed", startedAt, `requested ${requested} exceeds remaining ${remaining}`);
    return "rejected";
  }

  const updated = await sql`
    UPDATE workflow_runs SET status = 'checking_eligibility', updated_at = now()
    WHERE id = ${runId} AND status = 'loading_order'
    RETURNING id
  `;
  if (updated.length === 0) return "loading_order";
  await logStep(runId, "checkEligibility", 1, "succeeded", startedAt);
  return "checking_eligibility";
}

// A row lock on the order (not just the run) is what actually prevents an
// over-refund: checkEligibility's earlier pass is a snapshot, and two
// different runs against the same order can each look eligible on their own
// while being collectively over budget once both are approved. Locking the
// order row serializes any two runs issuing against it, so the second one's
// remaining-balance read always reflects the first one's committed ledger
// entry, not a stale snapshot — computed in SQL as bigint arithmetic, so no
// JS float/precision concerns either. ON CONFLICT DO NOTHING is the
// separate, per-run guarantee: even two concurrent calls for the exact same
// run can't create two ledger rows for it, and it's what makes this safe to
// call again after a crash that wrote the ledger row but not the status.
async function issueRefund(runId: string, orderId: string, requestedAmount: string): Promise<string> {
  const startedAt = new Date();

  await sql`
    WITH locked_order AS (
      SELECT captured_amount FROM orders WHERE order_id = ${orderId} FOR UPDATE
    ), current_refunded AS (
      SELECT COALESCE(SUM(amount), 0) AS refunded FROM ledger_entries WHERE order_id = ${orderId}
    )
    INSERT INTO ledger_entries (workflow_run_id, order_id, amount)
    SELECT ${runId}, ${orderId}, ${requestedAmount}
    FROM locked_order, current_refunded
    WHERE ${requestedAmount}::bigint <= locked_order.captured_amount - current_refunded.refunded
    ON CONFLICT (workflow_run_id) DO NOTHING
  `;

  const [ledger] = await sql`SELECT id FROM ledger_entries WHERE workflow_run_id = ${runId}`;

  if (!ledger) {
    // Genuinely over budget once other runs against this order are
    // accounted for — never issue; re-reject rather than silently stall.
    const updated = await sql`
      UPDATE workflow_runs SET status = 'rejected', updated_at = now()
      WHERE id = ${runId} AND status = 'issuing_refund'
      RETURNING id
    `;
    if (updated.length === 0) return "issuing_refund";
    await logStep(
      runId,
      "issueRefund",
      1,
      "failed",
      startedAt,
      "requested amount exceeds remaining balance once other runs against this order are accounted for",
    );
    return "rejected";
  }

  const updated = await sql`
    UPDATE workflow_runs SET status = 'notifying', updated_at = now()
    WHERE id = ${runId} AND status = 'issuing_refund'
    RETURNING id
  `;
  if (updated.length === 0) return "issuing_refund";
  await logStep(runId, "issueRefund", 1, "succeeded", startedAt);
  return "notifying";
}

const NOTIFY_MAX_ATTEMPTS = 3;
const NOTIFY_BASE_DELAY_MS = 200;
const NOTIFY_FAILURE_RATE = 0.15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stub notification provider — fails ~15% of the time on purpose, to
// exercise the retry/backoff path below.
async function sendNotification(): Promise<void> {
  if (Math.random() < NOTIFY_FAILURE_RATE) {
    throw new Error("notification provider timeout");
  }
}

// Refund issuance is a separate, already-committed fact by the time this
// runs (issueRefund already moved status past issuing_refund). This reads
// that fact rather than re-deriving it, and a permanently-failed notify
// never touches ledger_entries — it only ever moves this run to 'failed',
// which means "the notification didn't go out", not "the refund didn't."
async function notify(runId: string): Promise<string> {
  const [ledger] = await sql`SELECT id FROM ledger_entries WHERE workflow_run_id = ${runId}`;
  if (!ledger) {
    throw new Error(`notify: no ledger_entries row for workflow_run_id=${runId}`);
  }

  for (let attempt = 1; attempt <= NOTIFY_MAX_ATTEMPTS; attempt++) {
    const startedAt = new Date();
    try {
      await sendNotification();
      await logStep(runId, "notify", attempt, "succeeded", startedAt);
      const updated = await sql`
        UPDATE workflow_runs SET status = 'completed', updated_at = now()
        WHERE id = ${runId} AND status = 'notifying'
        RETURNING id
      `;
      return updated.length === 0 ? "notifying" : "completed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logStep(runId, "notify", attempt, "failed", startedAt, message);
      if (attempt < NOTIFY_MAX_ATTEMPTS) {
        await sleep(NOTIFY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  const updated = await sql`
    UPDATE workflow_runs SET status = 'failed', updated_at = now()
    WHERE id = ${runId} AND status = 'notifying'
    RETURNING id
  `;
  return updated.length === 0 ? "notifying" : "failed";
}
