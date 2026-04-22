import { logger } from "../lib/logger.js";
import { getLLM } from "../llm/index.js";
import { AGENT_SYSTEM } from "../llm/prompts/agent_v2.js";
import type { ToolCall } from "../llm/provider.js";
import type { Founder } from "../identity/gate.js";
import type { SearchStateRow } from "../conversation/store.js";
import type { CandidateCard, RankedResult } from "../matching/pipeline.js";
import type { WatiClient } from "../wati/client.js";
import type { AgentTurnResult, AgentButton } from "./types.js";
import { buildAgentContext } from "./context.js";
import {
  AGENT_TOOLS,
  handleFindCofounders,
  handleUpdateSearchState,
  handleGetFounderDetail,
  handleProposeIntro,
  handleMarkSkipped,
  handleFinishTurn,
} from "./tools/index.js";
import type { FounderDetail } from "./tools/get_founder_detail.js";

const MAX_ITERATIONS = 6;
const FALLBACK_REPLY = "Hit a snag on my end — try again in a moment.";

export interface RunAgentDeps {
  getSearchState: (convId: string) => Promise<SearchStateRow>;
  writeSearchState: (state: SearchStateRow) => Promise<void>;
  getRecentTurns: (convId: string) => Promise<Array<{ direction: "in" | "out"; text: string }>>;
  getShownFounderIds: (convId: string) => Promise<string[]>;
  runMatching: (args: {
    requesterId: string;
    state: SearchStateRow;
    userTurn: string;
    alreadyShownFounderIds: string[];
  }) => Promise<RankedResult>;
  recordShown: (convId: string, cards: CandidateCard[]) => Promise<boolean>;
  markShownAction: (convId: string, founderId: string, action: "accepted" | "skipped") => Promise<void>;
  fetchFounderDetail: (id: string) => Promise<FounderDetail | null>;
  propose: (args: { requesterId: string; targetId: string; requesterNote: string }) => Promise<void>;
  /**
   * Persist the outbound reply to the `turns` table. Called after a successful
   * WATI send so the agent sees its own replies in `getRecentTurns` on the
   * next turn and doesn't re-ask questions it already asked.
   */
  insertOutboundTurn: (args: { conversationId: string; text: string; intent?: string }) => Promise<void>;
}

export interface RunAgentArgs {
  founder: Founder;
  conversationId: string;
  userTurn: string;
  wati: Pick<WatiClient, "sendText" | "sendButtons">;
  deps: RunAgentDeps;
}

export async function runAgent(args: RunAgentArgs): Promise<AgentTurnResult> {
  const { founder, conversationId, userTurn, wati, deps } = args;

  let finishedPayload: { reply: string; buttons?: AgentButton[] } | null = null;
  let iterations = 0;
  let modelFinalText = "";

  try {
    const [state, recentTurns, shownIds] = await Promise.all([
      deps.getSearchState(conversationId),
      deps.getRecentTurns(conversationId),
      deps.getShownFounderIds(conversationId),
    ]);

    const ctxBlock = buildAgentContext({
      founder,
      recentTurns,
      searchState: state,
      shownFounderIds: shownIds,
    });

    const onToolCall = async (call: ToolCall): Promise<unknown> => {
      logger.info({ tool: call.name, convId: conversationId }, "agent tool call");
      switch (call.name) {
        case "find_cofounders":
          return handleFindCofounders(call.args, {
            requesterId: founder.id,
            conversationId,
            getState: deps.getSearchState,
            getShownFounderIds: deps.getShownFounderIds,
            runMatching: deps.runMatching,
            recordShown: deps.recordShown,
          });
        case "update_search_state":
          return handleUpdateSearchState(call.args, {
            conversationId,
            getState: deps.getSearchState,
            writeState: deps.writeSearchState,
          });
        case "get_founder_detail":
          return handleGetFounderDetail(call.args, { fetchFounder: deps.fetchFounderDetail });
        case "propose_intro":
          return handleProposeIntro(call.args, {
            requesterId: founder.id,
            propose: deps.propose,
            markAccepted: (id) => deps.markShownAction(conversationId, id, "accepted"),
          });
        case "mark_skipped":
          return handleMarkSkipped(call.args, {
            conversationId,
            markShownAction: deps.markShownAction,
          });
        case "finish_turn": {
          const result = handleFinishTurn(call.args);
          finishedPayload = { reply: result.reply, ...(result.buttons ? { buttons: result.buttons } : {}) };
          return { done: true };
        }
        default:
          return { error: `unknown tool: ${call.name}` };
      }
    };

    const result = await getLLM().agentLoop({
      system: AGENT_SYSTEM,
      messages: [{ role: "user", content: `${ctxBlock}\n\nUSER_TURN: ${userTurn}` }],
      tools: AGENT_TOOLS,
      onToolCall,
      maxIterations: MAX_ITERATIONS,
      temperature: 0.9,
    });
    iterations = result.toolCallCount;
    modelFinalText = result.finalText ?? "";
  } catch (err) {
    logger.error({ err, convId: conversationId }, "agent loop threw");
  }

  if (!finishedPayload) {
    // If the model emitted free text but skipped finish_turn, surface that
    // text rather than the static "Hit a snag" — a bad reply is still better
    // than a degraded one. Falls back to the static message only on hard
    // errors where we have nothing.
    const rescueText = modelFinalText.trim();
    const reply = rescueText || FALLBACK_REPLY;
    const intent = rescueText ? "agent-rescue" : "agent-fallback";
    logger.warn(
      { convId: conversationId, iterations, usedRescueText: Boolean(rescueText) },
      "agent did not call finish_turn — falling back",
    );
    await wati.sendText({ waId: founder.phone, text: reply });
    // Persist the fallback reply too — otherwise the agent on the next turn
    // has no idea it just dropped a degraded reply and may repeat itself.
    try {
      await deps.insertOutboundTurn({
        conversationId,
        text: reply,
        intent,
      });
    } catch (err) {
      logger.warn({ err, convId: conversationId }, "failed to persist fallback outbound turn");
    }
    return { reply, cleanFinish: false, iterations };
  }

  const payload: { reply: string; buttons?: AgentButton[] } = finishedPayload;

  if (payload.buttons && payload.buttons.length > 0) {
    await wati.sendButtons({
      waId: founder.phone,
      body: payload.reply,
      buttons: payload.buttons.map((b) => ({ text: b.title })),
    });
  } else {
    await wati.sendText({ waId: founder.phone, text: payload.reply });
  }

  // Persist after send — if the send throws, the loop also throws and we
  // correctly don't record an outbound that never went. Persistence failure
  // here shouldn't block the reply (user already got it) but should log.
  try {
    await deps.insertOutboundTurn({
      conversationId,
      text: payload.reply,
      intent: "agent",
    });
  } catch (err) {
    logger.warn({ err, convId: conversationId }, "failed to persist outbound turn");
  }

  return {
    reply: payload.reply,
    ...(payload.buttons ? { buttons: payload.buttons } : {}),
    cleanFinish: true,
    iterations,
  };
}
