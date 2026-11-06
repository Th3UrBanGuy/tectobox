import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  conn.exec(`docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox -c "SELECT id, username, role, active, LEFT(password_hash, 20) as hash_preview FROM users ORDER BY id;"`, (err, stream) => {
    if (err) throw err;
    stream.on('data', d => process.stdout.write(d.toString()));
    stream.stderr.on('data', d => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
}).connect({ host: '160.25.5.64', username: 'root', password: 'Tect0nic123' });
