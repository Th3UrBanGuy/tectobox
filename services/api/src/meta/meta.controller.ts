/**
 * Meta OAuth state management (M8).
 * Enforces a strict 10-minute TTL on OAuth session states and purges expired entries.
 */
export const META_OAUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface MetaOAuthState {
  clientId: number;
  createdAt: number;
}

export class MetaOAuthStateManager {
  private readonly states = new Map<string, MetaOAuthState>();

  /**
   * Registers a new OAuth state with the current timestamp.
   */
  setState(state: string, clientId: number, createdAt: number = Date.now()): void {
    this.pruneExpired();
    this.states.set(state, { clientId, createdAt });
  }

  /**
   * Retrieves an active OAuth state. Returns null if expired or missing.
   */
  getState(state: string): MetaOAuthState | null {
    this.pruneExpired();
    const entry = this.states.get(state);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > META_OAUTH_TTL_MS) {
      this.states.delete(state);
      return null;
    }
    return entry;
  }

  /**
   * Validates and consumes an OAuth state (one-time use).
   * Returns null if missing or expired (> 10 minutes).
   */
  consumeState(state: string): { clientId: number } | null {
    const entry = this.getState(state);
    if (!entry) return null;
    this.states.delete(state);
    return { clientId: entry.clientId };
  }

  /**
   * Purges all states older than 10 minutes.
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, val] of this.states.entries()) {
      if (now - val.createdAt > META_OAUTH_TTL_MS) {
        this.states.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Size of active states map.
   */
  get size(): number {
    this.pruneExpired();
    return this.states.size;
  }

  clear(): void {
    this.states.clear();
  }
}

export const metaOAuthState = new MetaOAuthStateManager();
