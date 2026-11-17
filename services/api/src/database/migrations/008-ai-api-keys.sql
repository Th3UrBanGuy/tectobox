-- 008-ai-api-keys.sql — Gemini API key pool, admin-managed keys (2026-11-17)
--
-- The Go AI engine serves direct Gemini calls from a key pool
-- (services/ai/pkg/keypool): uniform-random key per attempt, per-key
-- cooldown after consecutive failures, web2api as fallback. Keys seeded
-- from the VPS .env (GEMINI_API_KEYS) are NOT stored here — this table
-- holds only keys added later from the admin panel (Settings → AI API
-- Keys). The api encrypts them (AES-256-GCM, ENCRYPTION_KEY) and pushes
-- them to the ai service's in-memory pool over the internal Docker
-- network; a periodic re-push heals ai restarts.
--
-- Columns:
--   - key_enc: AES-256-GCM ciphertext (common/crypto.ts `encrypt`).
--     The plaintext key is NEVER stored and NEVER returned by any API.
--   - key_fp: SHA-256 fingerprint (first 12 hex chars) — the same
--     fingerprint the Go pool computes, so the api and the pool agree
--     on which key is which. This is what the admin panel displays.
--   - is_active: only active rows are pushed to the pool.
--   - uses/fails/last_used_at: mirrored from the pool stats when the
--     admin panel loads (the pool is the live counter; these columns
--     are the durable record).
--
-- Idempotent: safe to run multiple times. Backward-compatible: a new
-- table only — old code keeps working until the new deploy lands.
CREATE TABLE IF NOT EXISTS ai_api_keys (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
  key_enc TEXT NOT NULL,
  key_fp VARCHAR(12) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  uses INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  last_tested_at TIMESTAMPTZ,
  last_test_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_api_keys_active ON ai_api_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_ai_api_keys_fp ON ai_api_keys(key_fp);
