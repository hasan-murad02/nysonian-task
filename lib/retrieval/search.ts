import { getMongoDb } from "@/lib/db/mongo";
import { azureClient, EMBEDDING_DEPLOYMENT } from "@/lib/ai/azure";

export interface RetrievedPolicy {
  id: string;
  title: string;
  body: string;
  score: number;
}

interface PolicyRecord {
  _id: string;
  title: string;
  body: string;
  superseded_by: string | null;
  embedding: number[];
}

// Policy set is tiny and only changes via a manual re-seed, so warm
// invocations reuse this instead of re-fetching + re-transferring all
// embeddings from Mongo on every decision.
let cachedPolicies: Promise<PolicyRecord[]> | null = null;

function loadCurrentPolicies(): Promise<PolicyRecord[]> {
  if (!cachedPolicies) {
    cachedPolicies = getMongoDb().then((db) =>
      db.collection<PolicyRecord>("policies").find({ superseded_by: null }).toArray(),
    );
  }
  return cachedPolicies;
}

function cosineSimilarity(a: number[], b: number[]): number {
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

// Superseded docs are excluded structurally, before ranking even happens —
// the dead 2023 return-window policy can never be cited, not just unlikely
// to be. Brute-force cosine in Node is a deliberate choice, not a fallback
// we settled for: 15 docs is trivial to score directly, which sidesteps
// M0-tier Atlas Search availability entirely rather than branching on
// whether an index exists.
export async function retrievePolicies(query: string, k: number): Promise<RetrievedPolicy[]> {
  const [{ data }, docs] = await Promise.all([
    azureClient.embeddings.create({ model: EMBEDDING_DEPLOYMENT, input: query }),
    loadCurrentPolicies(),
  ]);
  const queryEmbedding = data[0].embedding;

  return docs
    .map((doc) => ({
      id: doc._id,
      title: doc.title,
      body: doc.body,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
