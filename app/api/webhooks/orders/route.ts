import { z } from "zod";
import { sql } from "@/lib/db/postgres";
import { toMinorUnits } from "@/lib/money";
import { advanceWorkflow } from "@/lib/workflow/advance";

export const maxDuration = 60;

const envelopeSchema = z.object({
  event_id: z.string().min(1),
  topic: z.string().min(1),
  occurred_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid occurred_at"),
  payload: z.unknown(),
});

const orderCreatedPayloadSchema = z.object({
  order_id: z.string().min(1),
  currency: z.string().min(1),
  subtotal: z.number(),
  shipping: z.number(),
  tax: z.number(),
});

const orderPaidPayloadSchema = z.object({
  order_id: z.string().min(1),
  amount: z.number(),
  currency: z.string().min(1).optional(),
});

const refundRequestedPayloadSchema = z.object({
  order_id: z.string().min(1),
  refund_amount: z.number(),
  reason: z.string().optional(),
});

type ValidatedPayload =
  | { status: "stored"; kind: "order.created"; payload: z.infer<typeof orderCreatedPayloadSchema> }
  | { status: "stored"; kind: "order.paid"; payload: z.infer<typeof orderPaidPayloadSchema> }
  | { status: "stored"; kind: "refund.requested"; payload: z.infer<typeof refundRequestedPayloadSchema> }
  | { status: "rejected"; error: string };

function validatePayload(topic: string, payload: unknown): ValidatedPayload {
  switch (topic) {
    case "order.created": {
      const parsed = orderCreatedPayloadSchema.safeParse(payload);
      return parsed.success
        ? { status: "stored", kind: "order.created", payload: parsed.data }
        : { status: "rejected", error: parsed.error.message };
    }
    case "order.paid": {
      const parsed = orderPaidPayloadSchema.safeParse(payload);
      return parsed.success
        ? { status: "stored", kind: "order.paid", payload: parsed.data }
        : { status: "rejected", error: parsed.error.message };
    }
    case "refund.requested": {
      const parsed = refundRequestedPayloadSchema.safeParse(payload);
      return parsed.success
        ? { status: "stored", kind: "refund.requested", payload: parsed.data }
        : { status: "rejected", error: parsed.error.message };
    }
    default:
      return { status: "rejected", error: `unknown topic: ${topic}` };
  }
}

async function rejectAfterInsert(eventId: string, error: string) {
  await sql`UPDATE raw_events SET status = 'rejected', error = ${error} WHERE event_id = ${eventId}`;
  return Response.json({ status: "rejected", error });
}

async function redrivePendingOrder(orderId: string): Promise<void> {
  const pending = await sql`
    SELECT id FROM workflow_runs WHERE order_id = ${orderId} AND status = 'pending_order'
  `;
  for (const run of pending) {
    await advanceWorkflow(run.id);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    console.error("webhook: invalid JSON body");
    return Response.json({ status: "rejected", error: "invalid JSON" }, { status: 400 });
  }

  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    console.error("webhook: invalid envelope", envelope.error.message);
    return Response.json({ status: "rejected", error: "invalid envelope" }, { status: 400 });
  }
  const { event_id, topic, occurred_at, payload } = envelope.data;

  const validated = validatePayload(topic, payload);

  // Idempotent claim: whoever's INSERT wins processes the event, the other
  // gets no row back and stops immediately — see db/migrations/001_init.sql.
  const inserted = await sql`
    INSERT INTO raw_events (event_id, topic, payload, occurred_at, status, error)
    VALUES (
      ${event_id}, ${topic}, ${JSON.stringify(payload ?? null)}, ${occurred_at},
      ${validated.status}, ${validated.status === "rejected" ? validated.error : null}
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) {
    return Response.json({ status: "duplicate" });
  }

  if (validated.status === "rejected") {
    return Response.json({ status: "rejected", error: validated.error });
  }

  if (validated.kind === "order.created") {
    const { order_id, currency, subtotal, shipping, tax } = validated.payload;
    const subtotalMinor = toMinorUnits(subtotal);
    const shippingMinor = toMinorUnits(shipping);
    const taxMinor = toMinorUnits(tax);
    if (
      subtotalMinor === null || subtotalMinor < 0 ||
      shippingMinor === null || shippingMinor < 0 ||
      taxMinor === null || taxMinor < 0
    ) {
      return rejectAfterInsert(event_id, "invalid amount");
    }
    await sql`
      INSERT INTO orders (order_id, currency, subtotal_amount, shipping_amount, tax_amount)
      VALUES (${order_id}, ${currency}, ${subtotalMinor}, ${shippingMinor}, ${taxMinor})
      ON CONFLICT (order_id) DO UPDATE SET
        currency = COALESCE(EXCLUDED.currency, orders.currency),
        subtotal_amount = COALESCE(EXCLUDED.subtotal_amount, orders.subtotal_amount),
        shipping_amount = COALESCE(EXCLUDED.shipping_amount, orders.shipping_amount),
        tax_amount = COALESCE(EXCLUDED.tax_amount, orders.tax_amount),
        updated_at = now()
    `;
    await redrivePendingOrder(order_id);
    return Response.json({ status: "stored" });
  }

  if (validated.kind === "order.paid") {
    const { order_id, amount, currency } = validated.payload;
    const amountMinor = toMinorUnits(amount);
    if (amountMinor === null || amountMinor < 0) {
      return rejectAfterInsert(event_id, "invalid amount");
    }
    await sql`
      INSERT INTO orders (order_id, currency, captured_amount)
      VALUES (${order_id}, ${currency ?? null}, ${amountMinor})
      ON CONFLICT (order_id) DO UPDATE SET
        currency = COALESCE(EXCLUDED.currency, orders.currency),
        captured_amount = COALESCE(EXCLUDED.captured_amount, orders.captured_amount),
        updated_at = now()
    `;
    await redrivePendingOrder(order_id);
    return Response.json({ status: "stored" });
  }

  // refund.requested
  const { order_id, refund_amount, reason } = validated.payload;
  const requestedMinor = toMinorUnits(refund_amount);
  if (requestedMinor === null || requestedMinor <= 0) {
    return rejectAfterInsert(event_id, "junk amount");
  }

  const run = await sql`
    INSERT INTO workflow_runs (event_id, order_id, requested_amount, reason)
    VALUES (${event_id}, ${order_id}, ${requestedMinor}, ${reason ?? null})
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  `;
  if (run.length > 0) {
    await advanceWorkflow(run[0].id);
  }
  return Response.json({ status: "stored" });
}
