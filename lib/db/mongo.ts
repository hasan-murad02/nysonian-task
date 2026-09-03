import dns from "node:dns";
import { MongoClient, type Db } from "mongodb";

// Local-dev-only: Windows reports invalid legacy site-local IPv6 "DNS
// servers" on several adapters, which Node's resolver picks over the real
// one, breaking the +srv lookup with ECONNREFUSED. Never runs on Vercel.
if (!process.env.VERCEL) {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  throw new Error("Missing required env var: MONGODB_URI");
}

const DEFAULT_DB_NAME = "refund_triage";

// Cached on globalThis so dev reloads and warm serverless invocations reuse one connection.
const globalForMongo = globalThis as unknown as {
  mongoClientPromise?: Promise<MongoClient>;
};

if (!globalForMongo.mongoClientPromise) {
  globalForMongo.mongoClientPromise = new MongoClient(mongoUri).connect();
}

export const mongoClientPromise = globalForMongo.mongoClientPromise;

export async function getMongoDb(dbName: string = DEFAULT_DB_NAME): Promise<Db> {
  const client = await mongoClientPromise;
  return client.db(dbName);
}
