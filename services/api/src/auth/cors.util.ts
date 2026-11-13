export const DEFAULT_PRODUCTION_ORIGIN = 'https://box.tect0nic.com';

/**
 * Returns the allowlist of origins. Reads from CORS_ORIGINS env (comma-separated),
 * defaulting to the production origin only.
 */
export function getAllowedOrigins(envValue?: string): string[] {
  const raw = envValue !== undefined ? envValue : process.env.CORS_ORIGINS;
  if (!raw || !raw.trim()) {
    return [DEFAULT_PRODUCTION_ORIGIN];
  }
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Checks whether the given request Origin header is permitted by the allowlist.
 * If origin is undefined (non-CORS requests, e.g. curl or server-to-server), it is permitted.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[] = getAllowedOrigins()
): boolean {
  if (!origin) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

/**
 * Callback function compatible with express/cors `origin` option.
 * If origin is not allowed, it passes `false` to omit Access-Control-Allow-Origin.
 */
export function corsOriginCallback(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
  allowedOrigins?: string[]
): void {
  if (isOriginAllowed(origin, allowedOrigins)) {
    callback(null, true);
  } else {
    callback(null, false);
  }
}
