import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Generates a synthetic founder CSV for dev + tests. Deterministic by default
 * (seeded PRNG), so CI and reranker tests see the same data.
 *
 * Rows: ~120 founders, realistic variance across role / sector / stage / city.
 * IMPORTANT: synthetic data only. Real cohort data lives in a separate ingest
 * path and is never committed (`.gitignore` blocks `data/real_*.csv`).
 */

type Role = "technical" | "sales" | "growth" | "product" | "ops" | "design";
type Seniority = "operator" | "founder-level" | "senior-ic";

const CITIES = [
  "Bangalore", "Mumbai", "Delhi NCR", "Pune", "Hyderabad", "Chennai",
  "Singapore", "San Francisco", "New York", "London", "Remote",
];
const SECTORS = [
  "fintech", "healthtech", "edtech", "b2b-saas", "d2c", "climate",
  "logistics", "ai-infra", "devtools", "marketplaces", "social",
];
const STAGES = ["pre-idea", "pre-seed", "seed", "series-a", "growth"];

const FIRST_NAMES_M = ["Arjun", "Rohan", "Karthik", "Vikram", "Siddharth", "Ravi", "Aditya", "Nikhil", "Varun", "Ishaan", "Dev", "Kabir", "Ayaan", "Rahul"];
const FIRST_NAMES_F = ["Priya", "Ananya", "Meera", "Sneha", "Kavya", "Divya", "Riya", "Aisha", "Tara", "Nisha", "Pooja", "Lakshmi"];
const LAST_NAMES   = ["Sharma", "Verma", "Iyer", "Reddy", "Patel", "Kumar", "Rao", "Singh", "Mehta", "Kapoor", "Joshi", "Menon", "Banerjee", "Das", "Shah"];

const ROLE_TEMPLATES: Record<Role, { headline: (s: string) => string; tags: string[]; summarySeeds: string[] }> = {
  technical: {
    headline: (sector) => `Engineer building in ${sector}. Looking for a non-tech cofounder.`,
    tags: ["technical", "engineering"],
    summarySeeds: [
      "Ex-Google/Amazon engineer. Strong in backend systems, distributed data, ML infra. Want to partner with a GTM-strong cofounder who has real sector conviction.",
      "Full-stack engineer. Shipped two 0-1 products. Comfortable owning product + infra; looking for someone strong on sales and customer development.",
      "Infra/platform engineer. Prefer a cofounder who can do fundraising, GTM, and founder-mode storytelling.",
    ],
  },
  sales: {
    headline: (sector) => `GTM/sales operator in ${sector}. Looking for a technical cofounder.`,
    tags: ["sales", "gtm", "bd"],
    summarySeeds: [
      "Enterprise sales at two B2B SaaS companies. Carried quota, built pipelines, closed mid-market. Want a technical cofounder with conviction in a sector I can sell into.",
      "BD + partnerships across APAC. Strong network in banking and insurance. Looking for a founder-level engineer who wants to build in fintech.",
      "Led sales org from 0→5M ARR at my last startup. Looking for a deeply technical cofounder — ideally someone who hates the idea of selling so I get to own that.",
    ],
  },
  growth: {
    headline: (sector) => `Growth operator in ${sector}. Looking for a technical or product cofounder.`,
    tags: ["growth", "marketing", "performance"],
    summarySeeds: [
      "Growth lead at two consumer startups. Strong in performance marketing, SEO, and lifecycle. Looking for a technical cofounder who wants to own product + infra.",
      "Went from analyst to growth head in 4 years. Own the full funnel — paid, organic, retention. Want to build in D2C or fintech with a technical cofounder.",
      "Growth + brand. Prefer B2C or prosumer. Looking for a cofounder who sees product as a growth lever, not a separate thing.",
    ],
  },
  product: {
    headline: (sector) => `Product leader in ${sector}. Looking for a technical cofounder.`,
    tags: ["product", "pm"],
    summarySeeds: [
      "Senior PM at a unicorn, then founding PM at a Series A. Strong product sense, customer development chops, some SQL/data. Looking for a technical cofounder.",
      "Led product at a B2B SaaS company from pre-revenue to Series A. Want to pair with an engineer who thinks like a founder, not a contractor.",
      "Product generalist. Can do discovery, specs, analytics, and light prototyping. Looking for a technical cofounder with sector conviction.",
    ],
  },
  ops: {
    headline: (sector) => `Operator in ${sector}. Strong on ops, finance, and execution.`,
    tags: ["ops", "operations", "finance"],
    summarySeeds: [
      "COO at a Series B. Strong in ops, finance, hiring. Looking for a technical cofounder who wants a serious operating partner.",
      "Ex-consulting, then founding team at a fintech. Built ops, compliance, finance functions. Want to partner with a technical/product founder.",
      "Operations-heavy founder. Logistics and supply chain expertise. Looking for a technical cofounder who can own the software stack.",
    ],
  },
  design: {
    headline: (sector) => `Design founder in ${sector}. Product + design.`,
    tags: ["design", "product-design"],
    summarySeeds: [
      "Product designer turned founder. Strong in UX, UI, and prototyping. Looking for a technical cofounder and ideally a GTM person too, but tech first.",
      "Design lead at a consumer app. Can ship working prototypes. Want to partner with a deeply technical cofounder.",
    ],
  },
};

// Deterministic PRNG (mulberry32)
function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function pickN<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy.splice(idx, 1)[0]!);
  }
  return out;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function generateFounders(count = 120, seed = 42) {
  const rng = makeRng(seed);
  const roles: Role[] = ["technical", "sales", "growth", "product", "ops", "design"];
  const seniorities: Seniority[] = ["operator", "founder-level", "senior-ic"];

  const rows: Array<{
    phone: string;
    name: string;
    email: string;
    city: string;
    headline: string;
    summary: string;
    role_tags: string[];
    sector_tags: string[];
    stage_tags: string[];
    seniority: Seniority;
    years_exp: number;
  }> = [];

  for (let i = 0; i < count; i++) {
    const role = pick(rng, roles);
    const gender = rng() < 0.45 ? "f" : "m";
    const firstNames = gender === "f" ? FIRST_NAMES_F : FIRST_NAMES_M;
    const first = pick(rng, firstNames);
    const last = pick(rng, LAST_NAMES);
    const name = `${first} ${last}`;
    const city = pick(rng, CITIES);
    const sectors = pickN(rng, SECTORS, 1 + Math.floor(rng() * 2));
    const stages = pickN(rng, STAGES, 1 + Math.floor(rng() * 2));
    const seniority = pick(rng, seniorities);
    const yearsExp = 3 + Math.floor(rng() * 15);
    const tmpl = ROLE_TEMPLATES[role];
    const headline = tmpl.headline(sectors[0]!);
    const summary = pick(rng, tmpl.summarySeeds);
    // India-centric E.164 phone for realism (+91 prefix, 10 digits), unique via index
    const phone = `9${String(1000000000 + i * 7919).slice(1, 10)}`;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@build3.example`;
    rows.push({
      phone: `91${phone}`,
      name,
      email,
      city,
      headline,
      summary,
      role_tags: [...tmpl.tags, role],
      sector_tags: sectors,
      stage_tags: stages,
      seniority,
      years_exp: yearsExp,
    });
  }
  return rows;
}

function toCsv(rows: ReturnType<typeof generateFounders>): string {
  const header = [
    "phone", "name", "email", "city", "headline", "summary",
    "role_tags", "sector_tags", "stage_tags", "seniority", "years_exp",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.phone, r.name, r.email, r.city, r.headline, r.summary,
      r.role_tags.join("|"), r.sector_tags.join("|"), r.stage_tags.join("|"),
      r.seniority, r.years_exp,
    ].map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const rows = generateFounders(120, 42);
  const csv = toCsv(rows);
  const outPath = path.resolve("data/seed_founders.csv");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, csv, "utf8");
  // Keep this plain console.log so the generator stays dependency-free
  // (callable via `node --experimental-strip-types` without installing deps).
  console.log(JSON.stringify({ rows: rows.length, outPath, msg: "synthetic founder seed generated" }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("seed generation failed:", err);
    process.exit(1);
  });
}
