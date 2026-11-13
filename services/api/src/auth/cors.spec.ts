import { describe, it, expect } from 'vitest';
import { getAllowedOrigins, isOriginAllowed, corsOriginCallback, DEFAULT_PRODUCTION_ORIGIN } from './cors.util.js';

describe('CORS allowlist', () => {
  it('defaults to production origin when CORS_ORIGINS is not set', () => {
    const origins = getAllowedOrigins(undefined);
    expect(origins).toEqual([DEFAULT_PRODUCTION_ORIGIN]);
    expect(origins).toContain('https://box.tect0nic.com');
  });

  it('parses comma-separated origins from custom string or env', () => {
    const origins = getAllowedOrigins('https://admin.tectobox.com, https://app.tectobox.com , https://box.tect0nic.com');
    expect(origins).toEqual([
      'https://admin.tectobox.com',
      'https://app.tectobox.com',
      'https://box.tect0nic.com',
    ]);
  });

  it('allows request from an origin on the allowlist', () => {
    const allowedList = ['https://box.tect0nic.com', 'https://app.example.com'];
    expect(isOriginAllowed('https://box.tect0nic.com', allowedList)).toBe(true);
    expect(isOriginAllowed('https://app.example.com', allowedList)).toBe(true);
  });

  it('rejects request from an origin not on the allowlist', () => {
    const allowedList = ['https://box.tect0nic.com'];
    expect(isOriginAllowed('https://evil-hacker.com', allowedList)).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', allowedList)).toBe(false);
  });

  it('permits non-CORS requests where Origin is missing (curl, server-to-server)', () => {
    const allowedList = ['https://box.tect0nic.com'];
    expect(isOriginAllowed(undefined, allowedList)).toBe(true);
  });

  it('corsOriginCallback passes true for allowed origin and false for unlisted origin', () => {
    const allowedList = ['https://box.tect0nic.com'];

    let allowedResult: boolean | undefined;
    corsOriginCallback('https://box.tect0nic.com', (_err, allow) => {
      allowedResult = allow;
    }, allowedList);
    expect(allowedResult).toBe(true);

    let rejectedResult: boolean | undefined;
    corsOriginCallback('https://unauthorized-domain.com', (_err, allow) => {
      rejectedResult = allow;
    }, allowedList);
    expect(rejectedResult).toBe(false);
  });
});
