-- 007-payment-config-product-aliases.sql — Payment config + product aliases (2026-11-16)
--
-- Fix 5 (order/payment audit 2026-11-16): the bot confirmed orders with
-- no payment step anywhere — no COD/online question, no advance, no
-- bKash number. These columns are the shop's payment configuration,
-- set from Settings → Payment Settings (GET/POST /api/payment-config):
--   - payment_modes: 'cod' | 'online' | 'both' (default 'cod').
--   - advance_required_bdt: advance the customer must pay before
--     delivery (0 = no advance). Stored on each order row at creation.
--   - bkash_number / nagad_number / rocket_number: the numbers the
--     customer pays to (null = not configured). Cleaned to digits,
--     7–15 digits, by the API before saving.
--
-- Fix 3 (same audit): a Latin brand name written in Bengali script
-- ("কিটক্যাট" for Kitkat) matched nothing, so the order silently
-- died. Owner-entered aliases per product, matched as a full phrase
-- by the catalog matcher (TS + Go) and editable in the product editor:
--   - aliases_json: JSONB array of alias strings, e.g. ["কিটক্যাট"].
--
-- Idempotent: safe to run multiple times. Backward-compatible: every
-- column has a default, so old code keeps working until the new
-- deploy lands (migrate.sh runs before the containers recreate).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_modes VARCHAR(20) NOT NULL DEFAULT 'cod';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS advance_required_bdt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS bkash_number VARCHAR(50);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS nagad_number VARCHAR(50);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS rocket_number VARCHAR(50);
ALTER TABLE products ADD COLUMN IF NOT EXISTS aliases_json JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Guard the mode value at the DB level too (the API validates as well).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_payment_modes_check'
  ) THEN
    ALTER TABLE clients ADD CONSTRAINT clients_payment_modes_check
      CHECK (payment_modes IN ('cod', 'online', 'both'));
  END IF;
END $$;
