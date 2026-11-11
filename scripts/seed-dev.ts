import pg from 'pg';
import crypto from 'node:crypto';
import util from 'node:util';

const scryptAsync = util.promisify(crypto.scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(String(password), salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

async function seed() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://tectobox:tectobox_dev@127.0.0.1:5432/tectobox',
  });
  await client.connect();
  console.log('[seed] Connected to PostgreSQL');

  // 1. Insert Workspace / Client
  await client.query(`
    INSERT INTO clients (id, name, widget_key, created_at)
    VALUES (1, 'Aurora Demo Store', 'test-widget-key', NOW())
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, widget_key = EXCLUDED.widget_key
  `);
  console.log('[seed] Client seeded (id: 1)');

  // 2. Insert Users (admin / operator) — passwords come from the
  // environment only (C1). No default: the script stops with a clear error
  // instead of seeding a well-known password.
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  const operatorPassword = process.env.SEED_OPERATOR_PASSWORD;
  if (!adminPassword || !operatorPassword) {
    throw new Error('[seed] SEED_ADMIN_PASSWORD and SEED_OPERATOR_PASSWORD must both be set in the environment (no default passwords are seeded).');
  }
  const adminHash = await hashPassword(adminPassword);
  const opHash = await hashPassword(operatorPassword);

  await client.query(`
    INSERT INTO users (id, username, password_hash, role, client_id, active, created_at)
    VALUES 
      (1, 'admin', $1, 'admin', null, true, NOW()),
      (2, 'operator', $2, 'operator', 1, true, NOW())
    ON CONFLICT (username) DO UPDATE 
    SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, client_id = EXCLUDED.client_id, active = true
  `, [adminHash, opHash]);
  console.log('[seed] Users seeded (admin, operator)');

  // 3. Products
  const products = [
    { sku: 'buds-pro', name: 'AirBuds Pro ANC', category: 'Electronics', price_bdt: 1800, stock: 25 },
    { sku: 'kurti-red', name: 'Cotton Kurti (Red)', category: 'Fashion', price_bdt: 1200, stock: 40 },
    { sku: 'panjabi-white', name: 'Premium Panjabi (White)', category: 'Fashion', price_bdt: 2500, stock: 14 },
    { sku: 'watch-fit', name: 'FitBand Smart Watch', category: 'Electronics', price_bdt: 3200, stock: 18 },
  ];

  for (const p of products) {
    await client.query(`
      INSERT INTO products (client_id, sku, name, category, price_bdt, stock)
      VALUES (1, $1, $2, $3, $4, $5)
      ON CONFLICT (client_id, sku) DO UPDATE
      SET name = EXCLUDED.name, category = EXCLUDED.category, price_bdt = EXCLUDED.price_bdt, stock = EXCLUDED.stock
    `, [p.sku, p.name, p.category, p.price_bdt, p.stock]);
  }
  console.log('[seed] Products seeded (4 items)');

  // 4. Conversations & Messages
  const convRes = await client.query(`
    INSERT INTO conversations (client_id, platform, platform_user_id, slot, customer_name, customer_phone, last_message_at, unread_count, status)
    VALUES 
      (1, 'whatsapp', '01711111111', 'default', 'Rahim Uddin', '01711111111', NOW(), 1, 'open'),
      (1, 'telegram', '12345678', 'default', 'Nusrat Jahan', '01822222222', NOW(), 0, 'open'),
      (1, 'webchat', 'wc-tanvir-123', 'default', 'Tanvir Hasan', '01933333333', NOW(), 0, 'open')
    ON CONFLICT (client_id, platform, platform_user_id, slot) DO UPDATE
    SET customer_name = EXCLUDED.customer_name, last_message_at = NOW()
    RETURNING id, platform
  `);

  for (const row of convRes.rows) {
    await client.query(`
      INSERT INTO messages (conversation_id, direction, text, created_at)
      VALUES 
        ($1, 'in', 'Hello, this is a test message from customer on ' || $2, NOW()),
        ($1, 'out', 'Hello! Welcome to Aurora Demo Store. How can we help you today?', NOW())
    `, [row.id, row.platform]);
  }
  console.log('[seed] Conversations and messages seeded');

  // 5. Leads
  await client.query(`
    INSERT INTO leads (client_id, platform, platform_user_id, name, phone, score, status, updated_at)
    VALUES 
      (1, 'whatsapp', '01711111111', 'Rahim Uddin', '01711111111', 85, 'lead', NOW()),
      (1, 'telegram', '12345678', 'Nusrat Jahan', '01822222222', 70, 'user', NOW()),
      (1, 'webchat', 'wc-tanvir-123', 'Tanvir Hasan', '01933333333', 95, 'confirmed', NOW())
    ON CONFLICT (client_id, platform, platform_user_id) DO UPDATE
    SET score = EXCLUDED.score, status = EXCLUDED.status, updated_at = NOW()
  `);
  console.log('[seed] Leads seeded');

  // 6. Knowledge
  await client.query(`
    INSERT INTO knowledge (client_id, category, title, content)
    VALUES 
      (1, 'shipping', 'Delivery & Shipping Policy', 'Inside Dhaka delivery is 60 BDT (takes 24-48 hours). Outside Dhaka delivery is 120 BDT via Courier (takes 2-3 days). Cash on delivery available everywhere.'),
      (1, 'returns', 'Return & Exchange Policy', 'Items can be returned or exchanged within 7 days of delivery if unused and with original tags.')
  `);
  console.log('[seed] Knowledge base seeded');

  // 7. Channel Sessions
  await client.query(`
    INSERT INTO channel_sessions (client_id, channel, slot, status, label, updated_at)
    VALUES 
      (1, 'whatsapp', 'default', 'connected', 'Primary WhatsApp', NOW()),
      (1, 'telegram', 'default', 'connected', 'Support Bot', NOW())
    ON CONFLICT (client_id, channel, slot) DO UPDATE
    SET status = 'connected', updated_at = NOW()
  `);
  console.log('[seed] Channel sessions seeded');

  // 8. Licensing Plans & Active License
  await client.query(`
    INSERT INTO plans (id, name, kind, billing_period, price_bdt, active)
    VALUES (1, 'Pro Growth', 'time', 'monthly', 2500, true)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `);
  await client.query(`
    INSERT INTO licenses (code, client_id, plan_id, kind, billing_period, starts_at, ends_at, status)
    VALUES ('TECTOBOX-PRO-GROWTH-2026-KEY', 1, 1, 'time', 'monthly', NOW(), NOW() + INTERVAL '365 days', 'active')
    ON CONFLICT (code) DO NOTHING
  `);
  console.log('[seed] Plan & license seeded');

  console.log('[seed] Completed successfully!');
  await client.end();
}

seed().catch(console.error);
