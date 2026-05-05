import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { getLLM } from "../llm/index.js";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";

/**
 * Ingest the Build3 cohort JSON dump (one file per cohort batch) into Postgres.
 *
 * Source shape (per record): { formData, linkedinProfile }.
 *  - formData has 5 form fields (name, what-building, stage, quote, photo) and is
 *    only filled for ~10% of records — the cohort filled the form once but most
 *    profiles came in via LinkedIn enrichment.
 *  - linkedinProfile has city, about, current_company_name, education, etc.
 *
 * The transformer is deterministic — no LLM calls. Tag inference happens via
 * keyword classifiers tuned to this cohort. That's intentional: a real-life
 * synonym pass at retrieve-time owns the messy mapping; ingest just needs a
 * baseline tag layer that's good enough for ANN + tag-filter to surface the
 * candidate, then the LLM rerank does the heavy lifting.
 *
 * Phones: the source has no phones. We synthesize a deterministic placeholder
 * `+91-9{hash mod 1e9}` per LinkedIn URL. This keeps the unique-on-phone
 * constraint working and lets us swap in real numbers later by UPSERT.
 *
 * Usage:
 *   npm run seed:cohort                              # default dir
 *   npm run seed:cohort -- /abs/path/to/cohort/dir
 */

interface RawRecord {
  formData?: {
    name?: string;
    whatYouAreBuilding?: string;
    stageOfTheStartup?: string;
    favoriteQuotesThoughtsYouLiveBy?: string;
  };
  linkedinProfile?: {
    name?: string;
    city?: string;
    country_code?: string;
    about?: string;
    current_company?: { name?: string; title?: string };
    current_company_name?: string;
    education?: Array<{ title?: string; start_year?: string; end_year?: string }>;
    url?: string;
    location?: string;
  };
}

export interface FounderRow {
  phone: string;
  name: string;
  email: string | null;
  city: string;
  headline: string;
  summary: string;
  role_tags: string[];
  sector_tags: string[];
  stage_tags: string[];
  seniority: "operator" | "founder-level" | "senior-ic";
  years_exp: number;
  raw_profile: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────────────
// Normalization helpers
// ────────────────────────────────────────────────────────────────────────────

const CITY_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/^bengaluru/i, "Bangalore"],
  [/^bangalore/i, "Bangalore"],
  [/^mumbai metropolitan region/i, "Mumbai"],
  [/^mumbai/i, "Mumbai"],
  [/^new delhi/i, "Delhi NCR"],
  [/^delhi/i, "Delhi NCR"],
  [/^greater delhi/i, "Delhi NCR"],
  [/^gurugram/i, "Delhi NCR"],
  [/^gurgaon/i, "Delhi NCR"],
  [/^noida/i, "Delhi NCR"],
  [/^hyderabad/i, "Hyderabad"],
  [/^pune/i, "Pune"],
  [/^chennai/i, "Chennai"],
  [/^kolkata/i, "Kolkata"],
  [/^goa/i, "Goa"],
  [/^thiruvananthapuram/i, "Trivandrum"],
  [/^trivandrum/i, "Trivandrum"],
  [/^kochi/i, "Kochi"],
  [/^ahmedabad/i, "Ahmedabad"],
  [/^jaipur/i, "Jaipur"],
  [/^jodhpur/i, "Jodhpur"],
  [/^chandigarh/i, "Chandigarh"],
];

function normalizeCity(rawCity: string | null | undefined): string {
  const s = (rawCity ?? "").trim();
  if (!s) return "India";
  // Strip ", State, Country" suffix.
  const head = s.split(",")[0]!.trim();
  for (const [re, canonical] of CITY_NORMALIZATIONS) {
    if (re.test(head)) return canonical;
  }
  // Already-clean foreign cities pass through; "India" alone stays "India".
  return head || "India";
}

// Deterministic 32-bit hash of a string — good enough for fake-phone derivation.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function syntheticPhone(linkedinUrl: string | undefined, name: string): string {
  // E.164 without '+', India prefix. Range 9100000000–9199999999 reserved here
  // for placeholders so they never clash with real WATI numbers (real Indian
  // mobile prefixes start 6/7/8/9 but our placeholder 91-91xxxxxxxx pattern is
  // outside the live cohort whitelist).
  const seed = `${linkedinUrl ?? ""}::${name}`;
  const h = fnv1a(seed) % 1_000_000_000;
  const tenDigits = String(1_000_000_000 + h).slice(1); // 9 digits
  return `9191${tenDigits.slice(0, 8)}`; // 91 (country) + 91 (placeholder block) + 8 digits = 12 digits
}

// ────────────────────────────────────────────────────────────────────────────
// Tag inference
// ────────────────────────────────────────────────────────────────────────────

interface TagPattern {
  tag: string;
  patterns: RegExp[];
}

const ROLE_PATTERNS: TagPattern[] = [
  {
    tag: "technical",
    patterns: [
      /\b(software\s+engineer|engineer|developer|tech\s+lead|cto|programmer|architect|coding|programmer)\b/i,
      /\b(backend|frontend|full[- ]stack|infra|platform|devops|sre|api|microservice)\b/i,
      /\b(machine[- ]learning|\bml\b|ai\s+engineer|data\s+scientist|data\s+engineer|deep\s+learning)\b/i,
      /\b(iit\s+\w+|nit\s+\w+|computer\s+science|cs\s+grad|engineering\s+background|coded\b|built\s+a\s+platform)\b/i,
    ],
  },
  {
    tag: "product",
    patterns: [
      /\b(product\s+manager|head\s+of\s+product|product\s+lead|cpo|product\s+strategy)\b/i,
      /\b(\bpm\b|founding\s+pm|product\s+thinking|product\s+sense|product\s+marketing\s+manager)\b/i,
    ],
  },
  {
    tag: "sales",
    patterns: [
      /\b(sales|account\s+executive|business\s+development|\bbd\b|gtm|go[- ]to[- ]market)\b/i,
      /\b(quota|pipeline|enterprise\s+sales|inside\s+sales|sdr|bdr|deal\s+closing|closed\s+deals)\b/i,
      /\b(client\s+acquisition|revenue\s+lead|head\s+of\s+sales|vp\s+sales|cro\b)\b/i,
    ],
  },
  {
    tag: "growth",
    patterns: [
      /\b(growth|performance\s+marketing|paid\s+media|paid\s+ads|\bseo\b|\bsem\b|lifecycle\s+marketing)\b/i,
      /\b(meta\s+ads|google\s+ads|funnel|cac\b|ltv\b|d2c\s+marketing|growth\s+hack)\b/i,
    ],
  },
  {
    tag: "marketing",
    patterns: [
      /\b(marketing|brand|brand\s+building|content\s+marketing|comms\b|communications)\b/i,
      /\b(creative\s+director|copywriter|storyteller|narrative\s+strateg)\b/i,
    ],
  },
  {
    tag: "design",
    patterns: [
      /\b(designer|design\s+lead|product\s+designer|\bux\b|ui\s+designer|graphic\s+designer)\b/i,
      /\b(visual\s+design|design\s+systems|figma|prototyp|design\s+thinking)\b/i,
    ],
  },
  {
    tag: "ops",
    patterns: [
      /\b(operations|coo|chief\s+of\s+staff|biz\s?ops|business\s+operations|operating\s+lead)\b/i,
      /\b(supply\s+chain|logistics\s+operations|program\s+management|project\s+management)\b/i,
    ],
  },
  {
    tag: "finance",
    patterns: [
      /\b(finance|cfo|investment\s+banking|venture\s+capital|\bvc\b|private\s+equity|\bpe\b)\b/i,
      /\b(financial\s+analyst|cfa\b|chartered\s+accountant|\bca\b\s|\bcs\b\s)\b/i,
    ],
  },
  {
    tag: "consulting",
    patterns: [
      /\b(consultant|consulting|mckinsey|bain|bcg|deloitte|accenture|ernst\s*&?\s*young|kpmg)\b/i,
      /\b(strategy\s+consultant|management\s+consultant|advisory)\b/i,
    ],
  },
  {
    tag: "founder",
    patterns: [
      /\b(founder|co[- ]?founder|ceo|chief\s+executive)\b/i,
    ],
  },
];

const SECTOR_PATTERNS: TagPattern[] = [
  { tag: "fintech", patterns: [/\b(fintech|fin[- ]?tech|payments|lending|banking|insurance|insur[- ]?tech|wealth\s+tech|trading|capital\s+markets|neobank|\bupi\b|credit|loan)\b/i] },
  { tag: "healthtech", patterns: [/\b(health\s?tech|healthcare|medtech|biotech|pharma|hospital|clinical|diagnost|wellness|telemedicine|mental\s+wellness|mental\s+health|fitness|nutrition|dental)\b/i] },
  { tag: "edtech", patterns: [/\b(edtech|ed[- ]?tech|education|learning|coaching|skilling|upskill|online\s+courses|tutor|student|university|college|school)\b/i] },
  { tag: "b2b-saas", patterns: [/\b(b2b|\bsaas\b|enterprise\s+software|enterprise\s+saas|workflow\s+(tool|software)|\bcrm\b|\berp\b|hr\s?tech|hr\s+software)\b/i] },
  { tag: "d2c", patterns: [/\b(d2c|direct[- ]to[- ]consumer|consumer\s+brand|brand\s+building)\b/i] },
  { tag: "ecommerce", patterns: [/\b(ecommerce|e-?commerce|online\s+store|retail\s+tech|shopify)\b/i] },
  { tag: "ai-infra", patterns: [/\b(ai\s+infra|\bllm\b|foundation\s+model|gen\s?ai|generative\s+ai|\brag\b|vector\s+db|model\s+serving|fine[- ]?tuning)\b/i] },
  { tag: "ai-applied", patterns: [/\b(ai[- ]powered|ai\s+platform|ai\s+for\s+|ai\s+agent|copilot|ai\s+assistant|using\s+ai|powered\s+by\s+ai|artificial\s+intelligence)\b/i] },
  { tag: "devtools", patterns: [/\b(devtools|developer\s+tools|developer\s+experience|\bdx\b|api\s+platform|\bide\b\s|sdk\s+for|developer\s+platform)\b/i] },
  { tag: "marketplaces", patterns: [/\b(marketplace|two[- ]sided|p2p\s+platform|aggregator|matching\s+platform|matchmaking|matchmaker)\b/i] },
  { tag: "logistics", patterns: [/\b(logistics|supply\s+chain|last[- ]mile|fleet|warehous|trucking|delivery\s+platform)\b/i] },
  { tag: "climate", patterns: [/\b(climate|cleantech|clean\s+energy|sustainab|carbon|renewable|\bev\s+charging|electric\s+vehicle|biodegradable|recycl|circular\s+economy|waste\s+management)\b/i] },
  { tag: "agritech", patterns: [/\b(agritech|agri[- ]?tech|agriculture|farming|farmer|crop|dairy)\b/i] },
  { tag: "consumer", patterns: [/\b(consumer|\bd2c\b|retail|fmcg|community\s+app|social\s+app|consumer\s+app|dating\s+app|matchmaking\s+app|fashion|footwear|apparel|beauty|cosmetics|personal\s+care)\b/i] },
  { tag: "social", patterns: [/\b(social\s+network|social\s+media|community\s+platform|creator\s+economy|creator\s+platform)\b/i] },
  { tag: "media", patterns: [/\b(media|content\s+platform|video\s+platform|streaming|\bott\b|podcast|publishing)\b/i] },
  { tag: "gaming", patterns: [/\b(gaming|game\s+dev|esports|web3\s+gaming)\b/i] },
  { tag: "web3", patterns: [/\b(web3|crypto|blockchain|defi|\bnft\b|\bdao\b|smart\s+contract)\b/i] },
  { tag: "real-estate", patterns: [/\b(real\s+estate|prop\s?tech|housing|real[- ]?estate\s+tech|rental)\b/i] },
  { tag: "hospitality", patterns: [/\b(hospitality|travel|tourism|hotel|f&b|food\s*&?\s*beverage|restaurant|cafe|hostel)\b/i] },
  { tag: "manufacturing", patterns: [/\b(manufacturing|industrial|hardware\s+manufacturing|factory|footwear|apparel\s+manufactur)\b/i] },
  { tag: "deeptech", patterns: [/\b(deep\s?tech|robotics|drones|hardware\s+startup|computer\s+vision|semiconductor|space\s?tech|aerospace)\b/i] },
  { tag: "legaltech", patterns: [/\b(legal\s?tech|legal\s+technology|law\s?tech|legal\s+ai|legal\s+software)\b/i] },
  { tag: "hrtech", patterns: [/\b(hr\s?tech|hiring\s+platform|recruitment\s+platform|freelance\s+platform|talent\s+platform|talent\s+marketplace)\b/i] },
  { tag: "dating", patterns: [/\b(dating\s+app|matchmaking\s+app|relationship\s+app|matrimonial)\b/i] },
];

/** Patterns inferring what a founder is *looking for* in a cofounder.
 *  Stored as `wants_*` role tags so the rerank prompt can read them. */
const COMPLEMENT_PATTERNS: TagPattern[] = [
  { tag: "wants_technical", patterns: [/\b(looking\s+for\s+(a\s+)?(technical|tech)\s+co[- ]?founder|need\s+a\s+technical|seeking\s+a?\s*technical|tech\s+cofounder|cto\s+cofounder)\b/i] },
  { tag: "wants_gtm", patterns: [/\b(looking\s+for\s+(a\s+)?(gtm|sales|business|non[- ]?tech)\s+co[- ]?founder|need\s+a\s+gtm|seeking\s+a?\s*sales|business\s+cofounder)\b/i] },
  { tag: "wants_product", patterns: [/\b(looking\s+for\s+(a\s+)?product\s+co[- ]?founder|product\s+cofounder)\b/i] },
  { tag: "wants_design", patterns: [/\b(looking\s+for\s+(a\s+)?design(er)?\s+co[- ]?founder|design\s+cofounder)\b/i] },
];

const STAGE_PATTERNS: Array<{ tag: string; matcher: (text: string, formStage: string | undefined) => boolean }> = [
  { tag: "pre-idea", matcher: (_t, s) => /haven.t started building|but haven.t/i.test(s ?? "") },
  { tag: "pre-idea", matcher: (t, s) => !s && /idea\s+stage|exploring\s+ideas|figuring\s+out\s+what\s+to\s+build/i.test(t) },
  { tag: "mvp", matcher: (_t, s) => /started\s+building\s+the\s+mvp|building\s+the\s+mvp|i.ve\s+built\s+my\s+mvp/i.test(s ?? "") },
  { tag: "pre-revenue", matcher: (_t, s) => /built\s+my\s+product\s+but\s+don.t\s+have\s+revenue/i.test(s ?? "") },
  { tag: "revenue", matcher: (_t, s) => /started\s+generating\s+revenue|have\s+revenue/i.test(s ?? "") },
  { tag: "seed", matcher: (t) => /\bseed\s+stage|seed[- ]funded|raised\s+seed/i.test(t) },
];

function inferTags(patterns: TagPattern[], text: string): string[] {
  const out: string[] = [];
  for (const { tag, patterns: pats } of patterns) {
    if (pats.some((p) => p.test(text))) out.push(tag);
  }
  // Deduplicate while preserving first-seen order.
  return Array.from(new Set(out));
}

function inferStageTags(searchText: string, formStage: string | undefined): string[] {
  const out: string[] = [];
  for (const { tag, matcher } of STAGE_PATTERNS) {
    if (matcher(searchText, formStage)) out.push(tag);
  }
  return Array.from(new Set(out));
}

function inferSeniority(yearsExp: number, hasFounderTag: boolean): "operator" | "founder-level" | "senior-ic" {
  // Founder-level if they've already founded something or have 8+ years.
  if (hasFounderTag) return "founder-level";
  if (yearsExp >= 10) return "founder-level";
  if (yearsExp >= 5) return "senior-ic";
  return "operator";
}

function inferYearsExp(rec: RawRecord): number {
  const educations = rec.linkedinProfile?.education ?? [];
  const startYears = educations
    .map((e) => parseInt(e.start_year ?? "", 10))
    .filter((n) => Number.isFinite(n) && n > 1980 && n < 2030);
  if (startYears.length === 0) {
    // No education data — assume mid-career. The seniority inference also uses
    // founder-tag presence, so this default doesn't bias toward one bucket.
    return 8;
  }
  const earliest = Math.min(...startYears);
  // Assume undergrad starts 4 years before "career start". 2026 - earliest - 4.
  const years = Math.max(1, 2026 - earliest - 4);
  return Math.min(years, 35);
}

// ────────────────────────────────────────────────────────────────────────────
// Headline + summary composition
// ────────────────────────────────────────────────────────────────────────────

function cleanText(s: string | null | undefined): string {
  if (!s) return "";
  // LinkedIn truncation glyph + collapse whitespace.
  return s.replace(/…$/g, "").replace(/\s+/g, " ").trim();
}

function composeHeadline(rec: RawRecord, fallbackName: string): string {
  const lp = rec.linkedinProfile ?? {};
  const fd = rec.formData ?? {};
  const company = lp.current_company_name?.trim();
  const title = lp.current_company?.title?.trim();
  const building = cleanText(fd.whatYouAreBuilding);

  // Prefer "Building X — current_role at company" when both present.
  if (building && company) {
    const buildShort = building.split(/[.\n]/)[0]!.slice(0, 90).trim();
    return `${buildShort} • ${title ? `${title} at ` : ""}${company}`.slice(0, 200);
  }
  if (building) return building.split(/[.\n]/)[0]!.slice(0, 200);
  if (title && company) return `${title} at ${company}`.slice(0, 200);
  if (company) return `Founder at ${company}`.slice(0, 200);
  if (lp.about) {
    const firstSentence = cleanText(lp.about).split(/[.!?]/)[0] ?? "";
    if (firstSentence.length > 8) return firstSentence.slice(0, 200);
  }
  return `${fallbackName} — Build3 cohort founder`;
}

function composeSummary(rec: RawRecord): string {
  const lp = rec.linkedinProfile ?? {};
  const fd = rec.formData ?? {};
  const parts: string[] = [];
  const about = cleanText(lp.about);
  if (about) parts.push(about);
  const building = cleanText(fd.whatYouAreBuilding);
  if (building && !about.toLowerCase().includes(building.slice(0, 30).toLowerCase())) {
    parts.push(`Currently building: ${building}`);
  }
  const stage = cleanText(fd.stageOfTheStartup);
  if (stage) parts.push(`Stage: ${stage}`);
  const quote = cleanText(fd.favoriteQuotesThoughtsYouLiveBy);
  if (quote && quote.length < 200) parts.push(`Operating ethos: ${quote}`);
  const company = lp.current_company_name?.trim();
  const title = lp.current_company?.title?.trim();
  if (company && parts.length === 0) {
    parts.push(`${title ? `${title} at ` : "Working at "}${company}.`);
  }
  return parts.join("\n").slice(0, 1200) || "Build3 cohort founder.";
}

// ────────────────────────────────────────────────────────────────────────────
// Transform
// ────────────────────────────────────────────────────────────────────────────

export function transformCohortRecord(rec: RawRecord, sourceFile: string): FounderRow | null {
  const fd = rec.formData ?? {};
  const lp = rec.linkedinProfile ?? {};
  const name = cleanText(fd.name) || cleanText(lp.name);
  if (!name) return null;

  // Need at least ONE of: about, what-building, current_company. Otherwise the
  // record is too thin to embed meaningfully.
  if (!cleanText(lp.about) && !cleanText(fd.whatYouAreBuilding) && !cleanText(lp.current_company_name)) {
    return null;
  }

  const city = normalizeCity(lp.city ?? lp.location);
  const headline = composeHeadline(rec, name);
  const summary = composeSummary(rec);

  const searchText = [
    headline,
    summary,
    lp.current_company_name ?? "",
    lp.current_company?.title ?? "",
  ].join(" ").toLowerCase();

  const role_tags = inferTags(ROLE_PATTERNS, searchText);
  const sector_tags = inferTags(SECTOR_PATTERNS, searchText);
  const stage_tags = inferStageTags(searchText, fd.stageOfTheStartup);
  // Complement tags (`wants_*`) co-live in role_tags so the retriever's
  // role-tag filter can match on them too. Reranker reads them via summary.
  const complement_tags = inferTags(COMPLEMENT_PATTERNS, searchText);
  for (const t of complement_tags) if (!role_tags.includes(t)) role_tags.push(t);

  const years_exp = inferYearsExp(rec);
  const seniority = inferSeniority(years_exp, role_tags.includes("founder"));

  const phone = syntheticPhone(lp.url, name);

  return {
    phone,
    name,
    email: null,
    city,
    headline,
    summary,
    role_tags,
    sector_tags,
    stage_tags,
    seniority,
    years_exp,
    raw_profile: {
      source: "build3-cohort",
      source_file: path.basename(sourceFile),
      linkedin_url: lp.url ?? null,
      current_company: lp.current_company_name ?? null,
      stage_text: fd.stageOfTheStartup ?? null,
    },
  };
}

export async function loadCohortFiles(dir: string): Promise<FounderRow[]> {
  const entries = await readdir(dir);
  const files = entries
    .filter((e) => /\.json$/i.test(e))
    .map((e) => path.join(dir, e))
    .sort();

  const out: FounderRow[] = [];
  const seenPhones = new Set<string>();
  let skipped = 0;
  for (const f of files) {
    const raw = await readFile(f, "utf8");
    const records = JSON.parse(raw) as RawRecord[];
    for (const r of records) {
      const row = transformCohortRecord(r, f);
      if (!row) { skipped++; continue; }
      // Dedup by synthetic phone (collision possible if two records share LI url + name).
      if (seenPhones.has(row.phone)) { skipped++; continue; }
      seenPhones.add(row.phone);
      out.push(row);
    }
  }
  logger.info({ files: files.length, founders: out.length, skipped }, "cohort files loaded");
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// DB ingest (parallel embeddings + batched upsert)
// ────────────────────────────────────────────────────────────────────────────

function composeEmbedText(r: FounderRow): string {
  return [
    `${r.name} — ${r.city}`,
    r.headline,
    r.summary,
    r.role_tags.length ? `Role tags: ${r.role_tags.join(", ")}` : "",
    r.sector_tags.length ? `Sector tags: ${r.sector_tags.join(", ")}` : "",
    r.stage_tags.length ? `Stage tags: ${r.stage_tags.join(", ")}` : "",
    `Seniority: ${r.seniority}`,
  ].filter(Boolean).join("\n");
}

function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export async function ingestRows(rows: FounderRow[]): Promise<{ inserted: number; updated: number; embedded: number }> {
  const cfg = loadConfig();
  const sql = postgres(cfg.DATABASE_URL, { max: 1, prepare: false });
  const llm = getLLM();

  const BATCH = 32; // Gemini embed is sequential under the hood; smaller batches give better feedback granularity.
  let inserted = 0;
  let updated = 0;
  let embedded = 0;

  try {
    for (let start = 0; start < rows.length; start += BATCH) {
      const batch = rows.slice(start, start + BATCH);
      const inputs = batch.map((r) => composeEmbedText(r));
      const vectors = await llm.embed(inputs, { taskType: "RETRIEVAL_DOCUMENT" });
      if (vectors.length !== batch.length) {
        throw new Error(`embed returned ${vectors.length} vectors for ${batch.length} inputs`);
      }
      embedded += vectors.length;

      await sql.begin(async (tx) => {
        for (let i = 0; i < batch.length; i++) {
          const r = batch[i]!;
          const vec = toPgVectorLiteral(vectors[i]!);
          // Cast through `unknown` because postgres-js's JSONValue is more
          // restrictive than Record<string, unknown> but JSON.stringify of
          // any plain JSON object produces a valid value at runtime.
          const rawProfile = r.raw_profile as unknown as Parameters<typeof tx.json>[0];
          const result = await tx`
            INSERT INTO founders
              (phone, name, email, city, headline, summary,
               role_tags, sector_tags, stage_tags, seniority, years_exp, raw_profile)
            VALUES (${r.phone}, ${r.name}, ${r.email}, ${r.city}, ${r.headline}, ${r.summary},
                    ${r.role_tags}, ${r.sector_tags}, ${r.stage_tags}, ${r.seniority}, ${r.years_exp},
                    ${tx.json(rawProfile)})
            ON CONFLICT (phone) DO UPDATE SET
              name        = EXCLUDED.name,
              email       = EXCLUDED.email,
              city        = EXCLUDED.city,
              headline    = EXCLUDED.headline,
              summary     = EXCLUDED.summary,
              role_tags   = EXCLUDED.role_tags,
              sector_tags = EXCLUDED.sector_tags,
              stage_tags  = EXCLUDED.stage_tags,
              seniority   = EXCLUDED.seniority,
              years_exp   = EXCLUDED.years_exp,
              raw_profile = EXCLUDED.raw_profile
            RETURNING id, (xmax = 0) AS inserted
          `;
          const founderId = (result[0] as { id: string }).id;
          const wasInserted = (result[0] as { inserted: boolean }).inserted;
          if (wasInserted) inserted++; else updated++;

          await tx.unsafe(
            `INSERT INTO founder_embeddings (founder_id, embedding, updated_at)
             VALUES ($1, $2::vector, now())
             ON CONFLICT (founder_id) DO UPDATE SET
               embedding = EXCLUDED.embedding,
               updated_at = now()`,
            [founderId, vec],
          );
        }
      });

      logger.info(
        { processed: Math.min(start + BATCH, rows.length), total: rows.length },
        "cohort batch upserted",
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { inserted, updated, embedded };
}

async function main() {
  const dir = path.resolve(process.argv[2] ?? "/Users/arjun/Desktop/cohort-founder-data-main/final-cohort-data");
  const rows = await loadCohortFiles(dir);
  if (rows.length === 0) {
    logger.error({ dir }, "no rows produced — aborting");
    process.exit(1);
  }
  const result = await ingestRows(rows);
  logger.info(result, "cohort ingest complete");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, "cohort ingest failed");
    process.exit(1);
  });
}
