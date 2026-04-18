import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadConfig } from "../lib/config.js";
import * as schema from "./schema.js";

let _sql: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (_db) return _db;
  const cfg = loadConfig();
  _sql = postgres(cfg.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    prepare: false, // Supabase pooler compatibility
  });
  _db = drizzle(_sql, { schema });
  return _db;
}

export function getSql() {
  if (!_sql) getDb();
  return _sql!;
}

export { schema };
