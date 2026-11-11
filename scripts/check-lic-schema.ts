import { Client } from 'ssh2';
import { getVpsSshConfig } from './vps-ssh.ts';

const conn = new Client();
conn.on('ready', () => {
  conn.exec(`docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox -c "\\d licenses"`, (err, stream) => {
    if (err) throw err;
    stream.on('data', (d: Buffer) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
}).connect(getVpsSshConfig());
