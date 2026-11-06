import { Client } from 'ssh2';

const conn = new Client();
conn
  .on('ready', () => {
    conn.exec(
      'docker network connect tectobox_internal-net tectobox-prod-api && docker restart tectobox-prod-gateway',
      (err, stream) => {
        stream.on('data', (d: Buffer) => process.stdout.write(d)).on('close', () => conn.end());
      }
    );
  })
  .connect({ host: '160.25.5.64', port: 22, username: 'root', password: 'Tect0nic123' });
