import { Client } from 'ssh2';
import { getVpsSshConfig } from './vps-ssh.ts';

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
  .connect(getVpsSshConfig());
