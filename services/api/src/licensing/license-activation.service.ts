import pg from 'pg';
import { BadRequestException, ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { LicensingService } from './licensing.service.js';
import { ActivateLicenseDto } from './dto/licensing.dto.js';
import { toAccessResponse } from './access-response.js';

// A key that was generated but never activated stops being redeemable
// after this many days (lazy check at activation time — no cron).
const KEY_ACTIVATION_TTL_DAYS = 30;

/**
 * Client self-service licence activation.
 *
 * Split out of `LicensingController` (Phase 3 of the modular
 * restructure). Code moved verbatim; no behaviour change. The
 * 404-vs-foreign indistinguishability, the 30-day TTL → 410 Gone, the
 * BEGIN/cancel/activate/COMMIT/ROLLBACK transaction, and the fresh
 * access payload on success are all preserved exactly.
 */
export class LicenseActivationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly licensing: LicensingService
  ) {}

  /**
   * Client self-service licence activation. Tenant-guarded, NOT admin-only.
   * The code is looked up tenant-blind: an unknown code and a code that
   * belongs to another workspace both return 404, so keys cannot be
   * enumerated. A key older than KEY_ACTIVATION_TTL_DAYS is cancelled
   * lazily and returns 410 Gone. On success the current active licence is
   * cancelled and this one starts now (ends_at = NOW() + validity_days).
   */
  async activateLicense(
    tenantId: number,
    body: ActivateLicenseDto,
    req?: any
  ) {
    const rawCode = String(body?.code || '').trim();
    if (!rawCode) {
      throw new BadRequestException('code is required');
    }
    const code = rawCode.toUpperCase();

    const found = await this.pool.query(
      'SELECT * FROM licenses WHERE UPPER(code) = $1 LIMIT 1',
      [code]
    );
    // Unknown code and foreign-workspace code are indistinguishable (404)
    // so that keys cannot be enumerated.
    if (found.rows.length === 0 || Number(found.rows[0].client_id) !== Number(tenantId)) {
      throw new NotFoundException('License key not found');
    }
    const lic = found.rows[0];
    if (lic.status !== 'pending_activation') {
      throw new ConflictException('This license key has already been used or revoked');
    }
    const createdAt = new Date(lic.created_at).getTime();
    if (Date.now() - createdAt > KEY_ACTIVATION_TTL_DAYS * 86400000) {
      await this.pool.query(
        "UPDATE licenses SET status = 'cancelled' WHERE id = $1 AND status = 'pending_activation'",
        [lic.id]
      );
      throw new GoneException('This license key has expired (never activated within 30 days)');
    }

    const validityDays =
      lic.validity_days != null && Number(lic.validity_days) > 0
        ? Number(lic.validity_days)
        : lic.billing_period === 'yearly'
          ? 365
          : lic.billing_period === 'quarterly'
            ? 90
            : 30;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE licenses SET status = 'cancelled' WHERE client_id = $1 AND status = 'active'",
        [tenantId]
      );
      const activated = await client.query(
        `UPDATE licenses
         SET status = 'active', starts_at = NOW(), ends_at = NOW() + ($1 * INTERVAL '1 day')
         WHERE id = $2 AND status = 'pending_activation'
         RETURNING *`,
        [validityDays, lic.id]
      );
      if (activated.rows.length === 0) {
        throw new ConflictException('This license key has already been used or revoked');
      }
      await client.query('COMMIT');
      const row = activated.rows[0];
      await this.licensing.audit(
        'activate',
        req?.user?.username ?? null,
        tenantId,
        row.id,
        row.code,
        `activated, ${validityDays} days`
      );
      // Fresh access payload so the UI unlocks without a reload.
      const access = await this.licensing.resolveAccess(tenantId);
      return { ...toAccessResponse(access), license: access.license };
    } catch (err: any) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      if (
        err instanceof NotFoundException ||
        err instanceof ConflictException ||
        err instanceof GoneException ||
        err instanceof BadRequestException
      ) {
        throw err;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
