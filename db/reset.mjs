// Drops every table in Postgres (schema_migrations included) and drops the
// Mongo database entirely — a true clean slate. Run `npm run db:migrate`
// afterward to recreate the Postgres schema before using the app again.

import dns from "node:dns";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { MongoClient } from "mongodb";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

// See lib/db/mongo.ts: Windows resolver workaround, local-dev-only.
if (!process.env.VERCEL) {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}

const databaseUrl = process.env.DATABASE_URL;
const mongoUri = process.env.MONGODB_URI;

if (!databaseUrl) {
  console.error("Missing required env var: DATABASE_URL");
  process.exit(1);
}
if (!mongoUri) {
  console.error("Missing required env var: MONGODB_URI");
  process.exit(1);
}

// Must match lib/db/mongo.ts's DEFAULT_DB_NAME.
const MONGO_DB_NAME = "refund_triage";

async function resetPostgres() {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await pool.end();
  }
  console.log("postgres: schema dropped (run npm run db:migrate to recreate)");
}

async function resetMongo() {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    await client.db(MONGO_DB_NAME).dropDatabase();
  } finally {
    await client.close();
  }
  console.log(`mongo: database "${MONGO_DB_NAME}" dropped`);
}

await Promise.all([resetPostgres(), resetMongo()]);
console.log("reset complete");
