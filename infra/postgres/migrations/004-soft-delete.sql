-- 004-soft-delete.sql — Add soft-delete and purge columns to conversations (seg-08 / RC8)
--
-- deleted_at: timestamp when the conversation was soft-deleted (NULL if active).
-- purge_at: timestamp when the conversation is scheduled for hard purge (now + 15 days).
-- Idempotent: safe to run multiple times.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS purge_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_conversations_deleted_at ON conversations(client_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_conversations_purge_at ON conversations(purge_at) WHERE purge_at IS NOT NULL;
