-- 0004_telegram_identity.sql
-- Adds Telegram identity to founders. Telegram does not expose phone numbers
-- by default, so we identify founders by their Telegram username (the @handle)
-- during testing. Production migration will be a contact-share flow that
-- back-fills telegram_chat_id once the founder taps a request_contact button.
--
-- Both columns are nullable: a founder can exist without a Telegram link
-- (the WATI path still works on phone), and we won't know chat_id until the
-- founder messages us at least once.
--
-- The username column has a partial unique index — multiple founders can have
-- NULL username (haven't linked yet), but a non-null username uniquely
-- identifies one founder.

ALTER TABLE founders
  ADD COLUMN IF NOT EXISTS telegram_username text,
  ADD COLUMN IF NOT EXISTS telegram_chat_id  bigint;

CREATE UNIQUE INDEX IF NOT EXISTS founders_telegram_username_unique
  ON founders (telegram_username)
  WHERE telegram_username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS founders_telegram_chat_id_unique
  ON founders (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;
