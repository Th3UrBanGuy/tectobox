import { describe, it, expect } from 'vitest';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { CreateUserDto, ResetPasswordDto } from './admin.dto.js';
import { IssueLicenseDto, ActivateLicenseDto } from '../../licensing/dto/licensing.dto.js';
import { VerifyPaymentDto, RejectPaymentDto } from '../../payments/dto/payments.dto.js';

describe('ValidationPipe and DTOs (H9)', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  describe('CreateUserDto', () => {
    it('passes for a valid payload', async () => {
      const valid = {
        username: 'alice',
        password: 'securePassword123',
        role: 'operator',
        client_id: 10,
        trialMinutes: 60,
      };
      const result = await pipe.transform(valid, { type: 'body', metatype: CreateUserDto });
      expect(result.username).toBe('alice');
      expect(result.password).toBe('securePassword123');
      expect(result.client_id).toBe(10);
    });

    it('rejects unknown extra fields (forbidNonWhitelisted)', async () => {
      const payload = {
        username: 'alice',
        password: 'securePassword123',
        unknownProperty: 'malicious',
      };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: CreateUserDto })
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects invalid types (e.g. number for username)', async () => {
      const payload = {
        username: 12345,
        password: 'securePassword123',
      };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: CreateUserDto })
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects missing required fields', async () => {
      const payload = {
        username: 'alice',
      };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: CreateUserDto })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('ResetPasswordDto', () => {
    it('passes for a valid password', async () => {
      const valid = { password: 'newPassword123' };
      const res = await pipe.transform(valid, { type: 'body', metatype: ResetPasswordDto });
      expect(res.password).toBe('newPassword123');
    });

    it('rejects extra fields', async () => {
      const payload = { password: 'newPassword123', extraField: 'bad' };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: ResetPasswordDto })
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects missing password', async () => {
      await expect(
        pipe.transform({}, { type: 'body', metatype: ResetPasswordDto })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('IssueLicenseDto & ActivateLicenseDto', () => {
    it('IssueLicenseDto passes for valid payload', async () => {
      const valid = { client_id: 42, days: 30, deliver: 'apply', features: ['webchat'] };
      const res = await pipe.transform(valid, { type: 'body', metatype: IssueLicenseDto });
      expect(res.client_id).toBe(42);
      expect(res.days).toBe(30);
    });

    it('IssueLicenseDto rejects unknown extra fields', async () => {
      const payload = { client_id: 42, hackedField: true };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: IssueLicenseDto })
      ).rejects.toThrow(BadRequestException);
    });

    it('IssueLicenseDto rejects wrong type for client_id', async () => {
      const payload = { client_id: 'not-a-number' };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: IssueLicenseDto })
      ).rejects.toThrow(BadRequestException);
    });

    it('ActivateLicenseDto passes valid code', async () => {
      const valid = { code: 'LIC-123456' };
      const res = await pipe.transform(valid, { type: 'body', metatype: ActivateLicenseDto });
      expect(res.code).toBe('LIC-123456');
    });

    it('ActivateLicenseDto rejects unknown extra fields', async () => {
      const payload = { code: 'LIC-123456', forgedStatus: 'active' };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: ActivateLicenseDto })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('VerifyPaymentDto & RejectPaymentDto', () => {
    it('VerifyPaymentDto passes with valid optional note', async () => {
      const valid = { note: 'Verified via bank' };
      const res = await pipe.transform(valid, { type: 'body', metatype: VerifyPaymentDto });
      expect(res.note).toBe('Verified via bank');
    });

    it('VerifyPaymentDto rejects spoofed verified_by in body', async () => {
      const payload = { verified_by: 'attacker' };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: VerifyPaymentDto })
      ).rejects.toThrow(BadRequestException);
    });

    it('RejectPaymentDto passes with valid reason', async () => {
      const valid = { reason: 'Incorrect TrxID' };
      const res = await pipe.transform(valid, { type: 'body', metatype: RejectPaymentDto });
      expect(res.reason).toBe('Incorrect TrxID');
    });

    it('RejectPaymentDto rejects extra fields', async () => {
      const payload = { reason: 'Invalid', extraParam: 123 };
      await expect(
        pipe.transform(payload, { type: 'body', metatype: RejectPaymentDto })
      ).rejects.toThrow(BadRequestException);
    });
  });
});
