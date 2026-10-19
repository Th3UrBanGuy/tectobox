import crypto from 'node:crypto';
import util from 'node:util';

const scryptAsync = util.promisify(crypto.scrypt);

/**
 * Standard scrypt password hashing matching Tectobox format `salt:hash`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(String(password), salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Timing-safe scrypt verification.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const [salt, expectedHash] = storedHash.split(':');
  if (!salt || !expectedHash) return false;

  try {
    const derivedKey = (await scryptAsync(String(password), salt, 64)) as Buffer;
    const a = Buffer.from(derivedKey.toString('hex'), 'hex');
    const b = Buffer.from(expectedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
