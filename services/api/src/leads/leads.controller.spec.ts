import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeadsController } from './leads.controller.js';

describe('LeadsController (M14 Pagination)', () => {
  let controller: LeadsController;
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    };
    controller = new LeadsController(mockPool);
  });

  it('getLeads: applies default limit 50 and offset 0 with total count', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ total: '15' }] };
      }
      return {
        rows: [
          { id: 1, name: 'Lead 1', phone: '01711111111' },
          { id: 2, name: 'Lead 2', phone: '01722222222' },
        ],
      };
    });

    const res = await controller.getLeads(10);
    expect(res.success).toBe(true);
    expect(res.total).toBe(15);
    expect(res.limit).toBe(50);
    expect(res.offset).toBe(0);
    expect(res.leads.length).toBe(2);

    const [, countParams] = mockPool.query.mock.calls[0];
    expect(countParams).toEqual([10]);

    const [, dataParams] = mockPool.query.mock.calls[1];
    expect(dataParams).toEqual([10, 50, 0]);
  });

  it('getLeads: respects custom limit and offset capped at 200', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ total: '100' }] };
      }
      return { rows: [] };
    });

    const res = await controller.getLeads(10, undefined, undefined, undefined, undefined, undefined, '500', '30');
    expect(res.limit).toBe(200); // capped at 200
    expect(res.offset).toBe(30);

    const [, dataParams] = mockPool.query.mock.calls[1];
    expect(dataParams).toEqual([10, 200, 30]);
  });
});
