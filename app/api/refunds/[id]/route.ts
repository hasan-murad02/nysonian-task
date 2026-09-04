import { sql } from "@/lib/db/postgres";
import { getMongoDb } from "@/lib/db/mongo";

interface PolicyRecord {
  _id: string;
  title: string;
  body: string;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [run] = await sql`SELECT * FROM workflow_runs WHERE id = ${id}`;
  if (!run) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const [order] = await sql`SELECT * FROM orders WHERE order_id = ${run.order_id}`;
  const steps = await sql`
    SELECT step, attempt, status, error, started_at, finished_at
    FROM workflow_step_log WHERE run_id = ${id} ORDER BY id
  `;

  const citationIds: string[] = run.citation_ids ?? [];
  let citations: Array<{ id: string; title: string; body: string }> = [];
  let modelReason: string | null = null;

  const db = await getMongoDb();
  if (citationIds.length > 0) {
    const docs = await db
      .collection<PolicyRecord>("policies")
      .find({ _id: { $in: citationIds } })
      .toArray();
    citations = docs.map((d) => ({ id: d._id, title: d.title, body: d.body }));
  }
  const decisionEntry = await db
    .collection("decision_log")
    .findOne({ run_id: id }, { sort: { created_at: -1 } });
  modelReason = decisionEntry?.parsed?.reason ?? decisionEntry?.api_error ?? null;

  return Response.json({ run, order, steps, citations, modelReason });
}
