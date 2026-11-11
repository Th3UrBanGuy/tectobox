import { Client } from 'ssh2';
import { getVpsSshConfig } from './vps-ssh.ts';

const conn = new Client();
conn.on('ready', () => {
  const query = `
    SELECT u.id, u.username, u.role, u.client_id, u.active, u.password_hash, c.name as client_name
    FROM users u
    LEFT JOIN clients c ON u.client_id = c.id
    ORDER BY u.id ASC;
  `;
  
  conn.exec(`docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox -c "${query.replace(/\n/g, ' ')}"`, (err, stream) => {
    if (err) throw err;
    stream.on('data', (d: Buffer) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
}).connect(getVpsSshConfig());
