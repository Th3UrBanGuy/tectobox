import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  conn.exec(`docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox -c "SELECT u.id, u.username, u.role, u.client_id, c.name, l.id as lic_id, l.features_json, l.status FROM users u LEFT JOIN clients c ON u.client_id = c.id LEFT JOIN licenses l ON l.client_id = u.client_id;"`, (err, stream) => {
    if (err) throw err;
    stream.on('data', (d: Buffer) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
}).connect({ host: '160.25.5.64', username: 'root', password: 'Tect0nic123' });
