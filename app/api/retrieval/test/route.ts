import { retrievePolicies } from "@/lib/retrieval/search";

// Same reasoning as the webhook route: bounds the Azure embedding call this
// makes, well under Vercel Hobby's default.
export const maxDuration = 60;

const RESULT_K = 5; // matches lib/workflow/decide.ts's RETRIEVAL_K — same k the real eligibility decision uses

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  if (!query) {
    return Response.json({ error: "missing query" }, { status: 400 });
  }

  const results = await retrievePolicies(query, RESULT_K);
  return Response.json({ results });
}
