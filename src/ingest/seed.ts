import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSql } from "../db/client.js";
import { getLLM } from "../llm/index.js";
import { logger } from "../lib/logger.js";
import { parseCsv } from "./csv.js";

/**
 * Ingest a founders CSV into Postgres + generate embeddings.
 * - Upserts on `phone` (unique).
 * - Embeds a composed string: name + headline + summary + role_tags + sector_tags.
 *   Raw `skills`/noisy fields are intentionally excluded (see MATCHING.md).
 *
 * Usage: `npm run seed:load -- data/seed_founders.csv`  (default: data/seed_founders.csv)
 */

function composeEmbedText(r: {
  name: string;
  headline: string;
  summary: string;
  role_tags: string[];
  sector_tags: string[];
  stage_tags: string[];
  city: string;
  seniority: string;
}): string {
  return [
    `${r.name} — ${r.city}`,
    r.headline,
    r.summary,
    `Role tags: ${r.role_tags.join(", ")}`,
    `Sector tags: ${r.sector_tags.join(", ")}`,
    `Stage tags: ${r.stage_tags.join(", ")}`,
    `Seniority: ${r.seniority}`,
  ].join("\n");
}

function toPgVectorLiteral(vec: number[]): string {
  // pgvector accepts '[1,2,3]' as a text literal.
  return `[${vec.join(",")}]`;
}

function splitTags(s: string): string[] {
  return s.split("|").map((t) => t.trim()).filter(Boolean);
}

export async function ingestCsv(csvPath: string): Promise<{ inserted: number; updated: number }> {
  const raw = await readFile(csvPath, "utf8");
  const rows = parseCsv(raw);
  logger.info({ csvPath, rows: rows.length }, "parsed founders CSV");

  const sql = getSql();
  const llm = getLLM();

  // Batch embeddings in chunks of 64 to avoid huge payloads.
  const BATCH = 64;
  let inserted = 0;
  let updated = 0;

  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH).map((r) => ({
      phone: r.phone!,
      name: r.name!,
      email: r.email || null,
      city: r.city!,
      headline: r.headline!,
      summary: r.summary!,
      role_tags: splitTags(r.role_tags ?? ""),
      sector_tags: splitTags(r.sector_tags ?? ""),
      stage_tags: splitTags(r.stage_tags ?? ""),
      seniority: r.seniority!,
      years_exp: Number(r.years_exp ?? 0),
    }));

    const embedInputs = batch.map((r) => composeEmbedText(r));
    const vectors = await llm.embed(embedInputs);
    if (vectors.length !== batch.length) {
      throw new Error(`embed returned ${vectors.length} vectors for ${batch.length} inputs`);
    }

    // Single transaction per batch.
    await sql.begin(async (tx) => {
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i]!;
        const vec = toPgVectorLiteral(vectors[i]!);
        const result = await tx`
          INSERT INTO founders
            (phone, name, email, city, headline, summary,
             role_tags, sector_tags, stage_tags, seniority, years_exp, raw_profile)
          VALUES (${r.phone}, ${r.name}, ${r.email}, ${r.city}, ${r.headline}, ${r.summary},
                  ${r.role_tags}, ${r.sector_tags}, ${r.stage_tags}, ${r.seniority}, ${r.years_exp},
                  ${sql.json({ source: "csv" })})
          ON CONFLICT (phone) DO UPDATE SET
            name        = EXCLUDED.name,
            email       = EXCLUDED.email,
            city        = EXCLUDED.city,
            headline    = EXCLUDED.headline,
            summary     = EXCLUDED.summary,
            role_tags   = EXCLUDED.role_tags,
            sector_tags = EXCLUDED.sector_tags,
            stage_tags  = EXCLUDED.stage_tags,
            seniority   = EXCLUDED.seniority,
            years_exp   = EXCLUDED.years_exp
          RETURNING id, (xmax = 0) AS inserted
        `;
        const founderId = (result[0] as { id: string }).id;
        const wasInserted = (result[0] as { inserted: boolean }).inserted;
        if (wasInserted) inserted++; else updated++;

        await tx.unsafe(
          `
          INSERT INTO founder_embeddings (founder_id, embedding, updated_at)
          VALUES ($1, $2::vector, now())
          ON CONFLICT (founder_id) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            updated_at = now()
          `,
          [founderId, vec],
        );
      }
    });

    logger.info({ processed: Math.min(start + BATCH, rows.length), total: rows.length }, "batch done");
  }

  return { inserted, updated };
}

async function main() {
  const csvPath = path.resolve(process.argv[2] ?? "data/seed_founders.csv");
  const result = await ingestCsv(csvPath);
  logger.info(result, "ingest complete");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, "ingest failed");
    process.exit(1);
  });
}
