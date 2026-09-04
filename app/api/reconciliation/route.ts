import { sql } from "@/lib/db/postgres";

export async function GET() {
  const rows = await sql`
    SELECT
      o.order_id,
      o.currency,
      o.captured_amount,
      COALESCE(SUM(l.amount), 0) AS refunded
    FROM orders o
    LEFT JOIN ledger_entries l ON l.order_id = o.order_id
    WHERE o.captured_amount IS NOT NULL
    GROUP BY o.order_id, o.currency, o.captured_amount
    ORDER BY o.order_id
  `;

  const orders = rows.map((row) => {
    const captured = Number(row.captured_amount);
    const refunded = Number(row.refunded);
    const remaining = captured - refunded;
    const flag =
      remaining < 0 ? "integrity_alarm" : remaining === 0 ? "fully_refunded" : refunded > 0 ? "partially_refunded" : "not_refunded";
    return { ...row, remaining: String(remaining), flag };
  });

  return Response.json({ orders });
}
