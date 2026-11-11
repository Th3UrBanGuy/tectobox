import { Client } from 'ssh2';
import { getVpsSshConfig } from './vps-ssh.ts';

const conn = new Client();

function run(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('data', (d: Buffer) => (out += d.toString()));
      stream.stderr.on('data', (d: Buffer) => (errOut += d.toString()));
      stream.on('close', () => resolve(out || errOut));
    });
  });
}

conn.on('ready', async () => {
  try {
    console.log('--- 1. VPS GIT REPO STATUS ---');
    console.log(await run('cd /opt/tectobox && git status && git log -n 5 --oneline'));

    console.log('--- 2. RUNNING DOCKER CONTAINERS ---');
    console.log(await run('docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"'));

    console.log('--- 3. DOCKER COMPOSE CONFIG (API SERVICE) ---');
    console.log(await run('cd /opt/tectobox && docker compose -f infra/docker-compose.prod.yml config --services'));
    console.log(await run('grep -A 20 "api:" /opt/tectobox/infra/docker-compose.prod.yml'));

    console.log('--- 4. API CONTAINER IMAGE & CREATED TIME ---');
    console.log(await run('docker inspect tectobox-prod-api --format "Image: {{.Image}}, Created: {{.Created}}, ImageID: {{.Id}}"'));

    console.log('--- 5. DOCKER IMAGES LIST ON VPS ---');
    console.log(await run('docker images | grep -E "tectobox|api"'));

    console.log('--- 6. CADDY / GATEWAY CONFIG ---');
    console.log(await run('docker exec tectobox-prod-gateway cat /etc/caddy/Caddyfile 2>/dev/null || cat /opt/tectobox/infra/Caddyfile 2>/dev/null || cat /opt/tectobox/infra/caddy/Caddyfile 2>/dev/null'));

    console.log('--- 7. LIVE CONTAINER FILE INSPECTION ---');
    console.log('API container welcome.html line count & title:');
    console.log(await run('docker exec tectobox-prod-api head -n 25 /app/services/api/public/welcome.html | grep -E "<title>|h1|hero"'));
    console.log('API container index.html stylesheet version:');
    console.log(await run('docker exec tectobox-prod-api grep "styles.css" /app/services/api/public/index.html'));
    console.log('API container app.js isInboxLocked function:');
    console.log(await run('docker exec tectobox-prod-api grep -n -A 10 "function isInboxLocked" /app/services/api/public/app.js'));

    console.log('--- 8. ACTUAL HTTP RESPONSE FROM OUTSIDE (CADDY) VS CONTAINER DIRECT ---');
    console.log('Direct container curl port 3120:');
    console.log(await run('docker exec tectobox-prod-api wget -qO- http://127.0.0.1:3120/ | head -n 15'));
    console.log('Caddy public curl port 80:');
    console.log(await run('curl -s http://127.0.0.1:80/ | head -n 15'));

    console.log('--- 9. DATABASE CONTENT IN POSTGRES (OPERATOR USER & LICENSE) ---');
    console.log(await run(`docker exec tectobox-prod-postgres psql -U tectobox -d tectobox -c "SELECT u.id, u.username, u.role, u.client_id, l.id as lic_id, l.features_json, l.status FROM users u LEFT JOIN licenses l ON u.client_id = l.client_id WHERE u.username IN ('operator', 'admin', 'xyz');"`));

    console.log('--- 10. ORDERS TABLE COLUMNS IN POSTGRES ---');
    console.log(await run(`docker exec tectobox-prod-postgres psql -U tectobox -d tectobox -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders';"`));

    console.log('--- 11. COMMITS DIFFERENCE BETWEEN LOCAL MAIN & VPS BRANCH ---');
    console.log(await run('cd /opt/tectobox && git log -n 5 --graph --oneline --decorate'));


  } catch (e) {
    console.error('Error during audit:', e);
  } finally {
    conn.end();
  }
}).connect(getVpsSshConfig());
