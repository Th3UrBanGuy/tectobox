-- 003-add-indexes.sql — Add missing performance indexes (seg-08 / M19)
--
-- Adds composite/foreign key indexes on inbox_events, client_webhooks, push_subscriptions.
-- Idempotent: safe to run multiple times.

CREATE INDEX IF NOT EXISTS idx_inbox_events_created_at ON inbox_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_events_unprocessed ON inbox_events(created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_client_webhooks_client_id ON client_webhooks(client_id);
CREATE INDEX IF NOT EXISTS idx_client_webhooks_client_created ON client_webhooks(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_client_id ON push_subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_client_user ON push_subscriptions(client_id, user_id);
