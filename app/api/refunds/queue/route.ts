import { sql } from "@/lib/db/postgres";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "review_pending";

  const runs = await sql`
    SELECT
      wr.id, wr.order_id, wr.requested_amount, wr.reason, wr.status,
      wr.decision, wr.confidence, wr.created_at, o.currency
    FROM workflow_runs wr
    LEFT JOIN orders o ON o.order_id = wr.order_id
    WHERE wr.status = ${status}
    ORDER BY wr.created_at ASC
  `;

  return Response.json({ runs });
}
