import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventsService } from './events.service.js';
import { AuthController } from '../auth/auth.controller.js';
import { hashPassword } from '../auth/password.util.js';
import { AdminController } from '../admin/admin.controller.js';
import { LicensingController } from '../licensing/licensing.controller.js';
import { BackupController } from '../backup/backup.controller.js';
import { UnauthorizedException } from '@nestjs/common';

describe('Audit Log Write Helper & Endpoints (M2)', () => {
  let mockPool: any;
  let eventsService: EventsService;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test_jwt_secret_12345';
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    eventsService = new EventsService(mockPool, undefined as any);
  });

  describe('EventsService.writeAudit', () => {
    it('inserts an audit record with correct columns', async () => {
      await eventsService.writeAudit('user_1', 42, 'custom:action', { ip: '127.0.0.1' });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO audit_log/),
        ['user_1', 'custom:action', 'tenant:42', '127.0.0.1']
      );
    });

    it('is fail-open and does not throw if pool.query fails', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('DB connection failed'));
      await expect(
        eventsService.writeAudit('user_1', 42, 'test:action', {})
      ).resolves.toBeUndefined();
    });
  });

  describe('Audit logging across all required endpoints', () => {
    it('writes audit row after login success and login failure', async () => {
      const authController = new AuthController(mockPool, eventsService);
      const rawPw = 'Secret123!';
      const hashed = await hashPassword(rawPw);

      // 1. Success
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            username: 'merchant_bob',
            role: 'client',
            client_id: 42,
            password_hash: hashed,
            active: true,
          },
        ],
      });

      await authController.login({ username: 'merchant_bob', password: rawPw });
      const auditCalls = mockPool.query.mock.calls.filter((c: any) =>
        c[0].includes('INSERT INTO audit_log')
      );
      expect(auditCalls.length).toBeGreaterThan(0);
      const successCall = auditCalls.find((c: any) => c[1][1] === 'login');
      expect(successCall).toBeDefined();
      expect(successCall[1][0]).toBe('10');
      expect(successCall[1][2]).toBe('tenant:42');

      // 2. Failure
      mockPool.query.mockClear();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            username: 'merchant_bob',
            role: 'client',
            client_id: 42,
            password_hash: hashed,
            active: true,
          },
        ],
      });

      await expect(
        authController.login({ username: 'merchant_bob', password: 'wrong' })
      ).rejects.toThrow(UnauthorizedException);

      const failAudit = mockPool.query.mock.calls.find(
        (c: any) => c[0].includes('INSERT INTO audit_log') && c[1][1] === 'login:failure'
      );
      expect(failAudit).toBeDefined();
    });

    it('writes audit row after user create', async () => {
      const mockLicensing = { issueTrialLicense: vi.fn() } as any;
      const adminController = new AdminController(mockPool, mockLicensing, eventsService);

      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // username uniqueness check
        .mockResolvedValueOnce({ rows: [{ id: 42, name: "New Client's Workspace" }] }) // client insert
        .mockResolvedValueOnce({
          rows: [
            {
              id: 99,
              username: 'new_operator',
              role: 'operator',
              client_id: 42,
              active: true,
            },
          ],
        }); // user insert

      await adminController.createUser(
        { username: 'new_operator', password: 'password123' },
        { user: { username: 'admin_user', role: 'admin' }, headers: { 'x-forwarded-for': '10.0.0.1' } }
      );

      const createCall = mockPool.query.mock.calls.find(
        (c: any) => c[0].includes('INSERT INTO audit_log') && c[1][1] === 'user:create'
      );
      expect(createCall).toBeDefined();
      expect(createCall[1][0]).toBe('admin_user');
      expect(createCall[1][2]).toBe('tenant:42');
    });

    it('writes audit row after password reset', async () => {
      const mockLicensing = {} as any;
      const adminController = new AdminController(mockPool, mockLicensing, eventsService);

      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE users SET password_hash

      await adminController.resetUserPassword(
        55,
        { password: 'brandNewPassword' },
        { user: { username: 'admin_user' }, headers: { 'x-forwarded-for': '10.0.0.2' } }
      );

      const resetCall = mockPool.query.mock.calls.find(
        (c: any) => c[0].includes('INSERT INTO audit_log') && c[1][1] === 'password:reset'
      );
      expect(resetCall).toBeDefined();
      expect(resetCall[1][0]).toBe('admin_user');
      expect(resetCall[1][2]).toBe('user:55');
    });

    it('writes audit row after license issue', async () => {
      const mockLicensing = { audit: vi.fn() } as any;
      const licensingController = new LicensingController(mockPool, mockLicensing, eventsService);

      const license = { id: 77, code: 'LIC-ABC123XYZ', client_id: 42, status: 'active' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // cancel existing
        .mockResolvedValueOnce({ rows: [license] }); // insert license

      await licensingController.issueLicense(
        { client_id: 42, days: 30 },
        { user: { username: 'admin_licensor' }, headers: { 'x-forwarded-for': '10.0.0.3' } }
      );

      const licenseCall = mockPool.query.mock.calls.find(
        (c: any) => c[0].includes('INSERT INTO audit_log') && c[1][1] === 'license:issue'
      );
      expect(licenseCall).toBeDefined();
      expect(licenseCall[1][0]).toBe('admin_licensor');
      expect(licenseCall[1][2]).toBe('tenant:42');
    });

    it('writes audit row after backup export', async () => {
      const mockBackupService = {
        exportClientData: vi.fn().mockResolvedValue({
          client: { id: 42, name: 'Client 42' },
          products: [],
          conversations: [],
        }),
      } as any;
      const backupController = new BackupController(mockBackupService, mockPool, eventsService);

      const res = {
        setHeader: vi.fn(),
        send: vi.fn(),
      } as any;

      await backupController.exportJson(
        42,
        undefined,
        res,
        { user: { username: 'backup_admin', role: 'admin' }, headers: { 'x-forwarded-for': '10.0.0.4' } }
      );

      const backupCall = mockPool.query.mock.calls.find(
        (c: any) => c[0].includes('INSERT INTO audit_log') && c[1][1] === 'backup:export'
      );
      expect(backupCall).toBeDefined();
      expect(backupCall[1][0]).toBe('backup_admin');
      expect(backupCall[1][2]).toBe('tenant:42');
    });

    it('writes audit row after workspace delete', async () => {
      const mockLicensing = {} as any;
      const adminController = new AdminController(mockPool, mockLicensing, eventsService);

      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // DELETE users
        .mockResolvedValueOnce({ rows: [] }); // DELETE clients

      await adminController.deleteWorkspace(
        88,
        { user: { username: 'root_admin' }, headers: { 'x-forwarded-for': '10.0.0.5' } }
      );

      const deleteCall = mockPool.query.mock.calls.find(
        (c: any) => c[0].includes('INSERT INTO audit_log') && c[1][1] === 'workspace:delete'
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall[1][0]).toBe('root_admin');
      expect(deleteCall[1][2]).toBe('tenant:88');
    });
  });
});
