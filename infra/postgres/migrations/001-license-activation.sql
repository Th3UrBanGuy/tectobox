-- 001-license-activation.sql — Tectobox licensing redesign (2026-11-12)
--
-- Applies the licence-key activation model:
--   * a generated key is stored as status 'pending_activation' with
--     starts_at/ends_at NULL until the client activates it themselves;
--   * validity_days records the paid validity (fractional days allowed,
--     e.g. 0.0208 = 30 minutes) so activation can compute ends_at;
--   * starts_at becomes nullable (a key-only row has no start yet).
--
-- There is no migrations runner in this repo: apply manually against the
-- live database (psql -f) at deploy time, BEFORE the new API code goes
-- live. All statements are idempotent (IF EXISTS / IF NOT EXISTS) so a
-- re-run is safe. Fresh installs get the same shape from schema.sql.
--
-- Deploy-time data step (separate, manual — NOT in this file): cancel all
-- legacy auto-provisioned TB-AUTO licences so no workspace keeps free
-- full access after the redesign ships.

-- 1. 'pending_activation' joins the licence status set.
ALTER TABLE licenses DROP CONSTRAINT IF EXISTS licenses_status_check;
ALTER TABLE licenses
  ADD CONSTRAINT licenses_status_check
  CHECK (status IN ('active', 'paused', 'expired', 'cancelled', 'pending_activation'));

-- 2. Paid validity in days (fractional: 0.0208 = 30 min, 0.0417 = 1 h).
--    NUMERIC, not INTEGER — trials and short keys need sub-day precision.
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS validity_days NUMERIC(10, 4);

-- 3. A key-only licence has no start until the client activates it.
ALTER TABLE licenses ALTER COLUMN starts_at DROP NOT NULL;

-- 4. Audit trail for licence lifecycle events (issue / activate / pause /
--    resume / cancel / topup / assign / trial). Best-effort writes from
--    LicensingService.audit() — the table missing must never break a
--    licence operation (the service catches and swallows audit errors).
CREATE TABLE IF NOT EXISTS license_audit (
    id SERIAL PRIMARY KEY,
    actor VARCHAR(255),
    action VARCHAR(50) NOT NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    license_id INTEGER REFERENCES licenses(id) ON DELETE SET NULL,
    code VARCHAR(255),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_license_audit_client ON license_audit(client_id);
CREATE INDEX IF NOT EXISTS idx_license_audit_license ON license_audit(license_id);
CREATE INDEX IF NOT EXISTS idx_license_audit_created ON license_audit(created_at);
