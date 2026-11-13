import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConversationsController } from './conversations.controller.js';

describe('ConversationsController.deleteConversation — RC6', () => {
  function createFakePool(conversations: { id: number; client_id: number }[]) {
    const executedQueries: { sql: string; params?: any[] }[] = [];
    let inTransaction = false;
    let committed = false;
    let rolledBack = false;

    const queryFn = async (sql: string, params?: any[]) => {
      executedQueries.push({ sql, params });
      if (sql.includes('SELECT id, client_id FROM conversations')) {
        const id = params?.[0];
        const clientId = params?.[1];
        const found = conversations.find((c) => c.id === id && c.client_id === clientId);
        return { rows: found ? [found] : [] };
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

  it('own-tenant: deletes conversation and messages with cascade in transaction (200 OK)', async () => {
    const pool = createFakePool([{ id: 10, client_id: 69 }]);
    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 1, role: 'client', clientId: 69 } };

    const res = await ctrl.deleteConversation(69, 69, 10, req);
    expect(res).toEqual({ ok: true, success: true, conversationId: 10 });

    // Verify transaction lifecycle
    expect(pool.client.query).toHaveBeenCalledWith('BEGIN');
    expect(pool.client.query).toHaveBeenCalledWith('COMMIT');
    expect(pool.client.release).toHaveBeenCalled();

    // Verify cascade operations: messages, orders, payments, conversations
    const queries = pool.executedQueries.map((q: any) => q.sql);
    expect(queries.some((q: string) => q.includes('DELETE FROM messages WHERE conversation_id = $1'))).toBe(true);
    expect(queries.some((q: string) => q.includes('UPDATE orders SET conversation_id = NULL'))).toBe(true);
    expect(queries.some((q: string) => q.includes('UPDATE payments SET conversation_id = NULL'))).toBe(true);
    expect(queries.some((q: string) => q.includes('DELETE FROM conversations WHERE id = $1 AND client_id = $2'))).toBe(true);
  });

  it('other-tenant: rejects deletion with 404 and leaves rows intact', async () => {
    // Conversation 10 belongs to client 77, caller is client 69
    const pool = createFakePool([{ id: 10, client_id: 77 }]);
    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 1, role: 'client', clientId: 69 } };

    await expect(ctrl.deleteConversation(69, 77, 10, req)).rejects.toThrow(NotFoundException);

    // Verify no deletion queries or transaction ran
    const queries = pool.executedQueries.map((q: any) => q.sql);
    expect(queries.some((q: string) => q.includes('DELETE FROM messages'))).toBe(false);
    expect(queries.some((q: string) => q.includes('DELETE FROM conversations'))).toBe(false);
    expect(pool.client.query).not.toHaveBeenCalledWith('BEGIN');
  });

  it('admin: can delete conversation belonging to any client', async () => {
    const pool = createFakePool([{ id: 99, client_id: 42 }]);
    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 999, role: 'admin', clientId: null } };

    const res = await ctrl.deleteConversation(0, 42, 99, req);
    expect(res).toEqual({ ok: true, success: true, conversationId: 99 });

    expect(pool.client.query).toHaveBeenCalledWith('BEGIN');
    expect(pool.client.query).toHaveBeenCalledWith('COMMIT');
    const deleteConvQuery = pool.executedQueries.find((q: any) => q.sql.includes('DELETE FROM conversations'));
    expect(deleteConvQuery?.params).toEqual([99, 42]);
  });

  it('non-existent conversation returns 404', async () => {
    const pool = createFakePool([]);
    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 1, role: 'client', clientId: 69 } };

    await expect(ctrl.deleteConversation(69, 69, 999, req)).rejects.toThrow(NotFoundException);
    expect(pool.client.query).not.toHaveBeenCalledWith('BEGIN');
  });

  it('rolls back transaction on query error', async () => {
    const pool = createFakePool([{ id: 10, client_id: 69 }]);
    pool.client.query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN') return { rows: [] };
      if (sql.includes('DELETE FROM messages')) throw new Error('Database disk error');
      if (sql === 'ROLLBACK') return { rows: [] };
      return { rows: [] };
    });

    const ctrl = new ConversationsController(pool);
    const req = { user: { id: 1, role: 'client', clientId: 69 } };

    await expect(ctrl.deleteConversation(69, 69, 10, req)).rejects.toThrow('Database disk error');
    expect(pool.client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(pool.client.release).toHaveBeenCalled();
  });
});
