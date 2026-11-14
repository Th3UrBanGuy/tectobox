-- 005-admin-notifications.sql — Sent-notifications history (P12, 2026-11-15)
--
-- Every admin broadcast (POST /api/admin/notify) is recorded here so the
-- Notifications tab can show what was actually sent — never invented
-- history. Idempotent: safe to run multiple times.
CREATE TABLE IF NOT EXISTS admin_notifications (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Admin notice',
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_client ON admin_notifications(client_id, created_at DESC);
