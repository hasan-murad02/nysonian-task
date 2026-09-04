import { sql } from "@/lib/db/postgres";
import { advanceWorkflow } from "@/lib/workflow/advance";

export const maxDuration = 60;

// Human override of decide()'s recommendation — sets status directly to
// issuing_refund (skipping the model entirely) then drives the same
// advanceWorkflow loop every other trigger uses, so issueRefund's
// order-row-locked exactly-once guarantee applies here identically.
// Guarded the same way every other transition in this app is: the UPDATE
// only succeeds if the run is still actually awaiting review, so a
// double-click or two reviewers acting on the same run at once can't both
// win.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const updated = await sql`
    UPDATE workflow_runs SET status = 'issuing_refund', updated_at = now()
    WHERE id = ${id} AND status = 'review_pending'
    RETURNING id
  `;
  if (updated.length === 0) {
    return Response.json({ error: "run is not awaiting review" }, { status: 409 });
  }

  await advanceWorkflow(id);
  return Response.json({ status: "ok" });
}
