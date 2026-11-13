import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackupController } from './backup.controller.js';

// C3: backup export/import must never serve another workspace to a
// non-admin. A non-admin's URL :id is ignored (their own tenant is used);
// an admin may address another workspace explicitly.

function mockRes() {
  return {
    setHeader: vi.fn(),
    send: vi.fn().mockReturnValue('sent'),
  } as any;
}

function bundleFor(clientId: number) {
  return {
    client: { id: clientId, name: `Workspace ${clientId}` },
    products: [],
    conversations: [],
  };
}

describe('BackupController tenant scoping (C3)', () => {
  let controller: BackupController;
  let mockService: any;

  beforeEach(() => {
    mockService = {
      exportClientData: vi.fn(async (id: number) => bundleFor(id)),
      bundleToMarkdown: vi.fn(() => '# backup'),
      importClientData: vi.fn(async () => ({ products: 1 })),
    };
    controller = new BackupController(mockService);
  });

  it('non-admin export with another workspace :id gets their OWN data', async () => {
    const res = mockRes();
    await controller.exportJson(42, '999', res, { user: { role: 'client', clientId: 42 } });

    expect(mockService.exportClientData).toHaveBeenCalledWith(42);
    expect(mockService.exportClientData).not.toHaveBeenCalledWith(999);
    expect(res.send).toHaveBeenCalled();
  });

  it('non-admin export-md with another workspace :id gets their OWN data', async () => {
    const res = mockRes();
    await controller.exportMd(42, '999', res, { user: { role: 'client', clientId: 42 } });

    expect(mockService.exportClientData).toHaveBeenCalledWith(42);
    expect(mockService.bundleToMarkdown).toHaveBeenCalled();
  });

  it('non-admin import with another workspace :id writes to their OWN workspace', async () => {
    const result = await controller.importJson(42, '999', { version: 1 }, { user: { role: 'client', clientId: 42 } });

    expect(mockService.importClientData).toHaveBeenCalledWith(42, { version: 1 });
    expect(result.ok).toBe(true);
  });

  it('admin export with another workspace :id gets that workspace', async () => {
    const res = mockRes();
    await controller.exportJson(1, '999', res, { user: { role: 'admin', clientId: null } });

    expect(mockService.exportClientData).toHaveBeenCalledWith(999);
  });

  it('admin import with another workspace :id writes to that workspace', async () => {
    await controller.importJson(1, '999', { version: 1 }, { user: { role: 'superadmin', clientId: null } });

    expect(mockService.importClientData).toHaveBeenCalledWith(999, { version: 1 });
  });

  it('export without :id uses the caller tenant', async () => {
    const res = mockRes();
    await controller.exportJson(42, undefined, res, { user: { role: 'client', clientId: 42 } });

    expect(mockService.exportClientData).toHaveBeenCalledWith(42);
  });

  it('Drive upload returns honest 501 NotImplementedException instead of fake file list', () => {
    expect(() => controller.uploadDrive()).toThrowError(/not implemented/i);
  });
});
