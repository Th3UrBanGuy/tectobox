import crypto from 'node:crypto';

// Fail closed: throw at boot if ENCRYPTION_KEY is missing in production.
// Never fall back to a hardcoded key.
if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY environment variable is required in production');
}

const VERSION_PREFIX = 'v1:';

function getEncryptionKey(): Buffer {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not configured');
  }

  // If a 64-character hex string (32 bytes) is provided
  if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  // If already exactly 32 bytes in UTF-8
  const buf = Buffer.from(rawKey, 'utf8');
  if (buf.length === 32) {
    return buf;
  }

  // Derive a uniform 256-bit key from arbitrary passphrase
  return crypto.createHash('sha256').update(buf).digest();
}

/**
 * Checks whether a given string has a valid encryption version prefix.
 */
export function isEncrypted(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!value.startsWith(VERSION_PREFIX)) return false;
  const parts = value.split(':');
  // Expected format: v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
  return parts.length === 4 && parts[1].length === 24 && parts[2].length === 32;
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Output format: `v1:<iv_hex>:<tag_hex>:<ciphertext_hex>`
 */
export function encrypt(plaintext: string): string {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return '';
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 128-bit authentication tag

  return `${VERSION_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM ciphertext created by `encrypt()`.
 * Throws if the format is invalid or authentication tag check fails.
 */
export function decrypt(ciphertext: string): string {
  if (ciphertext === null || ciphertext === undefined || ciphertext === '') {
    return '';
  }

  if (!isEncrypted(ciphertext)) {
    throw new Error('Invalid ciphertext format: missing or corrupted version prefix');
  }

  const key = getEncryptionKey();
  const [, ivHex, tagHex, dataHex] = ciphertext.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
