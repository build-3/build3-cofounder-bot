import type { CandidateCard } from "../matching/pipeline.js";

// NOTE: This file is frozen — it was the old templated card rendering
// replaced by the Gemini-agent card writer. Kept for reference / rollback
// only. Nothing in the live src/ path should import from here.

/**
 * Render a single candidate card for WhatsApp.
 *
 * Shape (Boardy-style bullet-prose):
 *
 *   *Name* — City
 *
 *   • bullet one
 *   • bullet two
 *
 *   Potential drawback: …   (omitted if empty)
 *
 *   Reply *Accept* to connect, *Skip* to see the next.
 *
 * Bullets come from the reranker. If the reranker returned none (old v2
 * response shape, or an LLM that misbehaved), we fall back to the single-
 * line rationale so the card still reads.
 */
export function formatCardText(card: CandidateCard): string {
  if (card.intro_recommendation === "hold") {
    return formatHoldCard(card);
  }

  const header = `*${card.name}* — ${card.city}`;

  const bullets = card.bullets.filter((b) => b.trim().length > 0);
  const body =
    bullets.length > 0
      ? bullets.map((b) => `• ${b}`).join("\n")
      : card.rationale;

  const drawback = card.drawback.trim();
  const drawbackLine = drawback ? `\n\nPotential drawback: ${drawback}` : "";

  return (
    `${header}\n\n` +
    `${body}` +
    `${drawbackLine}\n\n` +
    `Reply *Accept* to connect, *Skip* to see the next.`
  );
}

/**
 * Render a "hold" card. The reranker thinks this match is strong but the
 * intro is premature — we surface the reason and offer an override.
 *
 *   *Name* — City
 *
 *   • bullet one
 *   • bullet two
 *
 *   Holding off on this intro: <reason>
 *
 *   Reply *Force intro* to override, *Skip* to see others.
 */
export function formatHoldCard(card: CandidateCard): string {
  const header = `*${card.name}* — ${card.city}`;

  const bullets = card.bullets.filter((b) => b.trim().length > 0);
  const body =
    bullets.length > 0
      ? bullets.map((b) => `• ${b}`).join("\n")
      : card.rationale;

  const reason = card.hold_reason.trim();
  const reasonLine = reason
    ? `\n\nHolding off on this intro: ${reason}`
    : "\n\nHolding off on this intro for now.";

  return (
    `${header}\n\n` +
    `${body}` +
    `${reasonLine}\n\n` +
    `Reply *Force intro* to override, *Skip* to see others.`
  );
}

/**
 * Render two cards in one outbound message — preserves the
 * one-outbound-per-inbound contract. Only used when the reranker returned
 * at least two candidates and the second is within 60% of the top score.
 *
 * Shape:
 *
 *   Here are two worth looking at:
 *
 *   1) *Name* — City
 *   • bullet
 *   Potential drawback: …
 *
 *   2) *Name* — City
 *   • bullet
 *   Potential drawback: …
 *
 *   Reply *1* or *2* to pick one, *Skip* to see others.
 *
 * If either card is `hold`, its drawback slot becomes the hold reason and
 * the CTA drops to "*1*, *2*, or *Skip* — 1/2 means pick, Skip means next."
 * We intentionally don't split buttons per card here; WATI's 3-button cap
 * plus the one-outbound invariant make typed replies the only clean option.
 */
export function formatTwoCardsText(cards: [CandidateCard, CandidateCard]): string {
  const [a, b] = cards;
  return [
    "Here are two worth looking at:",
    "",
    renderOneInStack(1, a),
    "",
    renderOneInStack(2, b),
    "",
    "Reply *1* or *2* to pick one, *Skip* to see others.",
  ].join("\n");
}

function renderOneInStack(pos: number, card: CandidateCard): string {
  const header = `${pos}) *${card.name}* — ${card.city}`;
  const bullets = card.bullets.filter((x) => x.trim().length > 0);
  const body =
    bullets.length > 0 ? bullets.map((x) => `• ${x}`).join("\n") : card.rationale;

  let tail = "";
  if (card.intro_recommendation === "hold") {
    const reason = card.hold_reason.trim();
    tail = reason ? `\nHolding off: ${reason}` : "\nHolding off on this intro for now.";
  } else {
    const drawback = card.drawback.trim();
    tail = drawback ? `\nPotential drawback: ${drawback}` : "";
  }

  return `${header}\n${body}${tail}`;
}

/**
 * Should we show two cards instead of one?
 *
 * Yes iff the reranker returned at least two, both are warm (hold cards
 * always go solo so the Force-intro override isn't ambiguous), and the
 * runner-up is within 60% of the top score. This stops us from padding a
 * strong first card with a weak second one.
 */
export function shouldShowTwo(cards: CandidateCard[]): boolean {
  if (cards.length < 2) return false;
  const [a, b] = cards;
  if (!a || !b) return false;
  if (a.intro_recommendation === "hold" || b.intro_recommendation === "hold") return false;
  if (a.score <= 0) return false;
  return b.score >= 0.6 * a.score;
}
