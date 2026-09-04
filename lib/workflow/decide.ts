import { z } from "zod";
import { getMongoDb } from "@/lib/db/mongo";
import { sql } from "@/lib/db/postgres";
import { azureClient, CHAT_DEPLOYMENT } from "@/lib/ai/azure";
import { retrievePolicies } from "@/lib/retrieval/search";
import { formatMoney } from "@/lib/money";

const CONFIDENCE_THRESHOLD = 0.7;
const RETRIEVAL_K = 5;

const decisionResponseSchema = z.object({
  decision: z.enum(["auto_approve", "review"]),
  reason: z.string(),
  citation_ids: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

// The dataset only gives currency, not an explicit region/country — this is
// a reasonable proxy given what's actually available, not a guess dressed
// up as fact.
const CURRENCY_TO_REGION: Record<string, string> = { USD: "US", EUR: "EU", GBP: "UK" };

// Guardrails, not policy: confidence below threshold or a response that
// doesn't parse both force review_pending regardless of what the model
// said — the model is never trusted blindly. decision/citation_ids/
// confidence still store the model's raw recommendation (even when
// overridden) so Stage 5's UI can show a reviewer what the model actually
// thought, not just that it got overridden.
export async function decideEligibility(runId: string, orderId: string): Promise<string> {
  const startedAt = new Date();

  const [run] = await sql`SELECT reason, requested_amount FROM workflow_runs WHERE id = ${runId}`;
  const [order] = await sql`SELECT currency, captured_amount FROM orders WHERE order_id = ${orderId}`;
  const [{ refunded }] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS refunded FROM ledger_entries WHERE order_id = ${orderId}
  `;

  const requestedAmount = Number(run.requested_amount);
  const capturedAmount = Number(order.captured_amount);
  const remaining = capturedAmount - Number(refunded);
  const region = order.currency ? (CURRENCY_TO_REGION[order.currency] ?? "global") : "global";
  const currency = order.currency ?? "USD";

  const query = `Refund request: reason=${run.reason ?? "unspecified"}, region=${region}, requested=${formatMoney(requestedAmount, currency)} of ${formatMoney(capturedAmount, currency)} captured (${formatMoney(remaining, currency)} remaining before this request)`;
  const retrieved = await retrievePolicies(query, RETRIEVAL_K);
  const policyContext = retrieved.map((p) => `[${p.id}] ${p.title}\n${p.body}`).join("\n\n");

  const systemPrompt =
    'You are an eligibility assistant for a refund triage system. Decide whether the refund below should be auto-approved or sent to human review, based ONLY on the policy documents provided. Cite the specific policy IDs you relied on in citation_ids. If no policy clearly supports auto-approval, or any escalation/fraud/high-value signal applies, choose "review". Confidence should reflect how clear-cut the policy fit is, not how likely the claim is true.';

  const userPrompt = `Order: ${orderId}
Refund reason: ${run.reason ?? "unspecified"}
Region: ${region}
Requested amount: ${formatMoney(requestedAmount, currency)}
Order captured amount: ${formatMoney(capturedAmount, currency)}
Remaining balance before this request: ${formatMoney(remaining, currency)}

Relevant policies:
${policyContext}`;

  let parsed: z.infer<typeof decisionResponseSchema> | null = null;
  let rawResponse = "";
  let apiError: string | null = null;

  try {
    const completion = await azureClient.chat.completions.create({
      model: CHAT_DEPLOYMENT,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "refund_decision",
          strict: true,
          schema: {
            type: "object",
            properties: {
              decision: { type: "string", enum: ["auto_approve", "review"] },
              reason: { type: "string" },
              citation_ids: { type: "array", items: { type: "string" } },
              confidence: { type: "number" },
            },
            required: ["decision", "reason", "citation_ids", "confidence"],
            additionalProperties: false,
          },
        },
      },
    });
    rawResponse = completion.choices[0]?.message?.content ?? "";
    const result = decisionResponseSchema.safeParse(JSON.parse(rawResponse));
    if (result.success) {
      parsed = result.data;
    } else {
      apiError = `schema validation failed: ${result.error.message}`;
    }
  } catch (err) {
    apiError = err instanceof Error ? err.message : String(err);
  }

  const autoApproved = parsed !== null && parsed.decision === "auto_approve" && parsed.confidence >= CONFIDENCE_THRESHOLD;
  const nextStatus = autoApproved ? "issuing_refund" : "review_pending";

  const db = await getMongoDb();
  await db.collection("decision_log").insertOne({
    run_id: runId,
    order_id: orderId,
    query,
    retrieved_policy_ids: retrieved.map((p) => p.id),
    prompt: { system: systemPrompt, user: userPrompt },
    raw_response: rawResponse,
    parsed,
    api_error: apiError,
    auto_approved: autoApproved,
    created_at: new Date(),
  });

  const updated = await sql`
    UPDATE workflow_runs SET
      status = ${nextStatus},
      decision = ${parsed?.decision ?? null},
      citation_ids = ${JSON.stringify(parsed?.citation_ids ?? [])},
      confidence = ${parsed?.confidence ?? null},
      updated_at = now()
    WHERE id = ${runId} AND status = 'checking_eligibility'
    RETURNING id
  `;
  if (updated.length === 0) return "checking_eligibility";

  await sql`
    INSERT INTO workflow_step_log (run_id, step, attempt, status, error, started_at, finished_at)
    VALUES (
      ${runId}, 'decide', 1, ${apiError ? "failed" : "succeeded"},
      ${apiError ?? (autoApproved ? null : "routed to review")},
      ${startedAt.toISOString()}, now()
    )
  `;

  return nextStatus;
}
