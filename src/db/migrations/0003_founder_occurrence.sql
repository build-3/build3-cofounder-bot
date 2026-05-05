-- 0003_founder_occurrence.sql — track how often each founder has been
-- surfaced as a candidate, globally across conversations.
--
-- Why: with a small cohort (~250 founders), a popular profile can dominate
-- top-of-rank for many requesters. The retriever uses `times_shown` as a
-- light deprioritizer in ORDER BY (not a hard filter — a perfect match
-- should still win) so the AI naturally rotates through the cohort instead
-- of repeatedly surfacing the same handful.
--
-- Safe to re-run.

ALTER TABLE founders
  ADD COLUMN IF NOT EXISTS times_shown integer NOT NULL DEFAULT 0;

ALTER TABLE founders
  ADD COLUMN IF NOT EXISTS last_shown_at timestamptz;

-- Backfill from existing candidates_shown so the counter reflects history.
-- Idempotent: GREATEST keeps an already-set counter from going backwards.
UPDATE founders f
SET
  times_shown   = GREATEST(f.times_shown, sub.cnt),
  last_shown_at = COALESCE(GREATEST(f.last_shown_at, sub.last_at), f.last_shown_at, sub.last_at)
FROM (
  SELECT founder_id, COUNT(*)::int AS cnt, MAX(created_at) AS last_at
  FROM candidates_shown
  GROUP BY founder_id
) sub
WHERE f.id = sub.founder_id;

-- Index for retriever's deprioritization sort (founder_embeddings ANN order is
-- the primary sort; this exists so the secondary sort doesn't trigger a heap
-- scan on tens of thousands of rows once the cohort grows).
CREATE INDEX IF NOT EXISTS founders_times_shown_idx ON founders (times_shown);
