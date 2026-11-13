import { describe, it, expect } from 'vitest';
import { loadAppConfig } from './app.config.js';

describe('loadAppConfig (M15 Zod startup validation)', () => {
  const validBaseEnv = {
    JWT_SECRET: 'this_is_a_very_secure_jwt_secret_with_32_bytes_len',
    DATABASE_URL: 'postgres://tectobox:tectobox_dev@localhost:5432/tectobox',
    REDIS_URL: 'redis://localhost:6379',
    RABBITMQ_URL: 'amqp://tectobox:tectobox_dev@localhost:5672/',
  };

  it('succeeds with valid required environment variables', () => {
    const config = loadAppConfig(validBaseEnv);
    expect(config.jwtSecret).toBe(validBaseEnv.JWT_SECRET);
    expect(config.port).toBe(3120);
    expect(config.nodeEnv).toBe('development');
  });

  it('fails fast with clear error message when JWT_SECRET is missing', () => {
    const envWithoutSecret = { ...validBaseEnv };
    delete (envWithoutSecret as any).JWT_SECRET;

    expect(() => loadAppConfig(envWithoutSecret)).toThrowError(
      /\[Config Validation Failed\].*jwtSecret/s
    );
  });

  it('fails fast with clear error message when JWT_SECRET is too short (< 16 chars)', () => {
    const envWithShortSecret = { ...validBaseEnv, JWT_SECRET: 'too_short' };

    expect(() => loadAppConfig(envWithShortSecret)).toThrowError(
      /\[Config Validation Failed\].*at least 16 characters/s
    );
  });

  it('fails fast when nodeEnv is invalid', () => {
    const envWithBadNodeEnv = { ...validBaseEnv, NODE_ENV: 'staging' };

    expect(() => loadAppConfig(envWithBadNodeEnv as any)).toThrowError(
      /\[Config Validation Failed\].*nodeEnv/s
    );
  });
});
