# Gemini Agent Rewrite — Design Spec
_2026-04-22_

## What we're building

Replace the deterministic intent-router + templated card pipeline with a single
Gemini 2.5 Pro agent loop. Gemini owns the entire turn: it reads the inbound
message, decides what to do, calls tools, writes the reply in its own voice.
The old dispatcher, intent classifier, voice templates, and card formatter are
deleted. The agent is the product.

---

## Hard constraints (non-negotiable)

1. **Exactly one outbound reply per inbound message.** The DB lock and
   idempotency guard stay. The agent MUST call `finish_turn` exactly once per
   invocation.
2. **Never reveal a target's profile before mutual consent.** The
   `propose_intro` tool enforces this. The agent never has access to target
   details beyond what `find_cofounders` returns (name, city, headline).
3. **Whitelist-only during testing.** Only two numbers may receive any reply:
   `917397599542` and `918468090511` (E.164, no +). All other inbounds are
   logged and dropped silently — webhook returns 200, no outbound.
4. **Safety net on agent failure.** If the agent loop throws, exceeds 6
   iterations without calling `finish_turn`, or returns an empty reply, send
   one static fallback: `"Hit a snag on my end — try again in a moment."` Log
   the full error for debugging.
5. **Prompts are versioned.** New agent prompt lives at
   `src/llm/prompts/agent_v1.ts`. Never edit a shipped version in place.

---

## What gets deleted

- `src/conversation/voice.ts` — intent classifier, composeReply, situation
  templates, minimalFallback. Gone.
- `src/llm/prompts/voice_v*.ts` — all voice prompt files. Gone.
- `src/llm/prompts/rerank_v*.ts` — rerank prompt files (reranker logic moves
  inside the `find_cofounders` tool, called internally).
- `src/wati/dispatcher.ts` — the entire route() switch, onDiscover, onRefine,
  onGreeting, onSkip, onAccept, onOffTopic, runAndReply, formatCardText usage.
  Replaced by a thin shim that calls `runAgent`.
- `src/matching/pipeline.ts` — `formatCardText`, `formatHoldCard`,
  `formatTwoCardsText`, `shouldShowTwo`. The agent writes its own card body.
  `runMatching`, `recordShown`, `getShownFounderIds`, `markShownAction`,
  `getLastShownFounderId` stay (used by tools).

---

## New directory: `src/agent/`

```
src/agent/
  loop.ts          — orchestrator: runAgent() entry point
  tools/
    index.ts       — tool registry (schemas + handlers)
    find_cofounders.ts
    update_search_state.ts
    get_founder_detail.ts
    propose_intro.ts
    mark_skipped.ts
    finish_turn.ts
  types.ts         — shared types (ToolCall, ToolResult, AgentTurn)
src/llm/prompts/
  agent_v1.ts      — system prompt + tool descriptions
```

---

## Agent loop (`src/agent/loop.ts`)

```
runAgent(founder, conv, userTurn, watiClient) → void
```

1. Load conversation state: `getSearchState`, `getRecentTurns`,
   `getShownFounderIds`.
2. Build the initial message list:
   - System: `AGENT_SYSTEM` from `agent_v1.ts`
   - Inject context block: founder name, city, headline, recent turns (last 8),
     current search state, already-shown founder IDs
   - User: the inbound message text
3. Call Gemini 2.5 Pro with tools attached (function calling mode).
4. Receive response. If it contains tool calls, execute them in order, append
   results, call Gemini again.
5. Repeat until `finish_turn` is called OR iteration count hits 6.
6. `finish_turn` returns `{ reply: string, buttons?: Button[] }`.
   - If `buttons` present: call `wati.sendButtons`
   - Otherwise: call `wati.sendText`
7. Record the outbound turn in DB.
8. On any exception or iteration overflow: send static fallback, log error.

**Model:** `gemini-2.5-pro` (set via `GEMINI_MODEL_AGENT` env var, falls back
to `GEMINI_MODEL_CHAT` if not set — lets us swap without redeploy).

**Temperature:** 0.9 for the main conversation, 0 for any internal tool
execution that requires structured output (find_cofounders rerank call).

---

## Tools

### `find_cofounders`
```
Input:  { query: string, limit?: number (default 5) }
Output: { founders: Array<{ id, name, city, headline, rationale, fit }> }
```
Internally: embed query → pgvector ANN → rerank via `rerank_v4` → return top
`limit`. Strips internal scores. Returns only what the agent needs to write a
card. If 0 results: returns `{ founders: [], message: "No matches in pool." }`.

### `update_search_state`
```
Input:  Partial<SearchState> — role, sector[], stage[], location[],
        seniority, must_have[], nice_to_have[], anti_prefs[]
Output: { updated: SearchState }
```
Merges delta into current state via existing `applyDelta`. Persists to DB.

### `get_founder_detail`
```
Input:  { founder_id: string }
Output: { name, city, headline, summary, role_tags, sector_tags, stage_tags,
          seniority, years_exp }
```
Used when the agent wants to answer a follow-up like "tell me more about them".
Only returns public profile fields — never consent-gated info.

### `propose_intro`
```
Input:  { target_founder_id: string, requester_note: string }
Output: { status: "proposed" | "already_pending" | "error", message: string }
```
Calls existing `propose()` from consent machine. Returns a string the agent
can quote directly in its reply.

### `mark_skipped`
```
Input:  { founder_id: string }
Output: { ok: boolean }
```
Records skip on `candidates_shown`, appends to `anti_prefs` in search state.

### `finish_turn`
```
Input:  { reply: string, buttons?: Array<{ id: string, title: string }> }
Output: { done: true }
```
Signals the loop to send the reply and stop. The agent MUST call this.
Max 2 buttons (WATI limit for session messages). Button IDs map to:
`accept`, `skip`, `force_intro`, `1`, `2`.

---

## Agent system prompt (summary — full text in `agent_v1.ts`)

**Identity:** You are the Build3 Cofounder Bot — a sharp, private scout inside
the Build3 founder network. Think Craigslist for cofounders: simple, direct,
human. Not eBay. Not a polished concierge.

**Voice:**
- Warm, direct, conversational. Sound like a thoughtful operator texting.
- Mirror the user's register. Blunt → blunt. Hinglish → fine.
- No emojis unless the user used one first. Even then, at most one.
- Short. Most replies under 200 characters. Cards can be longer.
- Never re-ask something already answered. Never sound like a form.

**Hard rules:**
- Never invent names, cities, or profile details.
- Never reveal a target's profile before mutual consent.
- If no real match exists in the pool, say so plainly. Do not force a weak
  recommendation.
- You MUST call `finish_turn` exactly once. Never send two replies.
- If the user says stop/unsubscribe/leave me alone, call finish_turn with a
  single acknowledgment and nothing else.

**Tool guidance (when to call what):**
- `update_search_state` — whenever the user expresses a preference, even
  implicitly ("I'm building B2B" → sector = b2b-saas).
- `find_cofounders` — after updating state, or when the user asks to search.
  For vague asks, search broadly (query = the user's own words).
- `get_founder_detail` — only when the user asks a follow-up about a specific
  person.
- `propose_intro` — only when the user explicitly says Accept/yes/connect.
- `mark_skipped` — when the user taps Skip or says "not them".
- `finish_turn` — always last, always exactly once.

---

## Identity gate changes (`src/identity/gate.ts`)

Add at the top of `dispatchInbound` (before any DB access):

```typescript
const TESTING_WHITELIST = new Set(["917397599542", "918468090511"]);
const normalized = normalizePhone(msg.waId);
if (!TESTING_WHITELIST.has(normalized)) {
  logger.info({ waId: msg.waId }, "non-whitelist — silent drop");
  return; // 200, no reply
}
```

This replaces the current cohort-only check for now. When we go to full cohort
rollout, we remove the whitelist and keep the cohort DB check.

---

## Dispatcher shim (`src/wati/dispatcher.ts`)

Stripped to ~60 lines:

1. Whitelist check → silent drop if not whitelisted
2. Find founder by phone → if not in DB, silent drop (not cohort)
3. opted_in check → silent drop
4. Acquire dispatch lock (keep — prevents WATI duplicate floods)
5. Idempotency check on wati_message_id (keep)
6. Insert inbound turn
7. `await runAgent(founder, conv, msg.text ?? "", deps.wati)`
8. Release lock

No routing, no intent classification, no switch statement.

---

## What stays unchanged

| Component | Why |
|---|---|
| `src/matching/retriever.ts` | Called by `find_cofounders` tool |
| `src/matching/reranker.ts` + `rerank_v4.ts` | Called by `find_cofounders` tool |
| `src/matching/refinement.ts` | Called by `update_search_state` tool |
| `src/consent/machine.ts` | Called by `propose_intro` tool |
| `src/consent/expiries.ts` | Unchanged |
| `src/wati/client.ts` | Unchanged |
| `src/db/` schema + migrations | Unchanged |
| `src/identity/gate.ts` (normalizePhone) | Reused |
| `src/lib/config.ts` | Add `GEMINI_MODEL_AGENT` |

---

## New env vars

| Var | Default | Purpose |
|---|---|---|
| `GEMINI_MODEL_AGENT` | `gemini-2.5-pro` | Model for agent loop |

---

## Testing

- **Unit:** Each tool function tested in isolation with mocked DB/LLM
- **Integration:** `runAgent` tested with a mocked Gemini that returns canned
  tool call sequences (search → finish_turn, search → skip → search →
  finish_turn, etc.)
- **Existing tests:** All existing pipeline/consent/refinement tests stay green
  (those modules are unchanged)
- **Manual smoke:** Send the 2 whitelisted numbers through golden paths on
  staging before flipping prod

---

## Success criteria

- Vague ask ("find me someone to build with") → Gemini searches, writes a
  card in its own voice with a real hook. No template visible.
- Sector gap ("defence tech") → Gemini says honestly "nobody here in defence
  tech right now" without a preamble template.
- Refinement ("more B2B") → Gemini updates state and searches again, reply
  feels like the same thread not a new query.
- Agent derail rate < 5% in first 50 real conversations.
- p95 latency (inbound → outbound) < 8s.
