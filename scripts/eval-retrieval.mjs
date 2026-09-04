// Retrieval evaluation: 15 hand-written refund scenarios, each with the
// policy doc that should come back for it. Mirrors lib/retrieval/search.ts's
// retrievePolicies exactly (same {superseded_by: null} filter, same cosine
// similarity, same k) instead of importing it — this is a plain Node
// script, and nothing else under scripts/ imports TypeScript from lib/ (see
// scripts/seed-policies.mjs). If retrievePolicies's ranking approach ever
// changes, this mirror needs to change with it or the numbers below stop
// meaning anything.

import { mkdirSync, writeFileSync } from "node:fs";
import dns from "node:dns";
import { MongoClient } from "mongodb";
import OpenAI from "openai";

if (!process.env.VERCEL) dns.setServers(["1.1.1.1", "8.8.8.8"]);

const mongoUri = process.env.MONGODB_URI;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureApiKey = process.env.AZURE_OPENAI_API_KEY;
const embeddingDeployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;

for (const [name, value] of Object.entries({
  MONGODB_URI: mongoUri,
  AZURE_OPENAI_ENDPOINT: azureEndpoint,
  AZURE_OPENAI_API_KEY: azureApiKey,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: embeddingDeployment,
})) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const MONGO_DB_NAME = "refund_triage";
const RETRIEVAL_K = 5; // matches lib/workflow/decide.ts's RETRIEVAL_K
const SUPERSEDED_ID = "return-window-2023";

const azureClient = new OpenAI({ apiKey: azureApiKey, baseURL: `${azureEndpoint}/openai/v1` });

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Exact mirror of lib/retrieval/search.ts's retrievePolicies, generalized to
// take the candidate pool as an argument so this file can also probe the
// UNFILTERED pool below (production code never does that — only this eval
// needs it, to prove the exclusion filter is doing real work).
async function retrieveFrom(pool, query, k) {
  const { data } = await azureClient.embeddings.create({ model: embeddingDeployment, input: query });
  const queryEmbedding = data[0].embedding;
  return pool
    .map((doc) => ({ id: doc._id, title: doc.title, score: cosineSimilarity(queryEmbedding, doc.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

const QUESTIONS = [
  {
    query:
      "Customer wants to return an unused item in original packaging, 40 days after delivery, no damage, just changed their mind.",
    expected: ["return-window-2026"],
  },
  {
    query: "What is the current return window policy — how many days does a customer have to return an unused item?",
    expected: ["return-window-2026"],
  },
  {
    query:
      "Customer says the item arrived damaged, reported 3 days after delivery, no photo provided but describes the damage clearly.",
    expected: ["damage-general"],
  },
  {
    query: "A laptop arrived dead on arrival, customer reports it 10 days after delivery.",
    expected: ["damage-electronics"],
  },
  {
    query: "A grocery delivery of frozen food arrived spoiled and melted, customer reports it the same day.",
    expected: ["damage-perishable"],
  },
  {
    query: "Customer says only 2 of the 3 items in their order arrived; the third one never showed up.",
    expected: ["missing-item-policy"],
  },
  {
    query:
      "Order arrived 9 days later than the quoted delivery date; customer is unhappy about the delay but still wants to keep the item.",
    expected: ["late-delivery-policy"],
  },
  {
    query:
      "US customer wants to cancel a standard retail purchase just because they changed their mind, citing a federal cooling-off right.",
    expected: ["regional-rights-us"],
  },
  {
    query:
      "EU customer requests to withdraw from their purchase 10 days after delivery under their statutory cancellation right, no reason given.",
    expected: ["regional-rights-eu"],
  },
  {
    query: "UK customer wants to cancel under the Consumer Contracts Regulations cooling-off period, 12 days after delivery.",
    expected: ["regional-rights-uk"],
  },
  {
    query: "Customer is requesting a refund of $650 on a single order.",
    expected: ["escalation-high-value"],
  },
  {
    query: "This customer has submitted 4 refund requests in the past two months, this being the latest.",
    expected: ["escalation-repeat-requests"],
  },
  {
    query: "High-value order with a missing-item claim and no delivery confirmation on file.",
    expected: ["escalation-fraud-signals"],
  },
  {
    query: "Customer wants a small $30 goodwill credit for a minor inconvenience that doesn't fit any specific refund policy.",
    expected: ["goodwill-standard"],
  },
  {
    query: "A VIP loyalty customer is requesting a $120 goodwill gesture for an inconvenience outside normal policy.",
    expected: ["goodwill-loyalty"],
  },
];

function fmtScore(n) {
  return n.toFixed(4);
}

async function main() {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const allPolicies = await client.db(MONGO_DB_NAME).collection("policies").find({}).toArray();

  if (allPolicies.length === 0) {
    console.error("policies collection is empty — run `npm run seed:policies` first.");
    process.exit(1);
  }

  const rankedPolicies = allPolicies.filter((p) => p.superseded_by === null);

  const results = [];
  for (const q of QUESTIONS) {
    const retrieved = await retrieveFrom(rankedPolicies, q.query, RETRIEVAL_K);
    const retrievedIds = retrieved.map((r) => r.id);
    const hit = q.expected.some((id) => retrievedIds.includes(id));
    const top1Correct = q.expected.includes(retrievedIds[0]);
    const rankIdx = retrievedIds.findIndex((id) => q.expected.includes(id));
    results.push({
      query: q.query,
      expected: q.expected,
      retrieved,
      hit,
      top1Correct,
      rank: rankIdx === -1 ? null : rankIdx + 1,
    });
  }

  // The 2023 return-window doc is semantically near-identical to its 2026
  // replacement — the interesting question isn't "did it fail to appear"
  // (retrievePolicies filters it out before scoring even starts, so that's
  // guaranteed by construction) but "would it actually have competed for
  // the top spot if that filter didn't exist." Re-running the return-window
  // questions against the UNFILTERED pool answers that directly.
  const returnWindowQuestions = QUESTIONS.filter((q) => q.expected.includes("return-window-2026"));
  const supersededProbe = [];
  for (const q of returnWindowQuestions) {
    const unfiltered = await retrieveFrom(allPolicies, q.query, allPolicies.length);
    supersededProbe.push({
      query: q.query,
      currentRank: unfiltered.findIndex((r) => r.id === "return-window-2026") + 1,
      currentScore: unfiltered.find((r) => r.id === "return-window-2026")?.score ?? null,
      supersededRank: unfiltered.findIndex((r) => r.id === SUPERSEDED_ID) + 1,
      supersededScore: unfiltered.find((r) => r.id === SUPERSEDED_ID)?.score ?? null,
    });
  }

  await client.close();

  const hitCount = results.filter((r) => r.hit).length;
  const top1Count = results.filter((r) => r.top1Correct).length;
  const hitRate = hitCount / results.length;
  const top1Rate = top1Count / results.length;
  const supersededEverLeaked = results.some((r) => r.retrieved.some((doc) => doc.id === SUPERSEDED_ID));

  const lines = [];
  lines.push("# Retrieval evaluation");
  lines.push("");
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`k = ${RETRIEVAL_K} (matches lib/workflow/decide.ts's RETRIEVAL_K)`);
  lines.push(`Policies indexed: ${allPolicies.length} (${rankedPolicies.length} active + ${allPolicies.length - rankedPolicies.length} superseded)`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- hit@${RETRIEVAL_K}: ${hitCount}/${results.length} (${(hitRate * 100).toFixed(0)}%) — expected policy appears somewhere in the top ${RETRIEVAL_K}`);
  lines.push(`- precision@1: ${top1Count}/${results.length} (${(top1Rate * 100).toFixed(0)}%) — expected policy is specifically the top-ranked result`);
  lines.push(`- superseded doc (${SUPERSEDED_ID}) ever appeared in a top-${RETRIEVAL_K} result: ${supersededEverLeaked ? "YES — regression" : "no"}`);
  lines.push("");
  lines.push("## Superseded-policy exclusion check");
  lines.push("");
  lines.push(
    "retrievePolicies filters `{superseded_by: null}` before ranking, so the 2023 doc " +
      "structurally cannot appear in the results above — that part is guaranteed by " +
      "construction, not by the embedding model's judgment. What's worth actually " +
      "checking is whether that filter is doing necessary work, i.e. whether the " +
      "superseded doc would otherwise have been a strong contender. Re-running the " +
      "return-window questions against the full, unfiltered policy set (superseded " +
      "doc included) answers that:",
  );
  lines.push("");
  lines.push("| Query | 2026 (current) rank | 2026 score | 2023 (superseded) rank | 2023 score |");
  lines.push("|---|---|---|---|---|");
  for (const p of supersededProbe) {
    lines.push(
      `| ${p.query} | ${p.currentRank} | ${p.currentScore !== null ? fmtScore(p.currentScore) : "—"} | ${p.supersededRank} | ${p.supersededScore !== null ? fmtScore(p.supersededScore) : "—"} |`,
    );
  }
  lines.push("");
  lines.push("## Per-question results");
  lines.push("");
  results.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.query}`);
    lines.push("");
    lines.push(`- Expected: \`${r.expected.join(", ")}\``);
    lines.push(`- hit@${RETRIEVAL_K}: ${r.hit ? "✓" : "✗"}${r.rank ? ` (rank ${r.rank})` : " (not retrieved)"}`);
    lines.push(`- precision@1: ${r.top1Correct ? "✓" : "✗"}`);
    lines.push("- Retrieved:");
    r.retrieved.forEach((doc, idx) => {
      const marker = r.expected.includes(doc.id) ? " ← expected" : "";
      lines.push(`  ${idx + 1}. \`${doc.id}\` — ${doc.title} (score ${fmtScore(doc.score)})${marker}`);
    });
    lines.push("");
  });

  const report = lines.join("\n");
  mkdirSync("eval", { recursive: true });
  writeFileSync("eval/retrieval-results.md", report);

  console.log(`hit@${RETRIEVAL_K}: ${hitCount}/${results.length} (${(hitRate * 100).toFixed(0)}%)`);
  console.log(`precision@1: ${top1Count}/${results.length} (${(top1Rate * 100).toFixed(0)}%)`);
  console.log(`superseded doc leaked into any result: ${supersededEverLeaked ? "YES — regression" : "no"}`);
  console.log("full report written to eval/retrieval-results.md");
}

await main();
