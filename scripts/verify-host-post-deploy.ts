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
    console.log('--- 1. RUNNING CONTAINERS STATUS ---');
    console.log(await run('docker ps --filter "name=tectobox-prod-" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"'));

    console.log('--- 1.1 DOCKER NETWORKS ---');
    console.log(await run('docker network ls'));
    console.log('RabbitMQ networks:', await run('docker inspect tectobox-prod-rabbitmq | grep -A 10 Networks'));
    console.log('Workers networks:', await run('docker inspect tectobox-prod-workers | grep -A 10 Networks'));



    console.log('--- 2. API HEALTHZ TEST ---');
    console.log(await run('curl -s http://127.0.0.1:80/api/healthz'));

    console.log('--- 3. API RECENT LOGS ---');
    console.log(await run('docker logs --tail 30 tectobox-prod-api'));

    console.log('--- 4. WORKERS RECENT LOGS ---');
    console.log(await run('docker logs --tail 30 tectobox-prod-workers'));

    console.log('--- 5. TEST OPERATOR LOGIN & STATUS ENDPOINT ---');
    // C1: the operator password comes from the environment — never a literal.
    const operatorPassword = process.env.VERIFY_OPERATOR_PASSWORD;
    if (!operatorPassword) {
      throw new Error('[verify] VERIFY_OPERATOR_PASSWORD must be set in the environment to test the operator login.');
    }
    console.log(await run(`
      COOKIE=$(curl -s -c - -X POST http://127.0.0.1:80/api/auth/login -H "Content-Type: application/json" -d '{"username":"operator","password":"${operatorPassword}"}' | grep tb_session | awk '{print $NF}')
      echo "tb_session cookie: $COOKIE"
      echo "Status response for operator:"
      curl -s -H "Cookie: tb_session=$COOKIE" http://127.0.0.1:80/api/status
      echo ""
      echo "Diagnostics errors endpoint for operator:"
      curl -s -H "Cookie: tb_session=$COOKIE" http://127.0.0.1:80/api/diagnostics/errors
    `));
  } catch (e) {
    console.error('Error during post deploy check:', e);
  } finally {
    conn.end();
  }
}).connect(getVpsSshConfig());
