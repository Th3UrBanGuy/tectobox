import { Client } from 'ssh2';

const config = {
  host: process.env.VPS_HOST || '160.25.5.64',
  port: Number(process.env.VPS_PORT) || 22,
  username: process.env.VPS_USERNAME || 'root',
  password: process.env.VPS_PASSWORD || 'Tect0nic123',
};

const conn = new Client();

function execCommand(client: Client, cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code: number) => {
          resolve({ stdout, stderr, code: code || 0 });
        })
        .on('data', (data: Buffer) => {
          const str = data.toString();
          process.stdout.write(str);
          stdout += str;
        })
        .stderr.on('data', (data: Buffer) => {
          const str = data.toString();
          process.stderr.write(str);
          stderr += str;
        });
    });
  });
}

conn
  .on('ready', async () => {
    console.log('[update] SSH Connection established.');

    try {
      console.log('[update] Pulling latest main on VPS...');
      await execCommand(conn, 'cd /opt/tectobox && git checkout main && git fetch origin && git reset --hard origin/main');

      console.log('[update] Building api and workers images on VPS...');
      await execCommand(conn, 'cd /opt/tectobox && docker compose -f infra/docker-compose.prod.yml build api');
      await execCommand(conn, 'cd /opt/tectobox && docker compose -f infra/docker-compose.prod.yml build workers');

      console.log('[update] Recreating api and workers containers...');
      await execCommand(conn, 'docker stop tectobox-prod-api tectobox-prod-workers || true');
      await execCommand(conn, 'docker rm tectobox-prod-api tectobox-prod-workers || true');
      await execCommand(conn, 'cd /opt/tectobox && docker compose -f infra/docker-compose.prod.yml up -d --no-deps api workers');

      console.log('[update] Ensuring network alias and restarting gateway...');
      await execCommand(conn, 'docker network connect --alias api tectobox_internal-net tectobox-prod-api || true ; docker restart tectobox-prod-gateway');

      console.log('[update] Checking container health...');
      await execCommand(conn, 'sleep 4 && docker ps --filter "name=tectobox-prod-"');
    } catch (err) {
      console.error('[update] Error:', err);
    } finally {
      conn.end();
    }
  })
  .on('error', (err) => {
    console.error('[update] Connection failed:', err);
  })
  .connect(config);
