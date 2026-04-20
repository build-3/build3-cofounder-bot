import { z } from "zod";
import { getLLM } from "../llm/index.js";
import { logger } from "../lib/logger.js";
import {
  buildRefinementUserPrompt,
  REFINEMENT_SYSTEM,
  type RefinementPromptInput,
} from "../llm/prompts/refinement_v3.js";
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

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs.filter(Boolean)));
}

function titleCase(text: string): string {
  return text
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Merge a delta into a SearchStateRow, producing a new row. Never mutates. */
export function applyDelta(state: SearchStateRow, delta: RefinementDelta): SearchStateRow {
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
  return heuristicDelta(
    {
      conversationId: "heuristic",
      role: null,
      sector: [],
      stage: [],
      location: [],
      seniority: null,
      mustHave: [],
      niceToHave: [],
      antiPrefs: [],
    },
    userTurn,
  );
}

function inferRequestedRole(text: string): RefinementDelta["add"]["role"] | undefined {
  const t = text.toLowerCase();
  const patterns: Array<[RegExp, NonNullable<RefinementDelta["add"]["role"]>]> = [
    [/\b(tech|technical|engineering|engineer)\b/, "technical"],
    [/\b(sales|gtm|business development|bd)\b/, "sales"],
    [/\b(growth|marketing)\b/, "growth"],
    [/\b(product|pm)\b/, "product"],
    [/\b(ops|operations)\b/, "ops"],
    [/\b(design|designer)\b/, "design"],
  ];

  for (const [pattern, role] of patterns) {
    if (pattern.test(t)) return role;
  }
  return undefined;
}

function inferComplementHints(userTurn: string): string[] {
  const t = userTurn.toLowerCase();
  const hints: string[] = [];

  if (/\b(i have|i bring|i'm strong on|i am strong on)\b/.test(t) && /\b(marketing|growth|sales|gtm|bd)\b/.test(t)) {
    hints.push("should want a strong GTM / non-tech partner");
  }
  if (/\b(i have|i bring|i'm strong on|i am strong on)\b/.test(t) && /\b(product|pm|design|ops)\b/.test(t)) {
    hints.push("should value a product-minded operating partner");
  }
  if (/\b(i have|i bring|i'm strong on|i am strong on)\b/.test(t) && /\b(tech|technical|engineering|engineer)\b/.test(t)) {
    hints.push("should want a strong technical partner");
  }

  const explicitNeed = t.match(/\b(i have|i bring)\b[\s\S]{0,80}\bneed\b[\s\S]{0,80}\b(tech|technical|engineering|engineer)\b/);
  if (explicitNeed) hints.push("should want a strong GTM / non-tech partner");

  const startupMatch = t.match(/\b(my startup is|we're building in|we are building in|startup is|in sector)\b\s+([a-z0-9 /-]{3,40})/i);
  if (startupMatch?.[2]) {
    const phrase = startupMatch[2]
      .trim()
      .replace(/\.$/, "")
      .replace(/\bmy\b/gi, "")
      .trim();
    if (phrase && !/\b(fintech|healthtech|edtech|b2b|b2b-saas|d2c|climate|logistics|ai-infra|devtools|marketplaces|social)\b/i.test(phrase)) {
      hints.push(`startup context: ${phrase}`);
    }
  }

  if (/\bhigh probability match\b/.test(t)) {
    hints.push("should feel like a strong mutual cofounder fit");
  }

  return uniq(hints);
}

function isRestart(userTurn: string, state: SearchStateRow): boolean {
  const t = userTurn.toLowerCase();
  const restartCue = /\b(actually|instead|switch|change|different|new search|restart|start over|fresh)\b/;
  const freshAskCue = /\b(find|looking for|need|want|match me|get me|show me)\b/;
  const activeSearch = Boolean(
    state.role ||
      state.sector.length ||
      state.stage.length ||
      state.location.length ||
      state.seniority ||
      state.mustHave.length ||
      state.niceToHave.length,
  );

  if (restartCue.test(t)) return true;
  if (!activeSearch) return false;
  if (freshAskCue.test(t)) return true;
  return false;
}

export function heuristicDelta(state: SearchStateRow, userTurn: string): RefinementDelta {
  const t = userTurn.toLowerCase();
  const add: RefinementDelta["add"] = {};
  const antiPrefs: string[] = [];
  const restart = isRestart(userTurn, state);

  const role = inferRequestedRole(userTurn);
  if (role) add.role = role;

  const sectorTags = ["fintech", "healthtech", "edtech", "b2b-saas", "d2c", "climate", "logistics", "ai-infra", "devtools", "marketplaces", "social"];
  const sectors = sectorTags.filter((sector) => t.includes(sector));
  if (sectors.length) add.sector = sectors;
  if (/\bb2b\b/.test(t) && !add.sector?.includes("b2b-saas")) {
    add.sector = [...(add.sector ?? []), "b2b-saas"];
  }

  const locationMap = ["bangalore", "mumbai", "delhi", "ncr", "pune", "hyderabad", "chennai", "singapore", "san francisco", "new york", "london", "remote"];
  const locations = locationMap.filter((location) => t.includes(location));
  if (locations.length) {
    add.location = locations.map((location) => (location === "ncr" ? "Delhi NCR" : titleCase(location)));
  }

  const stages = ["pre-idea", "pre-seed", "seed", "series-a", "growth"].filter((stage) => t.includes(stage));
  if (stages.length) add.stage = stages;

  if (/founder[- ]level|high probability match|serious operator|not.*operator/.test(t)) add.seniority = "founder-level";
  if (/senior ic|individual contributor/.test(t)) add.seniority = "senior-ic";

  const complementHints = inferComplementHints(userTurn);
  if (complementHints.length) add.must_have = complementHints;

  const negativePattern = /\b(not|no|avoid|except|skip)\b\s+([a-z][\w-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = negativePattern.exec(userTurn)) !== null) antiPrefs.push(match[2]!.toLowerCase());

  const remove = restart
    ? {
        sector: [...state.sector],
        stage: [...state.stage],
        location: [...state.location],
        must_have: [...state.mustHave],
        nice_to_have: [...state.niceToHave],
      }
    : {};

  if (restart) {
    if (add.sector?.length) remove.sector = state.sector.filter((value) => !add.sector?.includes(value));
    if (add.stage?.length) remove.stage = state.stage.filter((value) => !add.stage?.includes(value));
    if (add.location?.length) remove.location = state.location.filter((value) => !add.location?.includes(value));
  }

  return { add, remove, anti_prefs: uniq(antiPrefs) };
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
    return heuristicDelta(state, userTurn);
  }
}
