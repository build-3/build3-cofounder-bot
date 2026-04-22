import type { ToolDefinition } from "../../llm/provider.js";
import { findCofoundersSchema } from "./find_cofounders.js";
import { updateSearchStateSchema } from "./update_search_state.js";
import { proposeIntroSchema } from "./propose_intro.js";
import { markSkippedSchema } from "./mark_skipped.js";
import { getFounderDetailSchema } from "./get_founder_detail.js";
import { finishTurnSchema } from "./finish_turn.js";

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "find_cofounders",
    description: "Search the cohort for cofounder matches. Returns ranked founders the user could talk to. Use the user's own words as the query.",
    parameters: findCofoundersSchema,
  },
  {
    name: "update_search_state",
    description: "Update the structured search state (role/sector/stage/location/must-have/anti-prefs). Call this whenever the user expresses a preference.",
    parameters: updateSearchStateSchema,
  },
  {
    name: "get_founder_detail",
    description: "Fetch the full public profile for a founder the user is asking a follow-up question about.",
    parameters: getFounderDetailSchema,
  },
  {
    name: "propose_intro",
    description: "Send an intro request to a target founder. Only call this when the user explicitly says Accept / yes / connect to a previously shown founder.",
    parameters: proposeIntroSchema,
  },
  {
    name: "mark_skipped",
    description: "Record that the user skipped a previously shown founder. Adds a soft anti-preference.",
    parameters: markSkippedSchema,
  },
  {
    name: "finish_turn",
    description: "Emit the user-facing reply and optional buttons. YOU MUST CALL THIS EXACTLY ONCE per inbound, as your last tool call.",
    parameters: finishTurnSchema,
  },
];

export {
  handleFindCofounders,
  findCofoundersSchema,
} from "./find_cofounders.js";
export {
  handleUpdateSearchState,
  updateSearchStateSchema,
} from "./update_search_state.js";
export {
  handleGetFounderDetail,
  getFounderDetailSchema,
} from "./get_founder_detail.js";
export {
  handleProposeIntro,
  proposeIntroSchema,
} from "./propose_intro.js";
export {
  handleMarkSkipped,
  markSkippedSchema,
} from "./mark_skipped.js";
export {
  handleFinishTurn,
  finishTurnSchema,
} from "./finish_turn.js";
