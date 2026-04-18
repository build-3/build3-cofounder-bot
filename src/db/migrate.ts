import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";

/**
 * Minimal idempotent migration runner.
 * Each `.sql` file under `src/db/migrations/` is executed in lexicographic
 * order inside a single transaction per file. Files are expected to be
 * idempotent (CREATE IF NOT EXISTS, etc.) in MVP. We track applied files in
 * `_migrations`; re-applying is safe because of the idempotent SQL.
 */
async function main() {
  const cfg = loadConfig();
  const sql = postgres(cfg.DATABASE_URL, { max: 1, prepare: false });

  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.join(here, "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    for (const f of files) {
      const already = await sql`SELECT 1 FROM _migrations WHERE name = ${f}`;
      const body = await readFile(path.join(dir, f), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`
          INSERT INTO _migrations (name) VALUES (${f})
          ON CONFLICT (name) DO NOTHING
        `;
      });
      logger.info({ file: f, previouslyApplied: already.length > 0 }, "migration applied");
    }
    logger.info({ count: files.length }, "migrations complete");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  logger.error({ err }, "migration failed");
  process.exit(1);
});
