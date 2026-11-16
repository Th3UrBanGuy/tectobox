import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentsController } from './payments.controller.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

describe('PaymentsController (M5)', () => {
  let controller: PaymentsController;
  let mockPool: any;
  let mockEventsService: any;
  const adminGuard = new AdminGuard();

  beforeEach(() => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    mockEventsService = {
      broadcastTenantEvent: vi.fn().mockResolvedValue(undefined),
    };
    controller = new PaymentsController(mockPool, mockEventsService);
  });

  describe('AdminGuard authorization on payment actions', () => {
    it('non-admin caller gets 403 Forbidden on payment verify/reject', () => {
      const clientCtx = {
        switchToHttp: () => ({
          getRequest: () => ({ user: { role: 'client', clientId: 42, username: 'merchant' } }),
        }),
      } as any;

      expect(() => adminGuard.canActivate(clientCtx)).toThrow(ForbiddenException);
    });

    it('unauthenticated caller gets 403 Forbidden', () => {
      const anonCtx = {
        switchToHttp: () => ({
          getRequest: () => ({ user: undefined }),
        }),
      } as any;

      expect(() => adminGuard.canActivate(anonCtx)).toThrow(ForbiddenException);
    });

    it('admin caller passes AdminGuard', () => {
      const adminCtx = {
        switchToHttp: () => ({
          getRequest: () => ({ user: { role: 'admin', username: 'superadmin' } }),
        }),
      } as any;

      expect(adminGuard.canActivate(adminCtx)).toBe(true);
    });
  });

  describe('verifyPayment session user & tenant scoping', () => {
    it('sets verified_by from session user (ignoring body) and scopes UPDATE by client_id', async () => {
      const paymentRow = {
        id: 101,
        client_id: 55,
        transaction_id: 'TRX999',
        amount: 1500,
      };

      // Mock lookup query and update query
      mockPool.query
        .mockResolvedValueOnce({ rows: [paymentRow] }) // SELECT check
        .mockResolvedValueOnce({ rows: [{ ...paymentRow, status: 'verified', verified_by: 'admin_officer' }] }) // UPDATE payments
        .mockResolvedValueOnce({ rows: [{ pending_count: 0 }] }); // getStatsInternal

      const req = {
        user: { role: 'admin', username: 'admin_officer' },
      };

      const body = {
        verified_by: 'malicious_spoofed_user',
        note: 'Approved',
      } as any;

      const res = await controller.verifyPayment(55, 101, body, req);
      expect(res.ok).toBe(true);
      expect(res.payment.status).toBe('verified');

      // Check UPDATE query
      const updateCall = mockPool.query.mock.calls.find((c: any) =>
        c[0].includes('UPDATE payments') && c[0].includes("status = 'verified'")
      );

      expect(updateCall).toBeDefined();
      expect(updateCall[0]).toContain('WHERE id = $2 AND client_id = $3');
      // $1: verified_by, $2: paymentId, $3: client_id
      expect(updateCall[1][0]).toBe('admin_officer'); // From session, NEVER from body!
      expect(updateCall[1][0]).not.toBe('malicious_spoofed_user');
      expect(updateCall[1][1]).toBe(101);
      expect(updateCall[1][2]).toBe(55); // Scoped by row client_id
    });

    it('throws NotFoundException if payment row does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        controller.verifyPayment(55, 999, {}, { user: { username: 'admin' } })
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('rejectPayment tenant scoping', () => {
    it('scopes UPDATE by client_id and applies reason', async () => {
      const paymentRow = {
        id: 102,
        client_id: 77,
        transaction_id: 'TRX888',
        amount: 2000,
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [paymentRow] }) // SELECT check
        .mockResolvedValueOnce({ rows: [{ ...paymentRow, status: 'rejected', rejection_reason: 'Invalid TrxID' }] }) // UPDATE payments
        .mockResolvedValueOnce({ rows: [{ pending_count: 0 }] }); // getStatsInternal

      const res = await controller.rejectPayment(77, 102, { reason: 'Invalid TrxID' }, { user: { username: 'admin' } });
      expect(res.ok).toBe(true);

      const updateCall = mockPool.query.mock.calls.find((c: any) =>
        c[0].includes('UPDATE payments') && c[0].includes("status = 'rejected'")
      );

      expect(updateCall).toBeDefined();
      expect(updateCall[0]).toContain('WHERE id = $2 AND client_id = $3');
      expect(updateCall[1][0]).toBe('Invalid TrxID');
      expect(updateCall[1][1]).toBe(102);
      expect(updateCall[1][2]).toBe(77); // Scoped by row client_id
    });
  });
});

describe('PaymentsController payment-config (2026-11-16 Fix 5)', () => {
  let controller: PaymentsController;
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    controller = new PaymentsController(mockPool, { broadcastTenantEvent: vi.fn() } as any);
  });

  it('GET returns the parsed config from the clients row', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ payment_modes: 'both', advance_required_bdt: 100, bkash_number: '01700000000', nagad_number: null, rocket_number: null }],
    });
    const res = await controller.getPaymentConfig(69);
    expect(res.ok).toBe(true);
    expect(res.config).toEqual({ modes: 'both', advanceBdt: 100, bkash: '01700000000', nagad: null, rocket: null });
  });

  it('POST validates modes + advance and cleans numbers before saving', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ payment_modes: 'cod', advance_required_bdt: 0, bkash_number: null, nagad_number: null, rocket_number: null }] })
      .mockResolvedValueOnce({ rows: [{ payment_modes: 'both', advance_required_bdt: 100, bkash_number: '01700000000', nagad_number: null, rocket_number: null }] });
    const res = await controller.savePaymentConfig(69, {
      payment_modes: 'both',
      advance_required_bdt: 100,
      bkash_number: '0170-000-0000',
    });
    expect(res.ok).toBe(true);
    expect(res.config.bkash).toBe('01700000000');
    const updateCall = mockPool.query.mock.calls[1];
    expect(updateCall[1]).toEqual(['both', 100, '01700000000', null, null, 69]);
  });

  it('POST rejects an invalid mode and an out-of-range advance', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ payment_modes: 'cod', advance_required_bdt: 0, bkash_number: null, nagad_number: null, rocket_number: null }] });
    await expect(controller.savePaymentConfig(69, { payment_modes: 'card' })).rejects.toThrow();
    await expect(controller.savePaymentConfig(69, { advance_required_bdt: 100001 })).rejects.toThrow();
    await expect(controller.savePaymentConfig(69, { bkash_number: '123' })).rejects.toThrow();
  });
});
