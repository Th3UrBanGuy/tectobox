import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt, isEncrypted } from './crypto.js';

describe('AES-256-GCM crypto helper', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-secret-key-32-bytes-long!!';
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it('encrypts and decrypts a secret roundtrip', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const encrypted = encrypt(secret);

    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain(secret);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('produces different ciphertexts for the same plaintext due to random IV', () => {
    const secret = 'MY_SUPER_SECRET_KEY';
    const enc1 = encrypt(secret);
    const enc2 = encrypt(secret);

    expect(enc1).not.toBe(enc2);
    expect(decrypt(enc1)).toBe(secret);
    expect(decrypt(enc2)).toBe(secret);
  });

  it('detects unencrypted plaintext strings', () => {
    expect(isEncrypted('JBSWY3DPEHPK3PXP')).toBe(false);
    expect(isEncrypted('some_random_key')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it('throws when decrypting unencrypted or tampered ciphertext', () => {
    expect(() => decrypt('not_encrypted')).toThrow(/missing or corrupted version prefix/);

    const enc = encrypt('secret');
    const parts = enc.split(':');
    // Tamper with data byte
    parts[3] = parts[3].slice(0, -2) + (parts[3].slice(-2) === 'aa' ? 'bb' : 'aa');
    const tampered = parts.join(':');

    expect(() => decrypt(tampered)).toThrow();
  });

  it('fails closed when ENCRYPTION_KEY is missing', () => {
    delete process.env.ENCRYPTION_KEY;

    expect(() => encrypt('test')).toThrow(/ENCRYPTION_KEY environment variable is not configured/);
    expect(() => decrypt('v1:012345678901234567890123:01234567890123456789012345678901:abcd')).toThrow(
      /ENCRYPTION_KEY environment variable is not configured/
    );
  });
});
