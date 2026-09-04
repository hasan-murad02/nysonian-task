import { sql } from "@/lib/db/postgres";

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
      return decide(run.id);
    case "issuing_refund":
      return issueRefund(run.id, run.order_id, run.requested_amount);
    default:
      return run.status; // e.g. 'notifying' with no handler wired up yet
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

// Stub: no LLM/retrieval yet (Stage 4). Routes everything to review rather
// than risk auto-approving on no real judgment — same principle as the
// guardrails that force review on low confidence or a schema-invalid model
// response, just applied because there's no model at all yet.
async function decide(runId: string): Promise<string> {
  const startedAt = new Date();
  const updated = await sql`
    UPDATE workflow_runs SET status = 'review_pending', updated_at = now()
    WHERE id = ${runId} AND status = 'checking_eligibility'
    RETURNING id
  `;
  if (updated.length === 0) return "checking_eligibility";
  await logStep(runId, "decide", 1, "succeeded", startedAt, "stub: no eligibility model yet, routed to review");
  return "review_pending";
}

// The ledger insert and the status advance past issuing_refund happen in one
// atomic transaction — there's no world where a crash leaves a ledger row
// committed but the run still reads issuing_refund, which would make a
// retry double-issue. ON CONFLICT DO NOTHING is the second idempotency
// guarantee: this is safe to call again even if a prior attempt already
// wrote the ledger row and only failed to commit the status update.
async function issueRefund(runId: string, orderId: string, requestedAmount: string): Promise<string> {
  const startedAt = new Date();
  const [, updateResult] = await sql.transaction([
    sql`
      INSERT INTO ledger_entries (workflow_run_id, order_id, amount)
      VALUES (${runId}, ${orderId}, ${requestedAmount})
      ON CONFLICT (workflow_run_id) DO NOTHING
    `,
    sql`
      UPDATE workflow_runs SET status = 'notifying', updated_at = now()
      WHERE id = ${runId} AND status = 'issuing_refund'
      RETURNING id
    `,
  ]);

  if (updateResult.length === 0) return "issuing_refund";
  await logStep(runId, "issueRefund", 1, "succeeded", startedAt);
  return "notifying";
}
