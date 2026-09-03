// Applies db/migrations/*.sql in order; tracks applied files in schema_migrations so reruns are a no-op.
// Uses the WebSocket Pool, not lib/db/postgres.ts's HTTP client, since a migration file can hold multiple statements.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing required env var: DATABASE_URL");
  process.exit(1);
}

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const pool = new Pool({ connectionString: databaseUrl });

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
  `);

  const { rows: applied } = await pool.query(
    "SELECT filename FROM schema_migrations",
  );
  const appliedFiles = new Set(applied.map((row) => row.filename));

  for (const file of files) {
    if (appliedFiles.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }

    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      console.log(`apply ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("migrations up to date");
}

try {
  await main();
} finally {
  await pool.end();
}
