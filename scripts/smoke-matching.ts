/**
 * End-to-end smoke test: load env, fire a few realistic queries through the
 * real retriever + reranker against the live cohort DB, and print a
 * compact summary of latencies + the AI's quantitative output.
 *
 * Usage (after sourcing env):
 *   tsx scripts/smoke-matching.ts
 *
 * NOTE: this hits the live DB and the live LLM provider. Read-only on the
 * DB side (we don't recordShown), but each query costs LLM tokens.
 */
import { runMatching } from "../src/matching/pipeline.js";
import type { SearchStateRow } from "../src/conversation/store.js";
import { logger } from "../src/lib/logger.js";

interface Probe {
  label: string;
  state: SearchStateRow;
  userTurn: string;
}

const PROBES: Probe[] = [
  {
    label: "tech-cofounder-fintech",
    state: emptyState({ role: "technical", sector: ["fintech"] }),
    userTurn: "Looking for a technical cofounder for my fintech idea",
  },
  {
    label: "gtm-healthtech",
    state: emptyState({ role: "sales", sector: ["healthtech"] }),
    userTurn: "Need a GTM cofounder, building in healthtech, Bangalore",
  },
  {
    label: "ai-applied-builder",
    state: emptyState({ sector: ["ai-applied", "ai-infra"] }),
    userTurn: "Anyone in the cohort building serious AI products?",
  },
  {
    label: "trivial-refinement",
    state: emptyState({ role: "technical", sector: ["fintech"] }),
    userTurn: "show me one more",
  },
];

function emptyState(over: Partial<SearchStateRow>): SearchStateRow {
  return {
    conversationId: "smoke-test",
    role: null,
    sector: [],
    stage: [],
    location: [],
    seniority: null,
    mustHave: [],
    niceToHave: [],
    antiPrefs: [],
    ...over,
  };
}

async function probe(p: Probe): Promise<void> {
  const start = Date.now();
  const result = await runMatching({
    requesterId: "00000000-0000-0000-0000-000000000000",
    state: p.state,
    userTurn: p.userTurn,
    alreadyShownFounderIds: [],
  });
  const elapsedMs = Date.now() - start;
  const card = result.cards[0];

  process.stdout.write(`\n━━━ ${p.label} ━━━ ${elapsedMs}ms\n`);
  process.stdout.write(`turn: "${p.userTurn}"\n`);
  process.stdout.write(`retrieved: ${result.retrieved.length}, ranked cards: ${result.cards.length}\n`);

  if (!card) {
    process.stdout.write("no top card\n");
    return;
  }
  process.stdout.write(`top: ${card.name} — ${card.city} (${card.seniority}, ${card.years_exp}y)\n`);
  process.stdout.write(`  match_score: ${card.match_score ?? "n/a"} | fit: ${card.intro_recommendation}\n`);
  process.stdout.write(`  rationale: ${card.rationale}\n`);
  if (card.headline_evidence?.length) {
    process.stdout.write(`  evidence: ${card.headline_evidence.map((e) => `"${e}"`).join(" | ")}\n`);
  }
  if (card.breakdown) {
    const b = card.breakdown;
    process.stdout.write(
      `  breakdown: role=${b.role_fit ?? 0} reciprocal=${b.reciprocal_fit ?? 0} ` +
      `sector=${b.sector_fit ?? 0} stage=${b.stage_fit ?? 0} loc=${b.location_fit ?? 0} ` +
      `anti=${b.anti_pref ?? 0}\n`,
    );
  }
  if (card.bullets?.length) {
    for (const b of card.bullets) process.stdout.write(`   • ${b}\n`);
  }
  if (card.drawback) process.stdout.write(`  drawback: ${card.drawback}\n`);
  process.stdout.write(`  times_shown (pre-record): ${card.times_shown}\n`);
}

async function main() {
  logger.level = "warn"; // less noise
  for (const p of PROBES) {
    try {
      await probe(p);
    } catch (err) {
      process.stdout.write(`\n━━━ ${p.label} FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

main().catch((err) => {
  console.error("smoke-matching failed:", err);
  process.exit(1);
});
