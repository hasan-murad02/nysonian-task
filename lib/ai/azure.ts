import OpenAI from "openai";

const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_API_KEY;
if (!endpoint) throw new Error("Missing required env var: AZURE_OPENAI_ENDPOINT");
if (!apiKey) throw new Error("Missing required env var: AZURE_OPENAI_API_KEY");

const chatDeployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
const embeddingDeployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
if (!chatDeployment) throw new Error("Missing required env var: AZURE_OPENAI_CHAT_DEPLOYMENT");
if (!embeddingDeployment) throw new Error("Missing required env var: AZURE_OPENAI_EMBEDDING_DEPLOYMENT");

// Typed as plain string exports (not string | undefined) — TS doesn't
// narrow an exported const's type past the guards above for other files
// importing it, so these need their own explicit annotation.
export const CHAT_DEPLOYMENT: string = chatDeployment;
export const EMBEDDING_DEPLOYMENT: string = embeddingDeployment;

// This resource is a Foundry project endpoint (services.ai.azure.com), not
// a classic per-resource Azure OpenAI endpoint — the plain OpenAI client
// pointed at {endpoint}/openai/v1 works and needs no api-version param.
// maxDuration=60 on the webhook route bounds the whole synchronous chain
// this client sits in, so keep this client's own timeout well under that.
export const azureClient = new OpenAI({
  apiKey,
  baseURL: `${endpoint}/openai/v1`,
  timeout: 20_000,
});
