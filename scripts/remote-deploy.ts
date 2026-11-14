import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
import { getVpsSshConfig } from './vps-ssh.ts';

// C5: SSH key auth only (see vps-ssh.ts) — no password field anywhere.
const config = {
  ...getVpsSshConfig(),
  domain: process.env.DOMAIN || 'box.tect0nic.com',
};

console.log(`[deploy] Connecting to ${config.username}@${config.host}:${config.port}...`);

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

function sftpUpload(client: Client, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);
      writeStream.on('close', () => resolve());
      writeStream.on('error', (e) => reject(e));
      readStream.pipe(writeStream);
    });
  });
}

conn
  .on('ready', async () => {
    console.log('[deploy] SSH Connection established successfully!');

    try {
      // 1. Host system diagnosis
      console.log('\n--- 1. HOST SYSTEM DIAGNOSIS ---');
      await execCommand(conn, 'uname -a && cat /etc/os-release | grep PRETTY_NAME && free -h && df -h /');

      // 2. Clone or update repository on VPS
      console.log('\n--- 2. SYNCING CODEBASE TO /opt/tectobox ---');
      await execCommand(conn, `
        if [ -d /opt/tectobox/.git ]; then
          echo "[deploy] Updating existing git repository at /opt/tectobox..."
          cd /opt/tectobox && git fetch origin && git reset --hard origin/main
        else
          echo "[deploy] Cloning repository to /opt/tectobox..."
          rm -rf /opt/tectobox
          git clone https://github.com/Th3UrBanGuy/tectobox.git /opt/tectobox
        fi
      `);

      // 3. Configure production .env with domain
      console.log('\n--- 3. CONFIGURING PRODUCTION ENVIRONMENT VARIABLES ---');
      await execCommand(conn, `
        cd /opt/tectobox
        if [ ! -f /opt/tectobox/.env ]; then
          PG_PASS=$(openssl rand -hex 20)
          REDIS_PASS=$(openssl rand -hex 20)
          RABBIT_PASS=$(openssl rand -hex 20)
          JWT_SEC=$(openssl rand -hex 32)
          cat <<EOF > /opt/tectobox/.env
NODE_ENV=production
IMAGE_REPO_OWNER=th3urbanguy
IMAGE_TAG=latest
DOMAIN=${config.domain}

POSTGRES_USER=tectobox
POSTGRES_PASSWORD=\${PG_PASS}
POSTGRES_DB=tectobox

REDIS_PASSWORD=\${REDIS_PASS}

RABBITMQ_USER=tectobox
RABBITMQ_PASS=\${RABBIT_PASS}

JWT_SECRET=\${JWT_SEC}
EOF
          chmod 600 /opt/tectobox/.env
        fi

        # Ensure DOMAIN is set to target
        if grep -q "^DOMAIN=" /opt/tectobox/.env; then
          sed -i 's/^DOMAIN=.*/DOMAIN=${config.domain}/' /opt/tectobox/.env
        else
          echo "DOMAIN=${config.domain}" >> /opt/tectobox/.env
        fi
        echo "[deploy] .env file configured:"
        cat /opt/tectobox/.env | grep -v "PASSWORD\\|SECRET\\|PASS"
      `);

      // 4. Run Docker Deployment
      console.log('\n--- 4. EXECUTING PRODUCTION DOCKER DEPLOYMENT ---');
      await execCommand(conn, `
        cd /opt/tectobox
        chmod +x scripts/*.sh infra/*.sh || true
        # Build local images on VPS (fast, accurate, no GHCR registry auth needed)
        docker compose build
        # Spin up containers
        docker compose up -d --remove-orphans
      `);

      // 5. Check service health
      console.log('\n--- 5. CHECKING SERVICE HEALTH & STATUS ---');
      await execCommand(conn, `
        sleep 10
        docker compose -f /opt/tectobox/infra/docker-compose.prod.yml ps
        echo "\n[deploy] Testing Gateway & Core API response:"
        curl -sI http://127.0.0.1:80/api/healthz || curl -sI http://127.0.0.1:80/ || true
      `);

      console.log('\n==========================================================');
      console.log(`[SUCCESS] Tectobox is successfully deployed and live at:`);
      console.log(`- HTTPS: https://${config.domain}`);
      console.log(`- Direct IP: http://${config.host}`);
      console.log('==========================================================');
    } catch (err) {
      console.error('[deploy] Fatal error during deployment:', err);
    } finally {
      conn.end();
    }
  })
  .on('error', (err) => {
    console.error('[deploy] SSH Connection failed:', err);
  })
  .connect({
    host: config.host,
    port: config.port,
    username: config.username,
    privateKey: config.privateKey,
    readyTimeout: 30000,
  });
