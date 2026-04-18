-- 0001_init.sql — idempotent initial schema
-- Run via `npm run db:migrate`. Safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS founders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  name         text NOT NULL,
  email        text,
  city         text NOT NULL,
  headline     text NOT NULL,
  summary      text NOT NULL,
  role_tags    text[] NOT NULL DEFAULT ARRAY[]::text[],
  sector_tags  text[] NOT NULL DEFAULT ARRAY[]::text[],
  stage_tags   text[] NOT NULL DEFAULT ARRAY[]::text[],
  seniority    text NOT NULL,
  years_exp    integer NOT NULL,
  raw_profile  jsonb NOT NULL DEFAULT '{}'::jsonb,
  opted_in     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS founders_phone_unique ON founders (phone);
CREATE INDEX        IF NOT EXISTS founders_city_idx     ON founders (city);

CREATE TABLE IF NOT EXISTS founder_embeddings (
  founder_id uuid PRIMARY KEY REFERENCES founders(id) ON DELETE CASCADE,
  embedding  vector(1536) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- ANN index; cosine distance matches text-embedding-3-small convention.
CREATE INDEX IF NOT EXISTS founder_embeddings_ivfflat
  ON founder_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE TABLE IF NOT EXISTS conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id     uuid NOT NULL REFERENCES founders(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'active',
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_founder_idx ON conversations (founder_id);

CREATE TABLE IF NOT EXISTS turns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction         text NOT NULL CHECK (direction IN ('in','out')),
  wati_message_id   text,
  text              text NOT NULL,
  intent            text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Idempotency on inbound WATI messages. Null values allowed (outbound rows).
CREATE UNIQUE INDEX IF NOT EXISTS turns_wati_message_id_unique
  ON turns (wati_message_id) WHERE wati_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS turns_conv_created_idx ON turns (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS search_state (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  role            text,
  sector          text[] NOT NULL DEFAULT ARRAY[]::text[],
  stage           text[] NOT NULL DEFAULT ARRAY[]::text[],
  location        text[] NOT NULL DEFAULT ARRAY[]::text[],
  seniority       text,
  must_have       text[] NOT NULL DEFAULT ARRAY[]::text[],
  nice_to_have    text[] NOT NULL DEFAULT ARRAY[]::text[],
  anti_prefs      text[] NOT NULL DEFAULT ARRAY[]::text[],
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candidates_shown (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  founder_id      uuid NOT NULL REFERENCES founders(id) ON DELETE CASCADE,
  rank            integer NOT NULL,
  rationale       text NOT NULL,
  action          text NOT NULL DEFAULT 'shown' CHECK (action IN ('shown','accepted','skipped')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidates_conv_founder_idx
  ON candidates_shown (conversation_id, founder_id);

CREATE TABLE IF NOT EXISTS match_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id   uuid NOT NULL REFERENCES founders(id) ON DELETE CASCADE,
  target_id      uuid NOT NULL REFERENCES founders(id) ON DELETE CASCADE,
  status         text NOT NULL CHECK (status IN
                   ('proposed','awaiting_mutual','mutual_accept','declined','expired','intro_sent','failed_delivery')),
  requester_note text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_requests_active_pair_idx
  ON match_requests (requester_id, target_id, status);
CREATE INDEX IF NOT EXISTS match_requests_status_expires_idx
  ON match_requests (status, expires_at);

CREATE TABLE IF NOT EXISTS intros (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_request_id uuid NOT NULL REFERENCES match_requests(id) ON DELETE CASCADE,
  intro_text       text NOT NULL,
  sent_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_type_created_idx ON events (type, created_at);
