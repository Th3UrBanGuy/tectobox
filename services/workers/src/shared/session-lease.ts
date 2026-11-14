import { LEASE_TTL_SECONDS, leaseKey } from '@tectonic/contracts';

/**
 * Fenced session registry — the lease half of `getSocketWithFencing`
 * (WhatsApp) and `getClientWithFencing` (Telegram), extracted once.
 *
 * Phase 2 of the modular restructure. Both channel workers ran the same
 * program: cached-entry lease validation, `acquireLease(key, 60)`, a 30 s
 * renewal interval, and on renewal failure remove-from-map + provider
 * teardown + cancel the outgoing consumer (the split-brain guard). The
 * two hand-rolled variants differed only in the provider teardown
 * (WhatsApp drains the pacer and ends the socket; Telegram disconnects
 * the client) and in interval bookkeeping (Telegram keeps a renewers map
 * and unrefs; WhatsApp does neither).
 *
 * The registry is generic over the session ENTRY (`{ sock, token }` /
 * `{ client, token }` — whatever the worker stores, including its token)
 * and wraps the worker's own map, so a worker that injects a map (the
 * WhatsApp tests seed `initialSockets`) keeps driving the same instance.
 *
 * Behaviour, preserved exactly:
 * - lease TTL 60 s, renewal every 30 s;
 * - the renewal interval is created BEFORE the provider object exists
 *   in the WhatsApp flow (it closes over the socket variable, which is
 *   null until `makeWASocket` returns) — `track()` therefore takes a
 *   lazy entry accessor, resolved at fire time, and the teardown guards
 *   a null entry exactly as the original `if (sock)` did;
 * - on renewal failure the entry is removed, the provider teardown runs,
 *   and the outgoing consumer is cancelled via the holder's tag/channel,
 *   read at fire time (the consumer registers after sessions are
 *   created, so the tag is not known when the registry is built);
 * - the Telegram send path still validates the DEFAULT-slot lease for
 *   every slot — that is a bug in the SEND callback (outgoing-consumer
 *   call site), not in this registry, and is deliberately NOT fixed
 *   here (known latent bug, separate fix);
 * - `remove()` clears the renewal interval AND the map entry (Telegram
 *   disconnect); `delete()` drops only the map entry (WhatsApp
 *   disconnect, whose interval is cleared by the socket close handler,
 *   as before).
 *
 * One deliberate micro-change: if the provider teardown itself throws,
 * the registry logs it and still cancels the consumer. The original
 * code would have let the throw skip the cancel (an unhandled rejection
 * in the interval callback) — the cancel is the safety-critical step,
 * so it must not depend on teardown succeeding.
 */
export const LEASE_RENEW_INTERVAL_MS = 30000;

export interface FencedSessionContext {
  /** Session-map key, e.g. 'wa:69:default' or 'tg:69:hh'. */
  key: string;
  clientId: string;
  slot: string;
}

export interface FencedSessionRegistryOptions<TEntry extends { token: number }> {
  coordinator: any;
  /** Log prefix, e.g. 'whatsapp' / 'telegram'. */
  channel: string;
  /**
   * Mutable holder for the outgoing consumer, read at fire time.
   * `{ tag, channel }` — the worker updates `tag` once the outgoing
   * consumer registers. May be omitted (no consumer to cancel).
   */
  consumer?: { tag: string | null; channel: any };
  /** Unref the renewal interval (Telegram does; WhatsApp does not). */
  unrefInterval?: boolean;
  /**
   * Provider teardown on lease loss. `entry` is resolved through the
   * accessor passed to `track()` at fire time and may be null (the
   * WhatsApp socket is null until `makeWASocket` returns).
   */
  onLeaseLoss: (
    entry: TEntry | null,
    ctx: FencedSessionContext,
  ) => Promise<void> | void;
}

export class FencedSessionRegistry<TEntry extends { token: number }> {
  private readonly opts: FencedSessionRegistryOptions<TEntry>;
  private readonly entries: Map<string, TEntry>;
  private readonly renewers = new Map<string, NodeJS.Timeout>();

  constructor(
    opts: FencedSessionRegistryOptions<TEntry>,
    entries?: Map<string, TEntry>,
  ) {
    this.opts = opts;
    // The worker may inject its own map (WhatsApp injects
    // `initialSockets` for tests); otherwise a fresh map is created.
    this.entries = entries ?? new Map();
  }

  /** The underlying map — the same instance the worker was built with. */
  get map(): Map<string, TEntry> {
    return this.entries;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): TEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: TEntry): void {
    this.entries.set(key, entry);
  }

  /** Drop only the map entry (interval untouched — see the class doc). */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Clear the renewal interval (if any) and drop the map entry.
   * Used by the Telegram disconnect consumer and by the WhatsApp
   * socket-close handler.
   */
  remove(key: string): void {
    const renewer = this.renewers.get(key);
    if (renewer) {
      clearInterval(renewer);
      this.renewers.delete(key);
    }
    this.entries.delete(key);
  }

  /**
   * Cached entry, only if its lease is still ours. A stale entry is
   * dropped (exactly as both `getXWithFencing` did) and null returned.
   */
  async getCached(key: string): Promise<TEntry | null> {
    const cached = this.entries.get(key);
    if (!cached) return null;
    const valid = await this.opts.coordinator.validateLease(
      leaseKey(key),
      cached.token,
    );
    if (valid) return cached;
    this.entries.delete(key);
    return null;
  }

  /** Acquire the fencing lease for a session key; null when held elsewhere. */
  async acquire(key: string): Promise<number | null> {
    const token = await this.opts.coordinator.acquireLease(
      leaseKey(key),
      LEASE_TTL_SECONDS,
    );
    return token || null;
  }

  /**
   * Start the 30 s lease-renewal interval for a session. Called right
   * after `acquire()` — before the provider object exists in the
   * WhatsApp flow, so the entry is read through `getEntry` at fire
   * time. The entry itself is stored by the caller via `set()` once the
   * provider object is created.
   */
  track(
    key: string,
    getEntry: () => TEntry | null,
    token: number,
    ctx: FencedSessionContext,
  ): void {
    const interval = setInterval(async () => {
      const ok = await this.opts.coordinator.renewLease(
        leaseKey(key),
        token,
        LEASE_TTL_SECONDS,
      );
      if (ok) return;

      clearInterval(interval);
      this.renewers.delete(key);
      this.entries.delete(key);

      try {
        await this.opts.onLeaseLoss(getEntry(), ctx);
      } catch (e) {
        console.error(
          `[${this.opts.channel}] error in lease-loss teardown for ${key}:`,
          e,
        );
      }

      // Stop the consumer immediately upon lease renewal failure to
      // prevent split-brain processing.
      const consumer = this.opts.consumer;
      if (consumer?.tag && consumer?.channel) {
        try {
          await consumer.channel.cancel(consumer.tag);
          console.warn(
            `[${this.opts.channel}] consumer cancelled for ${consumer.tag} due to lease loss`,
          );
        } catch (e) {
          console.error(
            `[${this.opts.channel}] error cancelling consumer on lease loss:`,
            e,
          );
        }
      }
    }, LEASE_RENEW_INTERVAL_MS);

    if (this.opts.unrefInterval) interval.unref?.();
    this.renewers.set(key, interval);
  }
}
