import { sql } from "@/lib/db/postgres";

// Dispatches a workflow_run to its next step by current status. Only
// pending_order -> loading_order exists so far; later stages extend this
// switch with checking_eligibility, deciding, issuing_refund, notifying.
export async function advanceWorkflow(runId: string): Promise<void> {
  const [run] = await sql`
    SELECT id, order_id, status FROM workflow_runs WHERE id = ${runId}
  `;
  if (!run) return;

  if (run.status === "pending_order") {
    await loadOrder(run.id, run.order_id);
  }
}

async function loadOrder(runId: string, orderId: string): Promise<void> {
  const [order] = await sql`SELECT order_id FROM orders WHERE order_id = ${orderId}`;
  if (!order) return; // still pending_order — nothing to do yet

  const updated = await sql`
    UPDATE workflow_runs SET status = 'loading_order', updated_at = now()
    WHERE id = ${runId} AND status = 'pending_order'
    RETURNING id
  `;
  if (updated.length === 0) return; // another concurrent call already advanced it

  await sql`
    INSERT INTO workflow_step_log (run_id, step, status)
    VALUES (${runId}, 'loadOrder', 'succeeded')
  `;
}
