import { tgCodeSentKey, tgQrKey, waPairingKey, waQrKey } from '@tectonic/contracts';
import type { BrokerState } from './broker-state.js';

/**
 * Redis channel cache: QR codes, pairing codes, and phone-code flags
 * for WhatsApp / Telegram sessions, plus the generic key helpers.
 *
 * Moved verbatim out of `EventsService` (`getQrCode`, `getPairingCode`,
 * `getPhoneCodeSent`, `setRedisKey`, `getRedisKey`) — Phase 3 of the
 * modular restructure. Key formats come from `@tectonic/contracts`
 * (Phase 1); this file is the single place that reads/writes them from
 * the API side. No behaviour change.
 */
export class ChannelCacheService {
  constructor(private readonly state: BrokerState) {}

  async getQrCode(clientId: number, slot: string, channel: string = 'whatsapp'): Promise<string | null> {
    if (this.state.redis) {
      try {
        const key = channel === 'telegram' ? tgQrKey(clientId, slot) : waQrKey(clientId, slot);
        return await this.state.redis.get(key);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** WhatsApp pairing code issued by requestPairingCode (phone login). */
  async getPairingCode(clientId: number, slot: string): Promise<string | null> {
    if (this.state.redis) {
      try {
        return await this.state.redis.get(waPairingKey(clientId, slot));
      } catch {
        return null;
      }
    }
    return null;
  }

  /** True while a Telegram phone-code login is waiting for the user to type the code. */
  async getPhoneCodeSent(clientId: number, slot: string): Promise<boolean> {
    if (this.state.redis) {
      try {
        return (await this.state.redis.get(tgCodeSentKey(clientId, slot))) === '1';
      } catch {
        return false;
      }
    }
    return false;
  }

  async setRedisKey(key: string, val: string, ttlSec?: number): Promise<void> {
    if (this.state.redis) {
      try {
        if (ttlSec) {
          await this.state.redis.set(key, val, 'EX', ttlSec);
        } else {
          await this.state.redis.set(key, val);
        }
      } catch (err: any) {
        console.warn(`[events] Redis set error for ${key}:`, err.message);
      }
    }
  }

  async getRedisKey(key: string): Promise<string | null> {
    if (this.state.redis) {
      try {
        return await this.state.redis.get(key);
      } catch {
        return null;
      }
    }
    return null;
  }
}
