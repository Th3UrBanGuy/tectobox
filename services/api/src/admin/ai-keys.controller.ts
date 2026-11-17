import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Inject,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import pg from 'pg';
import crypto from 'node:crypto';
import { DB_POOL } from '../database/database.module.js';
import { encrypt, decrypt } from '../common/crypto.js';

/**
 * AI API Keys — admin management for the Gemini key pool (2026-11-17).
 *
 * The Go AI engine serves direct Gemini calls from a key pool
 * (services/ai/pkg/keypool): uniform-random key per attempt, per-key
 * cooldown after consecutive failures, web2api as fallback. Keys seeded
 * from the VPS .env (GEMINI_API_KEYS) live only in the ai process.
 * Keys added here are stored ENCRYPTED in Postgres (ai_api_keys) and
 * pushed to the ai pool over the internal Docker network
 * (POST http://ai:8081/internal/pool/keys). A periodic re-push
 * (every 5 min) heals ai restarts, which wipe the in-memory pool back
 * to its env seed.
 *
 * Security — the rules, enforced here:
 *  - A key VALUE is never returned by any endpoint, never logged, and
 *    only ever sent to two places: Google (live probe, header) and the
 *    ai service (internal network, request body).
 *  - The admin panel sees fingerprints (SHA-256, first 12 hex — the
 *    same fingerprint the Go pool computes) + counters only.
 *  - A new key is live-probed BEFORE it is stored: the probe must
 *    return 200. A 403 means the key authenticates but its Google
 *    Cloud project has no free tier (the live key3 case) — it is
 *    rejected with that reason, not stored.
 *  - No /internal/* endpoint is created on this api for the ai service
 *    to pull from: the Caddy gateway reverse-proxies EVERYTHING to
 *    api:3120, so an unguarded api route would be public. The sync
 *    direction is api → ai only (ai:8081 has no published port and no
 *    gateway route, so its /internal/pool endpoints are reachable
 *    solely from inside the Docker network).
 */

const AI_INTERNAL_URL =
  process.env.AI_INTERNAL_URL || 'http://ai:8081';
const POOL_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10 * 1000;

export function fingerprintKey(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 12);
}

function isKeyShape(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/** Live-probe a key against the Gemini API. Returns ok, or a reason. */
async function probeKey(
  value: string,
): Promise<{ ok: boolean; reason?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models',
      {
        method: 'GET',
        headers: { 'x-goog-api-key': value },
        signal: ctrl.signal,
      },
    );
    if (res.status === 200) return { ok: true };
    if (res.status === 403) {
      return {
        ok: false,
        reason:
          'This key authenticates but its Google Cloud project has no Gemini free tier — enable billing on that project first.',
      };
    }
    if (res.status === 400 || res.status === 401) {
      return { ok: false, reason: 'Google rejected this key (invalid key).' };
    }
    return { ok: false, reason: `Google returned HTTP ${res.status}.` };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, reason: 'Probe timed out after 10s.' };
    }
    return { ok: false, reason: `Probe failed: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

type PoolKeyStat = {
  fingerprint: string;
  source: string;
  label: string;
  uses: number;
  successes: number;
  failures: number;
  healthy: boolean;
  cooldown_until?: string;
  last_used?: string;
  last_failure?: string;
};

@Controller('api/admin/ai/keys')
@UseGuards(TenantGuard, AdminGuard)
export class AiKeysController implements OnModuleInit, OnModuleDestroy {
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onModuleInit() {
    try {
      await this.pool.query(`
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
      `);
    } catch (err: any) {
      console.warn('[ai-keys] Failed to ensure ai_api_keys table:', err.message);
    }
    // Re-push active DB keys to the ai pool every 5 minutes. The ai
    // pool is in-memory: a container restart wipes admin-added keys
    // back to the env seed, and this heals it without anyone noticing.
    // The timer is unref'd so it never blocks shutdown.
    this.syncTimer = setInterval(() => {
      this.syncPool().catch((err) =>
        console.warn('[ai-keys] periodic pool sync failed:', err.message),
      );
    }, POOL_SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();
    // First sync shortly after boot (the ai container may still be
    // starting; a failure here is healed by the next interval).
    setTimeout(() => {
      this.syncPool().catch((err) =>
        console.warn('[ai-keys] initial pool sync failed:', err.message),
      );
    }, 15_000).unref?.();
  }

  onModuleDestroy() {
    if (this.syncTimer) clearInterval(this.syncTimer);
  }

  /** Push every active DB key into the ai pool (idempotent — the pool dedupes by fingerprint). */
  private async syncPool(): Promise<{ pushed: number; failed: number }> {
    const res = await this.pool.query(
      `SELECT id, key_enc, key_fp, label FROM ai_api_keys WHERE is_active = TRUE`,
    );
    let pushed = 0;
    let failed = 0;
    for (const row of res.rows) {
      let value: string;
      try {
        value = decrypt(row.key_enc);
      } catch {
        failed++;
        continue;
      }
      try {
        await this.pushToPool(value, row.label);
        pushed++;
      } catch {
        failed++;
      }
    }
    return { pushed, failed };
  }

  /** POST one key to the ai pool. Throws on any non-2xx / network error. */
  private async pushToPool(value: string, label: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${AI_INTERNAL_URL}/internal/pool/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: value, source: 'admin', label }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`ai pool returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as { fingerprint?: string };
      return data.fingerprint || fingerprintKey(value);
    } finally {
      clearTimeout(timer);
    }
  }

  private async removeFromPool(fp: string): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      await fetch(`${AI_INTERNAL_URL}/internal/pool/keys?fp=${encodeURIComponent(fp)}`, {
        method: 'DELETE',
        signal: ctrl.signal,
      });
    } catch (err: any) {
      console.warn('[ai-keys] pool remove failed (healed by next sync):', err.message);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchPoolStats(): Promise<{
    total: number;
    keys: PoolKeyStat[];
  }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${AI_INTERNAL_URL}/internal/pool`, {
        signal: ctrl.signal,
      });
      if (!res.ok) return { total: 0, keys: [] };
      return (await res.json()) as { total: number; keys: PoolKeyStat[] };
    } catch {
      return { total: 0, keys: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  /** List: live pool stats (env + admin keys, fingerprints only) merged with the durable DB rows. */
  @Get()
  async list() {
    const [poolStats, dbRes] = await Promise.all([
      this.fetchPoolStats(),
      this.pool.query(
        `SELECT id, key_fp, label, is_active, uses, fails, last_used_at, last_tested_at, last_test_error, created_at
         FROM ai_api_keys ORDER BY created_at ASC`,
      ),
    ]);
    const poolByFp = new Map<string, PoolKeyStat>(
      poolStats.keys.map((k) => [k.fingerprint, k]),
    );
    return {
      poolTotal: poolStats.total,
      poolHealthy: poolStats.keys.filter((k) => k.healthy).length,
      pool: poolStats.keys,
      stored: dbRes.rows.map((r) => ({
        id: r.id,
        fingerprint: r.key_fp,
        label: r.label,
        isActive: r.is_active,
        uses: r.uses,
        fails: r.fails,
        lastUsedAt: r.last_used_at,
        lastTestedAt: r.last_tested_at,
        lastTestError: r.last_test_error,
        createdAt: r.created_at,
        inPool: poolByFp.has(r.key_fp),
        healthy: poolByFp.get(r.key_fp)?.healthy ?? null,
      })),
    };
  }

  /** Add a key: live-probe first, then encrypt + store, then push to the pool. */
  @Post()
  async add(@Body() body: { key?: unknown; label?: unknown }) {
    if (!isKeyShape(body.key)) {
      throw new BadRequestException(
        'A Gemini API key is at least 20 characters (letters, digits, . _ -).',
      );
    }
    const label = typeof body.label === 'string' ? body.label.slice(0, 100) : '';
    const probe = await probeKey(body.key);
    if (!probe.ok) {
      throw new BadRequestException(
        `Key not added: ${probe.reason || 'live probe failed.'}`,
      );
    }
    const fp = fingerprintKey(body.key);
    const existing = await this.pool.query(
      `SELECT id FROM ai_api_keys WHERE key_fp = $1`,
      [fp],
    );
    if (existing.rows.length > 0) {
      throw new BadRequestException('This key is already in the pool.');
    }
    const ins = await this.pool.query(
      `INSERT INTO ai_api_keys (key_enc, key_fp, label, last_tested_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [encrypt(body.key), fp, label],
    );
    let poolSynced = true;
    try {
      await this.pushToPool(body.key, label);
    } catch (err: any) {
      // Stored durably; the 5-min re-push heals the pool. Say so.
      poolSynced = false;
      console.warn('[ai-keys] pool push failed after store:', err.message);
    }
    return {
      id: ins.rows[0].id,
      fingerprint: fp,
      label,
      poolSynced,
      note: poolSynced
        ? undefined
        : 'Stored, but the live pool push failed — the key joins the pool on the next 5-minute sync.',
    };
  }

  /** Delete a stored key: remove the row and drop it from the live pool. */
  @Delete(':id')
  async remove(@Param('id') id: string) {
    const parsed = Number(id);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('Invalid key id.');
    }
    const found = await this.pool.query(
      `SELECT key_fp FROM ai_api_keys WHERE id = $1`,
      [parsed],
    );
    if (found.rows.length === 0) {
      throw new NotFoundException('Key not found.');
    }
    const fp = found.rows[0].key_fp as string;
    await this.pool.query(`DELETE FROM ai_api_keys WHERE id = $1`, [parsed]);
    await this.removeFromPool(fp);
    return { removed: fp };
  }

  /** Test a stored key live (decrypt → probe → record). Never returns the key. */
  @Post(':id/test')
  async test(@Param('id') id: string) {
    const parsed = Number(id);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('Invalid key id.');
    }
    const found = await this.pool.query(
      `SELECT key_enc, key_fp FROM ai_api_keys WHERE id = $1`,
      [parsed],
    );
    if (found.rows.length === 0) {
      throw new NotFoundException('Key not found.');
    }
    let value: string;
    try {
      value = decrypt(found.rows[0].key_enc);
    } catch {
      throw new BadRequestException('Stored key cannot be decrypted.');
    }
    const probe = await probeKey(value);
    await this.pool.query(
      `UPDATE ai_api_keys SET last_tested_at = NOW(), last_test_error = $2 WHERE id = $1`,
      [parsed, probe.ok ? null : probe.reason || 'probe failed'],
    );
    return {
      fingerprint: found.rows[0].key_fp,
      ok: probe.ok,
      reason: probe.reason,
    };
  }

  /** Force an immediate re-push of all active stored keys to the pool. */
  @Post('sync')
  async syncNow() {
    return this.syncPool();
  }
}
