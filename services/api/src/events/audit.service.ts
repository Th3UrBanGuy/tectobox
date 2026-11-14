import pg from 'pg';

/**
 * Fail-open audit log.
 *
 * Moved verbatim out of `EventsService.writeAudit` (Phase 3 of the
 * modular restructure). No behaviour change: inserts into `audit_log`
 * without throwing on error or crashing the caller.
 */
export class AuditService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * M2: Fail-open audit log write helper.
   * Inserts an event into `audit_log` without throwing on error or crashing the caller.
   */
  async writeAudit(
    actorId: string | number | null,
    clientId: number | null,
    action: string,
    details?: any
  ): Promise<void> {
    try {
      if (!this.pool) return;
      const actor = actorId != null ? String(actorId) : 'system';
      const event = action;
      const target = clientId != null
        ? (typeof clientId === 'number' ? `tenant:${clientId}` : String(clientId))
        : (details?.target ? String(details.target) : (details?.targetUserId ? `user:${details.targetUserId}` : null));
      const ip = details?.ip ?? (typeof details === 'object' ? JSON.stringify(details) : (details ? String(details) : null));

      await this.pool.query(
        `INSERT INTO audit_log (actor, event, target, ip, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [actor, event, target, ip ? String(ip).slice(0, 255) : null]
      );
    } catch (err: any) {
      console.warn('[events] audit log write failed (non-fatal):', err?.message || err);
    }
  }
}
