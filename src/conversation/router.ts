/**
 * Intent router. Deterministic keyword check first — cheap and predictable.
 * Returns `'other'` when nothing matches; the dispatcher decides whether to
 * treat that as a refine turn or a generic help nudge.
 *
 * Keep this small. LLM judgment is for refinement + rerank, not for routing.
 */

export type Intent = "accept" | "skip" | "decline" | "discover" | "refine" | "other" | "help";

export interface RouterInput {
  text?: string;
  buttonPayload?: string | undefined;
}

const DISCOVER_PATTERNS = [
  /\b(find|looking for|need|want|show me|suggest|match me)\b.*\b(cofounder|co-?founder|partner)\b/i,
  /\b(technical|sales|growth|product|ops|design)\s+cofounder\b/i,
];

const HELP_PATTERNS = [/^\s*(help|start|hi|hello|hey)\s*$/i];

export function classifyIntent(input: RouterInput): Intent {
  const payload = input.buttonPayload?.toUpperCase();
  if (payload === "ACCEPT") return "accept";
  if (payload === "SKIP") return "skip";
  if (payload === "DECLINE") return "decline";

  const text = input.text?.trim() ?? "";
  if (!text && !payload) return "other";

  // Text fallbacks for cases where user types the word instead of tapping.
  if (/^\s*accept\s*$/i.test(text)) return "accept";
  if (/^\s*skip\s*$/i.test(text)) return "skip";
  if (/^\s*decline\s*$/i.test(text)) return "decline";

  if (HELP_PATTERNS.some((re) => re.test(text))) return "help";
  if (DISCOVER_PATTERNS.some((re) => re.test(text))) return "discover";

  // Anything else that looks like natural language inside an active conv is a refine turn.
  return "refine";
}
