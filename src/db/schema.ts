import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Schema notes:
 * - `pgvector` is enabled via migration SQL; we represent embeddings as text
 *   at the Drizzle layer and cast in SQL. Keeps the ORM simple, pushes the
 *   vector specifics to migration + query code.
 * - `wati_message_id` is the idempotency key on inbound — unique index enforces it.
 * - `match_requests.status` is written only by `src/consent/machine.ts`.
 */

export const founders = pgTable(
  "founders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),             // E.164, no '+'
    name: text("name").notNull(),
    email: text("email"),
    city: text("city").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary").notNull(),
    roleTags: text("role_tags").array().notNull().default(sql`ARRAY[]::text[]`),
    sectorTags: text("sector_tags").array().notNull().default(sql`ARRAY[]::text[]`),
    stageTags: text("stage_tags").array().notNull().default(sql`ARRAY[]::text[]`),
    seniority: text("seniority").notNull(),   // 'operator' | 'founder-level' | 'senior-ic'
    yearsExp: integer("years_exp").notNull(),
    rawProfile: jsonb("raw_profile").notNull().default({}),
    optedIn: boolean("opted_in").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    phoneUnique: uniqueIndex("founders_phone_unique").on(t.phone),
    cityIdx: index("founders_city_idx").on(t.city),
  }),
);

export const founderEmbeddings = pgTable("founder_embeddings", {
  founderId: uuid("founder_id")
    .primaryKey()
    .references(() => founders.id, { onDelete: "cascade" }),
  // vector(1536) — managed via raw SQL in migration
  embedding: text("embedding").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  founderId: uuid("founder_id")
    .notNull()
    .references(() => founders.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"), // 'active' | 'paused'
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(), // 'in' | 'out'
    watiMessageId: text("wati_message_id"), // nullable for outbound
    text: text("text").notNull(),
    intent: text("intent"),                 // 'discover' | 'refine' | 'accept' | 'skip' | 'decline' | 'other'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    watiIdUnique: uniqueIndex("turns_wati_message_id_unique").on(t.watiMessageId),
    convCreatedIdx: index("turns_conv_created_idx").on(t.conversationId, t.createdAt),
  }),
);

export const searchState = pgTable("search_state", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role"),
  sector: text("sector").array().notNull().default(sql`ARRAY[]::text[]`),
  stage: text("stage").array().notNull().default(sql`ARRAY[]::text[]`),
  location: text("location").array().notNull().default(sql`ARRAY[]::text[]`),
  seniority: text("seniority"),
  mustHave: text("must_have").array().notNull().default(sql`ARRAY[]::text[]`),
  niceToHave: text("nice_to_have").array().notNull().default(sql`ARRAY[]::text[]`),
  antiPrefs: text("anti_prefs").array().notNull().default(sql`ARRAY[]::text[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const candidatesShown = pgTable(
  "candidates_shown",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    founderId: uuid("founder_id")
      .notNull()
      .references(() => founders.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    rationale: text("rationale").notNull(),
    action: text("action").notNull().default("shown"), // 'shown' | 'accepted' | 'skipped'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    convFounderIdx: index("candidates_conv_founder_idx").on(t.conversationId, t.founderId),
  }),
);

export const matchRequests = pgTable(
  "match_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => founders.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => founders.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // see STATE_MACHINE.md
    requesterNote: text("requester_note").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activePairIdx: index("match_requests_active_pair_idx").on(t.requesterId, t.targetId, t.status),
    statusExpiresIdx: index("match_requests_status_expires_idx").on(t.status, t.expiresAt),
  }),
);

export const intros = pgTable("intros", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchRequestId: uuid("match_request_id")
    .notNull()
    .references(() => matchRequests.id, { onDelete: "cascade" }),
  introText: text("intro_text").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeCreatedIdx: index("events_type_created_idx").on(t.type, t.createdAt),
  }),
);

/**
 * `turns_wati_message_id_unique` has a natural quirk: unique indexes allow
 * multiple NULLs in Postgres, so outbound turns (null wati_message_id) don't
 * conflict. That's exactly what we want — the index enforces idempotency on
 * inbound only.
 */
export const inboundWatiIdempotency = { note: "see unique index on turns.wati_message_id" };
