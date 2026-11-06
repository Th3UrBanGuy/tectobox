import { hashPassword } from '../services/api/src/auth/password.util.ts';
import { Client } from 'ssh2';

async function updateXyz() {
  const hash = await hashPassword('xyz123');
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec(`docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox -c "UPDATE users SET password_hash = '${hash}' WHERE username = 'xyz'; SELECT id, username, password_hash FROM users WHERE username = 'xyz';"`, (err, stream) => {
      if (err) throw err;
      stream.on('data', (d: Buffer) => process.stdout.write(d.toString()));
      stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()));
      stream.on('close', () => conn.end());
    });
  }).connect({ host: '160.25.5.64', username: 'root', password: 'Tect0nic123' });
}
updateXyz().catch(console.error);
