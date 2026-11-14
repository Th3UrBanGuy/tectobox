import pg from 'pg';
import crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { LicensingService } from './licensing.service.js';
import { EventsService } from '../events/events.service.js';
import { IssueLicenseDto } from './dto/licensing.dto.js';

/**
 * Licence issuance (admin). Two delivery modes — see `issueLicense`.
 *
 * Split out of `LicensingController` (Phase 3 of the modular
 * restructure). Code moved verbatim; no behaviour change. The
 * `getEvents()` fallback is preserved: when no `EventsService` is
 * injected, one is constructed from the pool + licensing service so
 * the audit write still happens (the specs rely on exactly two pool
 * calls for a key-only issue: the licence INSERT + the audit_log
 * INSERT).
 */
export class LicenseIssuanceService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly licensing: LicensingService,
    private readonly eventsService?: EventsService
  ) {}

  private getEvents(): EventsService {
    return this.eventsService || new EventsService(this.pool, this.licensing);
  }

  /**
   * Issue a licence. Two delivery modes:
   * - 'apply' (default): active immediately, cancels the client's current
   *   active licence (newer-wins). Used for test licences and direct
   *   assignment by the admin.
   * - 'key-only': creates a `pending_activation` row with starts_at/ends_at
   *   NULL. The admin copies the returned code and hands it to the client
   *   after payment; the client activates it themselves via
   *   POST /api/client/licenses/activate. The key is inert until then.
   * `days` accepts fractions (0.0208 = 30 min) and must be > 0.
   */
  async issueLicense(body: IssueLicenseDto, req?: any) {
    const createdBy = req?.user?.username ?? null;
    const clientId = body.client_id ? Number(body.client_id) : null;
    if (!clientId) {
      throw new BadRequestException('client_id is required');
    }
    const deliver = body.deliver || body.mode || 'apply';
    if (deliver !== 'apply' && deliver !== 'key-only') {
      throw new BadRequestException("deliver must be 'apply' or 'key-only'");
    }

    const code = 'LIC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    let days = body.days != null ? Number(body.days) : 30;
    let kind = body.kind || 'time';
    let featuresJson = JSON.stringify(body.features || []);
    let credits = Number(body.credits || body.credits_total || 0);
    let billingPeriod: string | null = body.billing_period || null;
    const planId = body.plan_id || body.planId || null;

    if (planId) {
      const pRes = await this.pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
      if (pRes.rows.length > 0) {
        const p = pRes.rows[0];
        kind = p.kind;
        featuresJson = typeof p.features_json === 'string' ? p.features_json : JSON.stringify(p.features_json || []);
        credits = Number(p.credits_included || 0);
        billingPeriod = p.billing_period;
        days = p.billing_period === 'yearly' ? 365 : p.billing_period === 'quarterly' ? 90 : 30;
      }
    }

    if (!Number.isFinite(days) || days <= 0) {
      throw new BadRequestException('days must be a number greater than 0');
    }

    if (deliver === 'key-only') {
      // The clock starts at activation: starts_at/ends_at stay NULL and the
      // intended duration is remembered in validity_days.
      const result = await this.pool.query(
        `INSERT INTO licenses (code, client_id, plan_id, kind, billing_period, starts_at, ends_at,
           credits_total, credits_used, status, features_json, validity_days, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, 0, 'pending_activation', $7, $8, $9, NOW())
         RETURNING *`,
        [code, clientId, planId, kind, billingPeriod, credits, featuresJson, days, createdBy]
      );
      const row = result.rows[0];
      await this.licensing.audit('key_issue', createdBy, clientId, row?.id ?? null, code, `key-only, ${days} days`);
      await this.getEvents().writeAudit(createdBy, clientId, 'license:issue', { code, days, deliver: 'key-only', licenseId: row?.id, ip: req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null });
      return { code, license: row };
    }

    const startsAt = new Date();
    const endsAt = new Date(Date.now() + days * 86400000);

    // Cancel existing active licenses for this client if any
    await this.pool.query("UPDATE licenses SET status = 'cancelled' WHERE client_id = $1 AND status = 'active'", [clientId]);

    const result = await this.pool.query(
      `INSERT INTO licenses (code, client_id, plan_id, kind, billing_period, starts_at, ends_at,
         credits_total, credits_used, status, features_json, validity_days, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'active', $9, $10, $11, NOW())
       RETURNING *`,
      [
        code,
        clientId,
        planId,
        kind,
        billingPeriod,
        startsAt,
        endsAt,
        credits,
        featuresJson,
        days,
        createdBy,
      ]
    );
    const row = result.rows[0];
    await this.licensing.audit('issue', createdBy, clientId, row?.id ?? null, code, `applied, ${days} days`);
    await this.getEvents().writeAudit(createdBy, clientId, 'license:issue', { code, days, deliver: 'apply', licenseId: row?.id, ip: req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null });
    return row;
  }
}
