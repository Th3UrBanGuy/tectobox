import { Client } from 'ssh2';
import { getVpsSshConfig } from './vps-ssh.ts';

// C5: SSH key auth only (see vps-ssh.ts). C1: the seed SQL below seeds the
// client workspace only — no user password hashes are committed here.
const config = getVpsSshConfig();

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
    console.log('[seed] SSH Connection established.');

    try {
      const seedSql = `
        INSERT INTO clients (id, name, business_type, widget_key, created_at)
        VALUES (1, 'Main Workspace', 'physical', 'wk_main_workspace_seed', NOW())
        ON CONFLICT (id) DO NOTHING;

        SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 1) FROM users));
        SELECT setval('clients_id_seq', (SELECT COALESCE(MAX(id), 1) FROM clients));
      `;

      console.log('[seed] Applying seed SQL to tectobox-prod-postgres...');
      const res = await execCommand(conn, `docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox << 'EOF'\n${seedSql}\nEOF`);
      console.log('[seed] Result:', res.stdout);

      console.log('[seed] Verifying users in database...');
      const verify = await execCommand(conn, `docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox -c "SELECT id, username, role, client_id FROM users;"`);
      console.log('[seed] Users in DB:', verify.stdout);
    } catch (err) {
      console.error('[seed] Error:', err);
    } finally {
      conn.end();
    }
  })
  .on('error', (err) => {
    console.error('[seed] Connection failed:', err);
  })
  .connect(config);
