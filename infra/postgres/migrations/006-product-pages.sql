-- 006-product-pages.sql — Product pages module (2026-11-15)
--
-- Shareable per-product pages on the Tectobox cPanel PHP host:
--   - variants_json: size/variant options per product, each with optional
--     price/stock overrides (null = inherit the product's value).
--   - whatsapp_number: the shop's WhatsApp number, used for the
--     "Order on WhatsApp" button on the product page. Null = no button.
-- Idempotent: safe to run multiple times.
ALTER TABLE products ADD COLUMN IF NOT EXISTS variants_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(50);
