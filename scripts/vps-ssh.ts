import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Shared VPS SSH config for ops scripts (C5).
 *
 * SSH key authentication only — no password auth anywhere. The private key
 * is read from `VPS_SSH_KEY`, or from the default `~/.ssh/vps-kalandar`.
 * The VPS host may be overridden with `VPS_HOST` (the IP itself is not a
 * secret, so the current host stays the default); `VPS_PORT` /
 * `VPS_USERNAME` likewise. A missing key file is a hard error with a clear
 * message instead of silently falling back to password auth.
 */
export interface VpsSshConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export function getVpsSshConfig(): VpsSshConfig {
  const keyPath = process.env.VPS_SSH_KEY || path.join(os.homedir(), '.ssh', 'vps-kalandar');
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `[vps-ssh] SSH private key not found at ${keyPath}. ` +
        'Set VPS_SSH_KEY to the path of your VPS private key, or place the key at ~/.ssh/vps-kalandar. ' +
        'Password authentication is not supported.',
    );
  }
  return {
    host: process.env.VPS_HOST || '160.25.5.64',
    port: Number(process.env.VPS_PORT) || 22,
    username: process.env.VPS_USERNAME || 'root',
    privateKey: fs.readFileSync(keyPath, 'utf8'),
  };
}
