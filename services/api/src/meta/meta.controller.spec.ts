import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetaOAuthStateManager, META_OAUTH_TTL_MS } from './meta.controller.js';

describe('Meta OAuth state management (M8)', () => {
  let manager: MetaOAuthStateManager;

  beforeEach(() => {
    manager = new MetaOAuthStateManager();
  });

  it('stores and retrieves state within 10-minute TTL', () => {
    manager.setState('state-123', 42);
    const entry = manager.getState('state-123');
    expect(entry).toBeDefined();
    expect(entry?.clientId).toBe(42);
  });

  it('rejects state older than 10 minutes and deletes expired state', () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    manager.setState('stale-state', 99, elevenMinutesAgo);

    expect(manager.getState('stale-state')).toBeNull();
    expect(manager.consumeState('stale-state')).toBeNull();
    expect(manager.size).toBe(0);
  });

  it('accepts state that is 9 minutes old (< 10 minutes)', () => {
    const nineMinutesAgo = Date.now() - 9 * 60 * 1000;
    manager.setState('fresh-state', 55, nineMinutesAgo);

    const consumed = manager.consumeState('fresh-state');
    expect(consumed).toEqual({ clientId: 55 });
    // One-time use: should be deleted once consumed
    expect(manager.getState('fresh-state')).toBeNull();
  });

  it('prunes multiple expired states automatically', () => {
    const now = Date.now();
    manager.setState('s1', 1, now - 15 * 60 * 1000);
    manager.setState('s2', 2, now - 12 * 60 * 1000);
    manager.setState('s3', 3, now - 2 * 60 * 1000);

    expect(manager.size).toBe(1);
    expect(manager.getState('s3')).not.toBeNull();
    expect(manager.getState('s1')).toBeNull();
    expect(manager.getState('s2')).toBeNull();
  });
});
