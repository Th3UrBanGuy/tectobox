-- 002-add-token-version.sql — Add token_version for session revocation (seg-01)
--
-- Adds token_version integer column on users (default 1).
-- Bumping token_version invalidates all previously issued JWT tokens for that user.
--
-- Idempotent: safe to run multiple times.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
