import type { Sql } from "postgres";
import { getSql } from "../db/client.js";
import type { FounderDetail } from "../agent/tools/get_founder_detail.js";

export interface Founder {
  id: string;
  phone: string;
  name: string;
  city: string;
  headline: string;
  summary: string;
  roleTags: string[];
  sectorTags: string[];
  stageTags: string[];
  seniority: string;
  optedIn: boolean;
}

/**
 * Normalize a phone to E.164 without the leading '+'. WATI sends it this way
 * (`waId = '919876543210'`) and our `founders.phone` stores the same shape.
 * We strip spaces, dashes, parens, and any leading '+' / '00'.
 */
export function normalizePhone(raw: string): string {
  let p = raw.trim().replace(/[\s\-()]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  else if (p.startsWith("00")) p = p.slice(2);
  return p;
}

export async function fetchFounderById(
  id: string,
  sql: Sql = getSql(),
): Promise<FounderDetail | null> {
  const rows = await sql<Array<{
    name: string; city: string; headline: string; summary: string;
    role_tags: string[]; sector_tags: string[]; stage_tags: string[];
    seniority: string;
  }>>`
    SELECT name, city, headline, summary, role_tags, sector_tags, stage_tags, seniority
    FROM founders
    WHERE id = ${id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    city: row.city,
    headline: row.headline,
    summary: row.summary,
    role_tags: row.role_tags,
    sector_tags: row.sector_tags,
    stage_tags: row.stage_tags,
    seniority: row.seniority,
  };
}

export async function findFounderByPhone(waId: string, sql: Sql = getSql()): Promise<Founder | null> {
  const phone = normalizePhone(waId);
  const rows = await sql<Array<{
    id: string; phone: string; name: string; city: string;
    headline: string; summary: string;
    role_tags: string[]; sector_tags: string[]; stage_tags: string[];
    seniority: string; opted_in: boolean;
  }>>`
    SELECT id, phone, name, city, headline, summary,
           role_tags, sector_tags, stage_tags, seniority, opted_in
    FROM founders
    WHERE phone = ${phone}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    city: row.city,
    headline: row.headline,
    summary: row.summary,
    roleTags: row.role_tags,
    sectorTags: row.sector_tags,
    stageTags: row.stage_tags,
    seniority: row.seniority,
    optedIn: row.opted_in,
  };
}
