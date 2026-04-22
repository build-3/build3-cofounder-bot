import type { Founder } from "../identity/gate.js";
import type { SearchStateRow } from "../conversation/store.js";

export interface AgentContextInput {
  founder: Founder;
  recentTurns: Array<{ direction: "in" | "out"; text: string }>;
  searchState: SearchStateRow;
  shownFounderIds: string[];
}

/**
 * Build the context block prepended to the user turn. Keeps the agent
 * grounded in who the user is, what they've said so far, and what's already
 * been surfaced — so it doesn't repeat cards or ask things already answered.
 */
export function buildAgentContext(input: AgentContextInput): string {
  const { founder, recentTurns, searchState, shownFounderIds } = input;

  const turns = recentTurns
    .slice(-8)
    .map((t) => `${t.direction === "in" ? "USER" : "BOT"}: ${t.text}`)
    .join("\n");

  const state: Record<string, string | number> = {};
  if (searchState.role) state["role_wanted"] = searchState.role;
  if (searchState.sector.length) state["sector"] = searchState.sector.join(", ");
  if (searchState.stage.length) state["stage"] = searchState.stage.join(", ");
  if (searchState.location.length) state["location"] = searchState.location.join(", ");
  if (searchState.seniority) state["seniority"] = searchState.seniority;
  if (searchState.mustHave.length) state["must_have"] = searchState.mustHave.join("; ");
  if (searchState.antiPrefs.length) state["anti_prefs"] = searchState.antiPrefs.join("; ");

  const stateStr = Object.entries(state).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(empty)";

  return [
    `FOUNDER`,
    `- name: ${founder.name}`,
    `- city: ${founder.city}`,
    `- their own headline: ${founder.headline}`,
    ``,
    `RECENT_TURNS`,
    turns || "(none)",
    ``,
    `SEARCH_STATE`,
    stateStr,
    ``,
    `ALREADY_SHOWN_FOUNDER_IDS (${shownFounderIds.length})`,
    shownFounderIds.length ? shownFounderIds.join(", ") : "(none)",
  ].join("\n");
}
