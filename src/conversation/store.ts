import type { Sql } from "postgres";
import { getSql } from "../db/client.js";

export interface ConversationRow {
  id: string;
  founderId: string;
  status: string;
}

export interface SearchStateRow {
  conversationId: string;
  role: string | null;
  sector: string[];
  stage: string[];
  location: string[];
  seniority: string | null;
  mustHave: string[];
  niceToHave: string[];
  antiPrefs: string[];
}

export async function getOrCreateConversation(
  founderId: string,
  sql: Sql = getSql(),
): Promise<ConversationRow> {
  const existing = await sql<Array<{ id: string; founder_id: string; status: string }>>`
    SELECT id, founder_id, status
    FROM conversations
    WHERE founder_id = ${founderId} AND status = 'active'
    ORDER BY last_active_at DESC
    LIMIT 1
  `;
  if (existing[0]) {
    const row = existing[0];
    await sql`UPDATE conversations SET last_active_at = now() WHERE id = ${row.id}`;
    return { id: row.id, founderId: row.founder_id, status: row.status };
  }
  const inserted = await sql<Array<{ id: string }>>`
    INSERT INTO conversations (founder_id) VALUES (${founderId})
    RETURNING id
  `;
  const convId = inserted[0]!.id;
  await sql`
    INSERT INTO search_state (conversation_id) VALUES (${convId})
    ON CONFLICT (conversation_id) DO NOTHING
  `;
  return { id: convId, founderId, status: "active" };
}

/**
 * Insert an inbound turn. Returns true if inserted, false if duplicate
 * (wati_message_id already present). Feature code MUST short-circuit on false.
 */
export async function insertInboundTurn(args: {
  conversationId: string;
  watiMessageId: string;
  text: string;
  intent?: string;
}, sql: Sql = getSql()): Promise<boolean> {
  const result = await sql<Array<{ id: string }>>`
    INSERT INTO turns (conversation_id, direction, wati_message_id, text, intent)
    VALUES (${args.conversationId}, 'in', ${args.watiMessageId}, ${args.text}, ${args.intent ?? null})
    ON CONFLICT (wati_message_id) WHERE wati_message_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  return result.length > 0;
}

export async function insertOutboundTurn(args: {
  conversationId: string;
  text: string;
  intent?: string;
}, sql: Sql = getSql()): Promise<void> {
  await sql`
    INSERT INTO turns (conversation_id, direction, text, intent)
    VALUES (${args.conversationId}, 'out', ${args.text}, ${args.intent ?? null})
  `;
}

export async function getSearchState(
  conversationId: string,
  sql: Sql = getSql(),
): Promise<SearchStateRow> {
  const rows = await sql<Array<{
    conversation_id: string;
    role: string | null;
    sector: string[]; stage: string[]; location: string[];
    seniority: string | null;
    must_have: string[]; nice_to_have: string[]; anti_prefs: string[];
  }>>`
    SELECT conversation_id, role, sector, stage, location, seniority,
           must_have, nice_to_have, anti_prefs
    FROM search_state WHERE conversation_id = ${conversationId}
  `;
  const r = rows[0];
  if (!r) {
    return {
      conversationId, role: null, sector: [], stage: [], location: [],
      seniority: null, mustHave: [], niceToHave: [], antiPrefs: [],
    };
  }
  return {
    conversationId: r.conversation_id,
    role: r.role,
    sector: r.sector,
    stage: r.stage,
    location: r.location,
    seniority: r.seniority,
    mustHave: r.must_have,
    niceToHave: r.nice_to_have,
    antiPrefs: r.anti_prefs,
  };
}

export async function writeSearchState(
  next: SearchStateRow,
  sql: Sql = getSql(),
): Promise<void> {
  await sql`
    INSERT INTO search_state
      (conversation_id, role, sector, stage, location, seniority,
       must_have, nice_to_have, anti_prefs, updated_at)
    VALUES
      (${next.conversationId}, ${next.role}, ${next.sector}, ${next.stage}, ${next.location},
       ${next.seniority}, ${next.mustHave}, ${next.niceToHave}, ${next.antiPrefs}, now())
    ON CONFLICT (conversation_id) DO UPDATE SET
      role          = EXCLUDED.role,
      sector        = EXCLUDED.sector,
      stage         = EXCLUDED.stage,
      location      = EXCLUDED.location,
      seniority     = EXCLUDED.seniority,
      must_have     = EXCLUDED.must_have,
      nice_to_have  = EXCLUDED.nice_to_have,
      anti_prefs    = EXCLUDED.anti_prefs,
      updated_at    = now()
  `;
}
