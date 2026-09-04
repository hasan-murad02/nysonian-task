// Reads content/policies/*.json, embeds each doc's body via the Azure
// embedding deployment, and upserts into Mongo's policies collection.
// Also attempts to create an Atlas Vector Search index on `embedding` —
// best-effort only. lib/retrieval/search.ts always brute-forces cosine
// similarity in Node regardless (15 docs is trivial to score directly, and
// M0 free-tier Atlas Search availability is inconsistent), so this index
// isn't load-bearing for retrieval to work, just a nice-to-have if present.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dns from "node:dns";
import { MongoClient } from "mongodb";
import OpenAI from "openai";

if (!process.env.VERCEL) {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}

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
const POLICIES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "content",
  "policies",
);

const azureClient = new OpenAI({ apiKey: azureApiKey, baseURL: `${azureEndpoint}/openai/v1` });

async function main() {
  const files = readdirSync(POLICIES_DIR).filter((f) => f.endsWith(".json"));
  const docs = files.map((f) => JSON.parse(readFileSync(path.join(POLICIES_DIR, f), "utf8")));

  const client = new MongoClient(mongoUri);
  await client.connect();
  const policies = client.db(MONGO_DB_NAME).collection("policies");

  let embeddingDimensions = null;
  for (const doc of docs) {
    const { data } = await azureClient.embeddings.create({
      model: embeddingDeployment,
      input: doc.body,
    });
    const embedding = data[0].embedding;
    embeddingDimensions = embedding.length;

    await policies.replaceOne(
      { _id: doc.id },
      {
        _id: doc.id,
        title: doc.title,
        category: doc.category,
        region: doc.region,
        effective_from: doc.effective_from,
        superseded_by: doc.superseded_by,
        body: doc.body,
        embedding,
        embedded_at: new Date(),
      },
      { upsert: true },
    );
    console.log(`embedded + upserted: ${doc.id}`);
  }

  try {
    await policies.createSearchIndex({
      name: "policies_vector_index",
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: embeddingDimensions,
            similarity: "cosine",
          },
        ],
      },
    });
    console.log("Atlas Vector Search index created (or already existed).");
  } catch (err) {
    console.log(`Atlas Vector Search index not created (${err.message}) — retrieval falls back to brute-force, which is fine at 15 docs.`);
  }

  console.log(`\n${docs.length} policies seeded.`);
  await client.close();
}

await main();
