-- 0002_concurrency_guards.sql — prevent the same founder being shown twice
-- to the same conversation under concurrent dispatch (WATI retries a message
-- with a new wati_message_id when our function is slow, so the turns
-- unique-index on wati_message_id doesn't catch it).
--
-- Safe to re-run.

-- If any dup rows exist from past runs, collapse them to the earliest.
DELETE FROM candidates_shown a
USING candidates_shown b
WHERE a.conversation_id = b.conversation_id
  AND a.founder_id      = b.founder_id
  AND a.created_at      > b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS candidates_shown_conv_founder_unique
  ON candidates_shown (conversation_id, founder_id);

-- Per-conversation dispatch lock. One row per conversation currently being
-- handled; a row with a fresh `acquired_at` blocks concurrent dispatchers.
-- We use INSERT ... ON CONFLICT because Supabase's pooler (transaction mode)
-- makes session-scoped pg_advisory_lock unreliable across postgres-js calls.
CREATE TABLE IF NOT EXISTS dispatch_locks (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  held_by         text NOT NULL
);
