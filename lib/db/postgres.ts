import { neonConfig, Pool, neon } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Missing required env var: DATABASE_URL");
}

// Default client: HTTP, no held-open connection, so concurrent invocations can't exhaust the pool.
export const sql = neon(databaseUrl);

const globalForPg = globalThis as unknown as { pgPool?: Pool };

// Escape hatch for steps needing a real multi-statement session; cached to survive warm invocations / dev reloads.
export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = new Pool({ connectionString: databaseUrl });
  }
  return globalForPg.pgPool;
}
