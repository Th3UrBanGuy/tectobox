import pg from 'pg';

async function checkDb() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://tectobox:tectobox_dev@127.0.0.1:5432/tectobox',
  });
  await client.connect();
  const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
  console.log('PostgreSQL Connected! Total tables:', res.rows.length);
  console.log('Tables:', res.rows.map(r => r.table_name));

  // Check if users table exists and has demo admin
  const userCount = await client.query('SELECT COUNT(*) as count FROM users');
  console.log('Users count:', userCount.rows[0].count);

  await client.end();
}

checkDb().catch(console.error);
