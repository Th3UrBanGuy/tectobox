import pg from 'pg';

// C5: the database connection string comes from the environment — no
// credential literal in source. Required: VPS_DATABASE_URL
// (e.g. postgresql://<user>:<password>@<vps-host>:5432/tectobox).
const connectionString = process.env.VPS_DATABASE_URL;
if (!connectionString) {
  throw new Error('[check-operator] VPS_DATABASE_URL must be set in the environment.');
}

const pool = new pg.Pool({ connectionString });

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
