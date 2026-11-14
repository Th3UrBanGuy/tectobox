import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrdersController } from './orders.controller.js';

describe('OrdersController (M14 Pagination)', () => {
  let controller: OrdersController;
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    };
    controller = new OrdersController(mockPool);
  });

  it('getOrders: returns orders with default limit 50, offset 0, and total count', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ total: '24' }] };
      }
      return {
        rows: [
          { id: 1, total_bdt: 500, status: 'confirmed' },
          { id: 2, total_bdt: 1200, status: 'shipped' },
        ],
      };
    });

    const res = await controller.getOrders(10);
    expect(res.success).toBe(true);
    expect(res.total).toBe(24);
    expect(res.limit).toBe(50);
    expect(res.offset).toBe(0);
    expect(res.orders.length).toBe(2);

    const [, dataParams] = mockPool.query.mock.calls[1];
    expect(dataParams).toEqual([10, 50, 0]);
  });

  it('getOrders: caps limit at 200 and passes custom offset', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '500' }] };
      return { rows: [] };
    });

    const res = await controller.getOrders(10, undefined, '999', '40');
    expect(res.limit).toBe(200);
    expect(res.offset).toBe(40);

    const [, dataParams] = mockPool.query.mock.calls[1];
    expect(dataParams).toEqual([10, 200, 40]);
  });

  it('getOrdersByConversation: paginates orders for conversation with total', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '3' }] };
      return { rows: [{ id: 1, conversation_id: 100 }] };
    });

    const res = await controller.getOrdersByConversation(10, 100, '20', '0');
    expect(res.total).toBe(3);
    expect(res.limit).toBe(20);
    expect(res.offset).toBe(0);
  });
});
