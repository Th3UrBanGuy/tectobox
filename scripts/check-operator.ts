import pg from 'pg';

const pool = new pg.Pool({ connectionString: 'postgres://postgres:tectonic_secret_2026@160.25.5.64:5432/tectobox' });

async function check() {
  const users = await pool.query("SELECT id, username, role, client_id FROM users WHERE username = 'operator'");
  console.log('Operator user:', users.rows[0]);
  if (users.rows[0]) {
    const cid = users.rows[0].client_id;
    const client = await pool.query('SELECT * FROM clients WHERE id = $1', [cid]);
    console.log('Client:', client.rows[0]);
    const lic = await pool.query('SELECT * FROM licenses WHERE client_id = $1', [cid]);
    console.log('Licenses for client ' + cid + ':', lic.rows);
  }
  await pool.end();
}
check();
