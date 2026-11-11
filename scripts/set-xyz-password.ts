import { hashPassword } from '../services/api/src/auth/password.util.ts';
import { Client } from 'ssh2';
import { getVpsSshConfig } from './vps-ssh.ts';

async function updateXyz() {
  // C1: the new password comes from the environment (or argv) — never a
  // literal in source. No default.
  const newPassword = process.env.XYZ_PASSWORD || process.argv[2];
  if (!newPassword) {
    throw new Error('[set-xyz-password] XYZ_PASSWORD env var (or a password argument) is required.');
  }
  const hash = await hashPassword(newPassword);
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec(`docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox -c "UPDATE users SET password_hash = '${hash}' WHERE username = 'xyz'; SELECT id, username, password_hash FROM users WHERE username = 'xyz';"`, (err, stream) => {
      if (err) throw err;
      stream.on('data', (d: Buffer) => process.stdout.write(d.toString()));
      stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()));
      stream.on('close', () => conn.end());
    });
  }).connect(getVpsSshConfig());
}
updateXyz().catch(console.error);
