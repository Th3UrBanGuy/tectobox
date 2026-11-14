import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConversationsController, purgeExpiredConversations } from './conversations.controller.js';

describe('ConversationsController.deleteConversation — RC8 15-day soft-delete', () => {
  interface ConvRow {
    id: number;
    client_id: number;
    deleted_at?: Date | string | null;
    purge_at?: Date | string | null;
  }

  function createFakePool(conversations: ConvRow[]) {
    const executedQueries: { sql: string; params?: any[] }[] = [];
    let inTransaction = false;
    let committed = false;
    let rolledBack = false;

    const queryFn = async (sql: string, params?: any[]) => {
      executedQueries.push({ sql, params });
      if (sql.includes('SELECT id, client_id, deleted_at FROM conversations')) {
        const id = params?.[0];
        const clientId = params?.[1];
        const found = conversations.find((c) => c.id === id && c.client_id === clientId);
        return { rows: found ? [found] : [] };
      }
      if (sql.includes('UPDATE conversations') && sql.includes('SET deleted_at = NOW()')) {
        const id = params?.[0];
        const clientId = params?.[1];
        const conv = conversations.find((c) => c.id === id && c.client_id === clientId && !c.deleted_at);
        if (conv) {
          const now = new Date();
          const purgeAt = new Date(now.getTime() + 15 * 86400 * 1000);
          conv.deleted_at = now;
          conv.purge_at = purgeAt;
          return { rows: [{ id: conv.id, deleted_at: conv.deleted_at, purge_at: conv.purge_at }] };
        }
        return { rows: [] };
      }
      if (sql.includes('UPDATE conversations') && sql.includes('SET deleted_at = NULL')) {
        const id = params?.[0];
        const clientId = params?.[1];
        const conv = conversations.find((c) => c.id === id && c.client_id === clientId);
        if (conv) {
          conv.deleted_at = null;
          conv.purge_at = null;
          return { rows: [{ id: conv.id, deleted_at: null, purge_at: null }] };
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT id FROM conversations WHERE purge_at IS NOT NULL')) {
        const now = new Date();
        const expired = conversations.filter(
          (c) => c.purge_at && new Date(c.purge_at).getTime() <= now.getTime()
        );
        return { rows: expired.map((c) => ({ id: c.id })) };
      }
      if (sql.includes('DELETE FROM conversations WHERE id = ANY')) {
        const ids = params?.[0] || [];
        for (const id of ids) {
          const idx = conversations.findIndex((c) => c.id === id);
          if (idx !== -1) conversations.splice(idx, 1);
        }
        return { rows: [] };
      }
      if (sql === 'BEGIN') inTransaction = true;
      if (sql === 'COMMIT') committed = true;
      if (sql === 'ROLLBACK') rolledBack = true;
      return { rows: [] };
    };

    const client = {
      query: vi.fn(queryFn),
      release: vi.fn(),
    };

    return {
      executedQueries,
      getInTransaction: () => inTransaction,
      getCommitted: () => committed,
      getRolledBack: () => rolledBack,
      client,
      query: vi.fn(queryFn),
      connect: vi.fn(async () => client),
    } as any;
  }

  it('own-tenant: soft deletes conversation setting deleted_at and purge_at (+15d), row remains in DB', async () => {
    const initialRows: ConvRow[] = [{ id: 10, client_id: 69, deleted_at: null, purge_at: null }];
    const pool = createFakePool(initialRows);
    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 1, role: 'client', clientId: 69 } };

    const res = await ctrl.deleteConversation(69, 69, 10, req);
    expect(res.ok).toBe(true);
    expect(res.conversationId).toBe(10);
    expect(res.deleted_at).toBeDefined();
    expect(res.purge_at).toBeDefined();

    // Verify row still exists in DB but with deleted_at and purge_at set
    expect(initialRows[0].id).toBe(10);
    expect(initialRows[0].deleted_at).not.toBeNull();
    expect(initialRows[0].purge_at).not.toBeNull();

    // Verify SQL query uses UPDATE with 15 days interval, not DELETE
    const updateQuery = pool.executedQueries.find((q: any) =>
      q.sql.includes('UPDATE conversations') && q.sql.includes("INTERVAL '15 days'")
    );
    expect(updateQuery).toBeDefined();
  });

  it('other-tenant: rejects deletion with 404 and leaves rows untouched', async () => {
    const initialRows: ConvRow[] = [{ id: 10, client_id: 77, deleted_at: null, purge_at: null }];
    const pool = createFakePool(initialRows);
    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 1, role: 'client', clientId: 69 } };

    await expect(ctrl.deleteConversation(69, 77, 10, req)).rejects.toThrow(NotFoundException);
    expect(initialRows[0].deleted_at).toBeNull();
  });

  it('already deleted conversation returns 404', async () => {
    const initialRows: ConvRow[] = [{ id: 10, client_id: 69, deleted_at: new Date(), purge_at: new Date() }];
    const pool = createFakePool(initialRows);
    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 1, role: 'client', clientId: 69 } };

    await expect(ctrl.deleteConversation(69, 69, 10, req)).rejects.toThrow(NotFoundException);
  });

  it('restore: successfully un-deletes conversation within recovery window', async () => {
    const past = new Date(Date.now() - 3600000);
    const futurePurge = new Date(Date.now() + 14 * 86400 * 1000);
    const initialRows: ConvRow[] = [{ id: 10, client_id: 69, deleted_at: past, purge_at: futurePurge }];
    const pool = createFakePool(initialRows);
    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 1, role: 'client', clientId: 69 } };

    const res = await ctrl.restoreConversation(69, 69, 10, req);
    expect(res.ok).toBe(true);
    expect(res.restored).toBe(true);
    expect(res.conversationId).toBe(10);
    expect(initialRows[0].deleted_at).toBeNull();
    expect(initialRows[0].purge_at).toBeNull();
  });

  it('purge: removes only expired rows past purge_at and retains active/non-expired rows', async () => {
    const now = Date.now();
    const expiredConv: ConvRow = {
      id: 1,
      client_id: 69,
      deleted_at: new Date(now - 16 * 86400 * 1000),
      purge_at: new Date(now - 1000), // Expired
    };
    const activeConv: ConvRow = {
      id: 2,
      client_id: 69,
      deleted_at: null,
      purge_at: null, // Active
    };
    const pendingConv: ConvRow = {
      id: 3,
      client_id: 69,
      deleted_at: new Date(now - 5 * 86400 * 1000),
      purge_at: new Date(now + 10 * 86400 * 1000), // 10 days remaining
    };

    const convList: ConvRow[] = [expiredConv, activeConv, pendingConv];
    const pool = createFakePool(convList);

    const purgedCount = await purgeExpiredConversations(pool);
    expect(purgedCount).toBe(1);

    // Expired row removed
    expect(convList.find((c) => c.id === 1)).toBeUndefined();
    // Active and pending rows preserved
    expect(convList.find((c) => c.id === 2)).toBeDefined();
    expect(convList.find((c) => c.id === 3)).toBeDefined();
  });
});
