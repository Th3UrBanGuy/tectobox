import pg from 'pg';
import { encrypt, decrypt, isEncrypted } from '../common/crypto.js';

export function maskSecret(val: string | null | undefined): string {
  if (!val) return '';
  const s = String(val).trim();
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

export interface CourierConfig {
  provider: string;
  steadfast_api_key: string;
  steadfast_secret_key: string;
  pathao_client_id: string;
  pathao_client_secret: string;
  auto_send_tracking_sms: boolean;
  default_delivery_charge_inside: number;
  default_delivery_charge_outside: number;
}

export class CourierService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Loads courier config with plaintext secrets decrypted.
   * Performs migrate-on-read for any legacy unencrypted secrets found at rest.
   */
  async getDecryptedConfig(tenantId: number): Promise<CourierConfig> {
    const res = await this.pool.query('SELECT courier_config_json FROM clients WHERE id = $1', [tenantId]);
    if (!res.rows.length) {
      return this.defaultConfig();
    }

    let raw: any = {};
    try {
      raw = JSON.parse(res.rows[0].courier_config_json || '{}');
    } catch {
      return this.defaultConfig();
    }

    let migrated = false;

    let steadfastApiKey = String(raw.steadfast_api_key || '').trim();
    if (steadfastApiKey) {
      if (isEncrypted(steadfastApiKey)) {
        steadfastApiKey = decrypt(steadfastApiKey);
      } else {
        migrated = true;
      }
    }

    let steadfastSecretKey = String(raw.steadfast_secret_key || '').trim();
    if (steadfastSecretKey) {
      if (isEncrypted(steadfastSecretKey)) {
        steadfastSecretKey = decrypt(steadfastSecretKey);
      } else {
        migrated = true;
      }
    }

    let pathaoClientSecret = String(raw.pathao_client_secret || '').trim();
    if (pathaoClientSecret) {
      if (isEncrypted(pathaoClientSecret)) {
        pathaoClientSecret = decrypt(pathaoClientSecret);
      } else {
        migrated = true;
      }
    }

    const decrypted: CourierConfig = {
      provider: raw.provider || 'steadfast',
      steadfast_api_key: steadfastApiKey,
      steadfast_secret_key: steadfastSecretKey,
      pathao_client_id: String(raw.pathao_client_id || '').trim(),
      pathao_client_secret: pathaoClientSecret,
      auto_send_tracking_sms: raw.auto_send_tracking_sms !== false,
      default_delivery_charge_inside: Number(raw.default_delivery_charge_inside ?? 60),
      default_delivery_charge_outside: Number(raw.default_delivery_charge_outside ?? 120),
    };

    if (migrated) {
      const configToStore = {
        ...decrypted,
        steadfast_api_key: decrypted.steadfast_api_key ? encrypt(decrypted.steadfast_api_key) : '',
        steadfast_secret_key: decrypted.steadfast_secret_key ? encrypt(decrypted.steadfast_secret_key) : '',
        pathao_client_secret: decrypted.pathao_client_secret ? encrypt(decrypted.pathao_client_secret) : '',
      };
      await this.pool.query('UPDATE clients SET courier_config_json = $1 WHERE id = $2', [
        JSON.stringify(configToStore),
        tenantId,
      ]);
    }

    return decrypted;
  }

  /**
   * Returns courier configuration safe for UI/API consumption:
   * Secrets are masked (e.g. `****last4`), and a `configured: boolean` status is included per provider.
   * Plaintext secret values are never returned.
   */
  async getMaskedConfig(tenantId: number): Promise<any> {
    const decrypted = await this.getDecryptedConfig(tenantId);
    const sfConfigured = Boolean(decrypted.steadfast_api_key && decrypted.steadfast_secret_key);
    const pathaoConfigured = Boolean(decrypted.pathao_client_id && decrypted.pathao_client_secret);

    return {
      provider: decrypted.provider || 'steadfast',
      steadfast_api_key: maskSecret(decrypted.steadfast_api_key),
      steadfast_secret_key: maskSecret(decrypted.steadfast_secret_key),
      pathao_client_id: decrypted.pathao_client_id || '',
      pathao_client_secret: maskSecret(decrypted.pathao_client_secret),
      auto_send_tracking_sms: decrypted.auto_send_tracking_sms !== false,
      default_delivery_charge_inside: decrypted.default_delivery_charge_inside,
      default_delivery_charge_outside: decrypted.default_delivery_charge_outside,
      configured: {
        steadfast: sfConfigured,
        pathao: pathaoConfigured,
      },
      steadfast_configured: sfConfigured,
      pathao_configured: pathaoConfigured,
    };
  }

  /**
   * Saves courier configuration, preserving unchanged masked secrets and encrypting new secrets at rest.
   */
  async saveConfig(tenantId: number, body: any): Promise<any> {
    const existing = await this.getDecryptedConfig(tenantId);

    let steadfastApiKey = String(body?.steadfast_api_key ?? '').trim();
    if (steadfastApiKey.startsWith('****')) {
      steadfastApiKey = existing.steadfast_api_key;
    }

    let steadfastSecretKey = String(body?.steadfast_secret_key ?? '').trim();
    if (steadfastSecretKey.startsWith('****')) {
      steadfastSecretKey = existing.steadfast_secret_key;
    }

    let pathaoClientSecret = String(body?.pathao_client_secret ?? '').trim();
    if (pathaoClientSecret.startsWith('****')) {
      pathaoClientSecret = existing.pathao_client_secret;
    }

    const configToStore = {
      provider: body?.provider || existing.provider || 'steadfast',
      steadfast_api_key: steadfastApiKey ? encrypt(steadfastApiKey) : '',
      steadfast_secret_key: steadfastSecretKey ? encrypt(steadfastSecretKey) : '',
      pathao_client_id: String(body?.pathao_client_id !== undefined ? body.pathao_client_id : existing.pathao_client_id || '').trim(),
      pathao_client_secret: pathaoClientSecret ? encrypt(pathaoClientSecret) : '',
      auto_send_tracking_sms: body?.auto_send_tracking_sms !== false,
      default_delivery_charge_inside: Number(body?.default_delivery_charge_inside ?? existing.default_delivery_charge_inside ?? 60),
      default_delivery_charge_outside: Number(body?.default_delivery_charge_outside ?? existing.default_delivery_charge_outside ?? 120),
    };

    await this.pool.query('UPDATE clients SET courier_config_json = $1 WHERE id = $2', [
      JSON.stringify(configToStore),
      tenantId,
    ]);

    return this.getMaskedConfig(tenantId);
  }

  private defaultConfig(): CourierConfig {
    return {
      provider: 'steadfast',
      steadfast_api_key: '',
      steadfast_secret_key: '',
      pathao_client_id: '',
      pathao_client_secret: '',
      auto_send_tracking_sms: true,
      default_delivery_charge_inside: 60,
      default_delivery_charge_outside: 120,
    };
  }
}
