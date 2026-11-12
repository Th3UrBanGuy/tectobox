import { Injectable, Inject } from '@nestjs/common';
import pg from 'pg';
import crypto from 'crypto';
import { DB_POOL } from '../database/database.module.js';

/**
 * LicensingService — the single source of truth for license resolution.
 *
 * Ported from old-code/src/db.js resolveAccess / activeLicense /
 * consumeAiCredit (Oct 7 semantics), MINUS the legacy pre-2026-10-07
 * carve-out: there is no legacy full access anymore. A workspace without
 * an active license is mode 'none' (locked), never full access.
 *
 * Rules:
 * - suspended workspace -> mode 'suspended', aiReason 'workspace_suspended'
 * - no active license   -> mode 'none',     aiReason 'no_active_license'
 * - time license past ends_at -> row flipped to 'expired' inline at
 *   resolution, mode 'none', aiReason 'license_expired'
 * - credit license exhausted -> mode 'licensed' (features still listed),
 *   aiAllowed false, aiReason 'credits_exhausted'
 * - feature-kind license -> per-feature grants from license_feature_credits
 * - aiAllowed = !aiPaused && 'ai_response' is granted
 *
 * consumeAiCredit is the atomic credit deduction: a single UPDATE with a
 * `credits_used < credits_total` guard, so concurrent replies cannot
 * over-deduct. Time licences are unlimited in-window (no-op, true).
 */

export type AccessMode = 'none' | 'licensed' | 'suspended';

export type AiReason =
  | 'workspace_suspended'
  | 'no_active_license'
  | 'license_expired'
  | 'credits_exhausted'
  | 'feature_not_in_plan'
  | 'ai_not_granted'
  | 'paused'
  | null;

export interface LicensePayload {
  id: number;
  code: string;
  status: string;
  kind: string;
  plan_id: number | null;
  plan_name: string | null;
  billing_period: string | null;
  starts_at: string | null;
  ends_at: string | null;
  credits_total: number;
  credits_used: number;
  validity_days: number | null;
  features: string[];
}

export interface AccessPayload {
  mode: AccessMode;
  features: string[];
  aiAllowed: boolean;
  aiReason: AiReason;
  license: LicensePayload | null;
  suspended: boolean;
  aiPaused: boolean;
}

export const SYSTEM_FEATURE_KEYS = [
  'combined_inbox',
  'ai_response',
  'webchat',
  'broadcast',
  'lead_intel',
  'knowledge',
  'api_access',
] as const;

@Injectable()
export class LicensingService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  parseFeatures(featuresJson: any): string[] {
    if (featuresJson == null) return [];
    let raw: any = featuresJson;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter((f) => typeof f === 'string');
  }

  toLicensePayload(row: any): LicensePayload {
    return {
      id: row.id,
      code: row.code,
      status: row.status,
      kind: row.kind,
      plan_id: row.plan_id ?? null,
      plan_name: row.plan_name || null,
      billing_period: row.billing_period ?? null,
      starts_at: row.starts_at ?? null,
      ends_at: row.ends_at ?? null,
      credits_total: Number(row.credits_total ?? 0),
      credits_used: Number(row.credits_used ?? 0),
      validity_days: row.validity_days != null ? Number(row.validity_days) : null,
      features: this.parseFeatures(row.features_json),
    };
  }

  async activeLicense(clientId: number): Promise<any | null> {
    const res = await this.pool.query(
      `SELECT l.*, p.name AS plan_name FROM licenses l
       LEFT JOIN plans p ON p.id = l.plan_id
       WHERE l.client_id = $1 AND l.status = 'active' ORDER BY l.id DESC LIMIT 1`,
      [clientId]
    );
    return res.rows[0] || null;
  }

  async resolveAccess(clientId: number): Promise<AccessPayload> {
    const clientRes = await this.pool.query(
      'SELECT id, suspended, ai_paused FROM clients WHERE id = $1 LIMIT 1',
      [clientId]
    );
    const client = clientRes.rows[0];
    const base = {
      suspended: Boolean(client?.suspended),
      aiPaused: Boolean(client?.ai_paused),
      features: [] as string[],
      aiAllowed: false,
      aiReason: null as AiReason,
      license: null as LicensePayload | null,
    };
    if (!client) return { ...base, mode: 'none', aiReason: 'no_active_license' };
    if (client.suspended) {
      return { ...base, mode: 'suspended', aiReason: 'workspace_suspended' };
    }

    const lic = await this.activeLicense(clientId);
    if (!lic) return { ...base, mode: 'none', aiReason: 'no_active_license' };

    const license = this.toLicensePayload(lic);

    if (lic.kind === 'time') {
      if (lic.ends_at && new Date(lic.ends_at).getTime() <= Date.now()) {
        // Lazy expiry: flip the row inline at resolution (old-code pattern).
        await this.pool.query(
          "UPDATE licenses SET status = 'expired' WHERE id = $1 AND status = 'active'",
          [lic.id]
        );
        license.status = 'expired';
        return { ...base, mode: 'none', aiReason: 'license_expired', license };
      }
      const features = this.parseFeatures(lic.features_json);
      const aiAllowed = !base.aiPaused && features.includes('ai_response');
      return {
        ...base,
        mode: 'licensed',
        features,
        aiAllowed,
        aiReason: base.aiPaused ? 'paused' : aiAllowed ? null : 'feature_not_in_plan',
        license,
      };
    }

    if (lic.kind === 'credit') {
      const features = this.parseFeatures(lic.features_json);
      if (Number(lic.credits_used ?? 0) >= Number(lic.credits_total ?? 0)) {
        return {
          ...base,
          mode: 'licensed',
          features,
          aiAllowed: false,
          aiReason: 'credits_exhausted',
          license,
        };
      }
      const aiAllowed = !base.aiPaused && features.includes('ai_response');
      return {
        ...base,
        mode: 'licensed',
        features,
        aiAllowed,
        aiReason: base.aiPaused ? 'paused' : aiAllowed ? null : 'feature_not_in_plan',
        license,
      };
    }

    // kind === 'feature': a feature is granted when unlimited, or when it
    // still has credits left.
    const grants = await this.pool.query(
      'SELECT feature, mode, credits_total, credits_used FROM license_feature_credits WHERE license_id = $1',
      [lic.id]
    );
    const granted = grants.rows
      .filter((g: any) => g.mode === 'unlimited' || Number(g.credits_used ?? 0) < Number(g.credits_total ?? 0))
      .map((g: any) => g.feature);
    const aiGrant = grants.rows.find((g: any) => g.feature === 'ai_response');
    const aiOk =
      !!aiGrant &&
      (aiGrant.mode === 'unlimited' ||
        Number(aiGrant.credits_used ?? 0) < Number(aiGrant.credits_total ?? 0));
    const aiAllowed = !base.aiPaused && aiOk;
    return {
      ...base,
      mode: 'licensed',
      features: granted,
      aiAllowed,
      aiReason: base.aiPaused ? 'paused' : aiOk ? null : 'ai_not_granted',
      license,
    };
  }

  /**
   * Atomic AI-credit deduction. Returns false when no credit was left (or
   * no licence / no ai_response grant exists). Time licences are unlimited
   * in-window and always return true. The single UPDATE with the
   * `credits_used < credits_total` guard is what makes this safe under
   * concurrency — two simultaneous replies cannot both take the last credit.
   */
  async consumeAiCredit(clientId: number): Promise<boolean> {
    const lic = await this.activeLicense(clientId);
    if (!lic) return false;
    if (lic.kind === 'time') return true;
    if (lic.kind === 'credit') {
      const res = await this.pool.query(
        `UPDATE licenses SET credits_used = credits_used + 1
         WHERE id = $1 AND status = 'active' AND credits_used < credits_total`,
        [lic.id]
      );
      return (res.rowCount ?? 0) > 0;
    }
    // feature kind: per-feature ai_response grant
    const g = await this.pool.query(
      `SELECT mode, credits_total, credits_used FROM license_feature_credits
       WHERE license_id = $1 AND feature = 'ai_response' LIMIT 1`,
      [lic.id]
    );
    if (g.rows.length === 0) return false;
    if (g.rows[0].mode === 'unlimited') return true;
    const res = await this.pool.query(
      `UPDATE license_feature_credits SET credits_used = credits_used + 1
       WHERE license_id = $1 AND feature = 'ai_response' AND mode = 'credit'
         AND credits_used < credits_total`,
      [lic.id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Issue a trial (test) licence: an ordinary `time` licence with a short
   * ends_at and ALL 7 system features (note='trial'). Cancels any current
   * active licence first (newer-wins, same as issueLicense).
   */
  async issueTrialLicense(
    clientId: number,
    minutes: number,
    createdBy?: string | null
  ): Promise<any> {
    const code = 'LIC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const endsAt = new Date(Date.now() + minutes * 60000);
    await this.pool.query(
      "UPDATE licenses SET status = 'cancelled' WHERE client_id = $1 AND status = 'active'",
      [clientId]
    );
    const res = await this.pool.query(
      `INSERT INTO licenses (code, client_id, plan_id, kind, starts_at, ends_at,
         credits_total, credits_used, status, features_json, validity_days, note, created_by, created_at)
       VALUES ($1, $2, NULL, 'time', NOW(), $3, 0, 0, 'active', $4::jsonb, $5, 'trial', $6, NOW())
       RETURNING *`,
      [
        code,
        clientId,
        endsAt,
        JSON.stringify([...SYSTEM_FEATURE_KEYS]),
        minutes / 1440,
        createdBy ?? null,
      ]
    );
    const row = res.rows[0];
    await this.audit('trial_issue', createdBy ?? null, clientId, row?.id ?? null, code, `${minutes} min trial`);
    return row;
  }

  /**
   * Best-effort audit trail for licence actions. Never throws: a failed
   * audit write must not break the licence action itself.
   */
  async audit(
    action: string,
    actor: string | null,
    clientId: number | null,
    licenseId: number | null,
    code: string | null,
    note?: string | null
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO license_audit (actor, action, client_id, license_id, code, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [actor, action, clientId, licenseId, code, note ?? null]
      );
    } catch (err: any) {
      console.warn('[licensing] audit write failed (non-fatal):', err?.message || err);
    }
  }
}
