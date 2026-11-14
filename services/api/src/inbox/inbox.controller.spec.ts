import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboxController } from './inbox.controller.js';
import { NotFoundException } from '@nestjs/common';

describe('InboxController (M14 Pagination & RC8 Soft-Delete)', () => {
  let controller: InboxController;
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    };
    controller = new InboxController(mockPool);
  });

  it('getConversations: applies default limit 50, offset 0, and excludes deleted_at rows', async () => {
    mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ total: '3' }] };
      }
      return {
        rows: [
          { id: 1, customer_name: 'Customer 1', last_message_at: new Date() },
          { id: 2, customer_name: 'Customer 2', last_message_at: new Date() },
        ],
      };
    });

    const res = await controller.getConversations(10);
    expect(res.success).toBe(true);
    expect(res.tenantId).toBe(10);
    expect(res.conversations.length).toBe(2);
    expect(res.total).toBe(3);
    expect(res.limit).toBe(50);
    expect(res.offset).toBe(0);

    // Verify SQL excludes deleted_at
    const [countSql, countParams] = mockPool.query.mock.calls[0];
    expect(countSql).toContain('c.deleted_at IS NULL');
    expect(countParams).toEqual([10]);

    const [dataSql, dataParams] = mockPool.query.mock.calls[1];
    expect(dataSql).toContain('c.deleted_at IS NULL');
    expect(dataParams).toEqual([10, 50, 0]);
  });

  it('getConversations: respects custom limit and offset with max cap of 200', async () => {
    mockPool.query.mockImplementation(async () => ({ rows: [] }));

    const res = await controller.getConversations(10, 'all', '', '', '500', '25');
    expect(res.limit).toBe(200); // capped at 200
    expect(res.offset).toBe(25);

    const [, dataParams] = mockPool.query.mock.calls[1];
    expect(dataParams).toEqual([10, 200, 25]);
  });

  it('getMessages: supports limit, offset, and returns total count', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM conversations')) {
        return { rows: [{ id: 42 }] };
      }
      if (sql.includes('COUNT(*) as total FROM messages')) {
        return { rows: [{ total: '12' }] };
      }
      return {
        rows: [
          { id: 101, conversation_id: 42, text: 'Hello' },
          { id: 102, conversation_id: 42, text: 'World' },
        ],
      };
    });

    const res = await controller.getMessages(10, 42, '10', '5');
    expect(res.success).toBe(true);
    expect(res.total).toBe(12);
    expect(res.limit).toBe(10);
    expect(res.offset).toBe(5);
    expect(res.messages.length).toBe(2);
  });

  it('getMessages: throws 404 when conversation is soft-deleted or non-existent', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(controller.getMessages(10, 999)).rejects.toThrow(NotFoundException);
  });
});
