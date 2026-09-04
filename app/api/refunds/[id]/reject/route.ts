import { sql } from "@/lib/db/postgres";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const updated = await sql`
    UPDATE workflow_runs SET status = 'rejected', updated_at = now()
    WHERE id = ${id} AND status = 'review_pending'
    RETURNING id
  `;
  if (updated.length === 0) {
    return Response.json({ error: "run is not awaiting review" }, { status: 409 });
  }

  return Response.json({ status: "ok" });
}
