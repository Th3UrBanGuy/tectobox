import { Client } from 'ssh2';
import { getVpsSshConfig } from './vps-ssh.ts';

const conn = new Client();
conn.on('ready', () => {
  const query = `
    INSERT INTO licenses (client_id, code, kind, starts_at, status, features_json, credits_total, credits_used, created_at)
    SELECT c.id, 'TB-AUTO-' || c.id || '-' || to_hex(extract(epoch from now())::bigint), 'time', NOW(), 'active', '["combined_inbox", "inbox", "ai_response", "webchat", "broadcast", "lead_intel", "knowledge", "api_access"]'::jsonb, 10000, 0, NOW()
    FROM clients c
    WHERE NOT EXISTS (SELECT 1 FROM licenses l WHERE l.client_id = c.id AND l.status = 'active');

    UPDATE licenses
    SET features_json = '["combined_inbox", "inbox", "ai_response", "webchat", "broadcast", "lead_intel", "knowledge", "api_access"]'::jsonb
    WHERE status = 'active';

    SELECT u.id, u.username, u.role, u.client_id, c.name, l.id as lic_id, l.status, l.features_json
    FROM users u
    LEFT JOIN clients c ON u.client_id = c.id
    LEFT JOIN licenses l ON l.client_id = u.client_id AND l.status = 'active';
  `;
  
  conn.exec(`docker exec -i tectobox-prod-postgres psql -U tectobox -d tectobox << 'EOF'
${query}
EOF`, (err, stream) => {
    if (err) throw err;
    stream.on('data', (d: Buffer) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
}).connect(getVpsSshConfig());
