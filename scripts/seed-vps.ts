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
    console.log('[seed] SSH Connection established.');

    try {
      const seedSql = `
        INSERT INTO clients (id, name, business_type, widget_key, created_at)
        VALUES (1, 'Main Workspace', 'physical', 'wk_main_workspace_seed', NOW())
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO users (id, username, role, client_id, password_hash, active, created_at)
        VALUES 
          (1, 'admin', 'admin', NULL, '0bba8e19c8d3de083aeb8f747aaf667b:97c64b542bb4e7b8020154bcc32a5103a15a68393565386c9c8d0e720ac605b89583c69f04401e959b6378357ba2e7567a2e2eb94c30a37e9dc41b3a32d6443d', true, NOW()),
          (2, 'operator', 'operator', 1, 'dd6ac7837c96cb876c8ec7aa5f0dc40f:ebc09281dfbfc756ca6f06d27880a55cf4c061aecc14dcbaef0d5e23b166e223bc6537e2c56f383a612d5c02d2c6de44ee8d281a7eed5668ac26dea7e1b30f25', true, NOW())
        ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash;

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
