import { z } from "zod";
import { getLLM } from "../llm/index.js";
import { logger } from "../lib/logger.js";
import {
  buildRefinementUserPrompt,
  REFINEMENT_SYSTEM,
  type RefinementPromptInput,
} from "../llm/prompts/refinement_v2.js";
import type { SearchStateRow } from "../conversation/store.js";

const PartialAddSchema = z.object({
  role: z.enum(["technical", "sales", "growth", "product", "ops", "design"]).nullable().optional(),
  sector: z.array(z.string()).optional(),
  stage: z.array(z.string()).optional(),
  location: z.array(z.string()).optional(),
  seniority: z.enum(["operator", "founder-level", "senior-ic"]).nullable().optional(),
  must_have: z.array(z.string()).optional(),
  nice_to_have: z.array(z.string()).optional(),
}).passthrough();

const PartialRemoveSchema = z.object({
  sector: z.array(z.string()).optional(),
  stage: z.array(z.string()).optional(),
  location: z.array(z.string()).optional(),
  must_have: z.array(z.string()).optional(),
  nice_to_have: z.array(z.string()).optional(),
}).passthrough();

export const RefinementDeltaSchema = z.object({
  add: PartialAddSchema.default({}),
  remove: PartialRemoveSchema.default({}),
  anti_prefs: z.array(z.string()).default([]),
});
export type RefinementDelta = z.infer<typeof RefinementDeltaSchema>;

/** Merge a delta into a SearchStateRow, producing a new row. Never mutates. */
export function applyDelta(state: SearchStateRow, delta: RefinementDelta): SearchStateRow {
  const uniq = (xs: string[]) => Array.from(new Set(xs));
  const minus = (a: string[], b: string[] | undefined) =>
    b && b.length ? a.filter((x) => !b.includes(x)) : a;

  return {
    conversationId: state.conversationId,
    role: delta.add.role ?? state.role,
    seniority: delta.add.seniority ?? state.seniority,
    sector: uniq(minus([...state.sector, ...(delta.add.sector ?? [])], delta.remove.sector)),
    stage: uniq(minus([...state.stage, ...(delta.add.stage ?? [])], delta.remove.stage)),
    location: uniq(minus([...state.location, ...(delta.add.location ?? [])], delta.remove.location)),
    mustHave: uniq(minus([...state.mustHave, ...(delta.add.must_have ?? [])], delta.remove.must_have)),
    niceToHave: uniq(minus([...state.niceToHave, ...(delta.add.nice_to_have ?? [])], delta.remove.nice_to_have)),
    antiPrefs: uniq([...state.antiPrefs, ...delta.anti_prefs]),
  };
}

/**
 * Deterministic fallback keyword extractor. Cheap safety net when the LLM path
 * fails. Intentionally conservative — only extracts what it's sure about.
 */
export function keywordDelta(userTurn: string): RefinementDelta {
  const t = userTurn.toLowerCase();
  const add: RefinementDelta["add"] = {};
  const antiPrefs: string[] = [];

  const ROLE_MAP: Record<string, NonNullable<RefinementDelta["add"]["role"]>> = {
    technical: "technical", engineer: "technical", engineering: "technical", tech: "technical",
    sales: "sales", gtm: "sales", bd: "sales",
    growth: "growth", marketing: "growth",
    product: "product", pm: "product",
    ops: "ops", operations: "ops",
    design: "design", designer: "design",
  };
  for (const [k, v] of Object.entries(ROLE_MAP)) {
    if (new RegExp(`\\b${k}\\b`).test(t)) { add.role = v; break; }
  }

  const SECTOR_TAGS = ["fintech", "healthtech", "edtech", "b2b-saas", "d2c", "climate", "logistics", "ai-infra", "devtools", "marketplaces", "social"];
  const sectors = SECTOR_TAGS.filter((s) => t.includes(s));
  if (sectors.length) add.sector = sectors;

  if (/\bb2b\b/.test(t) && !add.sector?.includes("b2b-saas")) {
    add.sector = [...(add.sector ?? []), "b2b-saas"];
  }

  const LOC_MAP = ["bangalore", "mumbai", "delhi", "ncr", "pune", "hyderabad", "chennai", "singapore", "san francisco", "new york", "london", "remote"];
  const locs = LOC_MAP.filter((l) => t.includes(l));
  if (locs.length) add.location = locs.map((l) => (l === "ncr" ? "Delhi NCR" : l.replace(/\b\w/g, (c) => c.toUpperCase())));

  if (/founder[- ]level|not.*operator/.test(t)) add.seniority = "founder-level";
  if (/senior ic|individual contributor/.test(t)) add.seniority = "senior-ic";

  const NEG = /\b(not|no|avoid|except|skip)\b\s+([a-z][\w-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = NEG.exec(userTurn)) !== null) antiPrefs.push(m[2]!.toLowerCase());

  return { add, remove: {}, anti_prefs: antiPrefs };
}

export async function extractRefinement(
  state: SearchStateRow,
  userTurn: string,
): Promise<RefinementDelta> {
  const promptInput: RefinementPromptInput = {
    currentState: {
      role: state.role,
      sector: state.sector,
      stage: state.stage,
      location: state.location,
      seniority: state.seniority,
      mustHave: state.mustHave,
      niceToHave: state.niceToHave,
      antiPrefs: state.antiPrefs,
    },
    userTurn,
  };

  try {
    return await getLLM().json<RefinementDelta>({
      system: REFINEMENT_SYSTEM,
      user: buildRefinementUserPrompt(promptInput),
      schemaName: "RefinementDelta",
      temperature: 0,
      parse: (raw) => RefinementDeltaSchema.parse(JSON.parse(raw)),
    });
  } catch (err) {
    logger.warn({ err }, "refinement extractor fell back to keyword parser");
    return keywordDelta(userTurn);
  }
}
