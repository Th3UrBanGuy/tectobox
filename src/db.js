// SQLite layer — uses Node's built-in node:sqlite (DatabaseSync, no native build).
// v2 tables: clients, leads, knowledge, channel_sessions +
//            client_id scoping on conversations/products/orders.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'tectonic-inbox.db');
require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL DEFAULT 'physical' CHECK(business_type IN ('physical','digital')),
  lead_fields_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL DEFAULT 1 REFERENCES clients(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  last_message_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unread_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open',
  UNIQUE(client_id, platform, platform_user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  raw_json TEXT,
  external_id TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  price_bdt REAL NOT NULL,
  stock INTEGER DEFAULT 0,
  image_url TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id),
  items_json TEXT NOT NULL,
  total_bdt REAL NOT NULL,
  status TEXT DEFAULT 'confirmed',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  idempotency_key TEXT
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  name TEXT, phone TEXT, email TEXT, whatsapp_id TEXT, location TEXT,
  status TEXT NOT NULL DEFAULT 'lead' CHECK(status IN ('lead','user','confirmed')),
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(client_id, platform, platform_user_id)
);
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS channel_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  session_json TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(client_id, channel)
);
-- SaaS: each client OAuth-connects their OWN Facebook Page (never a global token).
CREATE TABLE IF NOT EXISTS meta_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_name TEXT,
  page_access_token TEXT NOT NULL,
  ig_user_id TEXT,
  ig_username TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(client_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_meta_pages_page ON meta_pages(page_id);
CREATE INDEX IF NOT EXISTS idx_meta_pages_ig ON meta_pages(ig_user_id);
-- SaaS auth: admin + per-client workspace users
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client',
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  event TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Public API access: per-workspace API keys. Only the SHA-256 hash is stored;
-- the raw key is shown once at creation and never again. last_used_at lets
-- owners spot leaked/unused keys.
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_client ON api_keys(client_id);
-- Outbound webhooks: a workspace can register URLs that receive signed
-- event POSTs (message.received, lead.created, order.created).
CREATE TABLE IF NOT EXISTS client_webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT 'message.received,lead.created,order.created',
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_client_webhooks_client ON client_webhooks(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_platform ON conversations(platform);
CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id, status);
-- FB/IG comment automation: every processed comment is logged once (idempotency +
-- reply-loop protection). A commenter auto-becomes a lead; the private_replies DM
-- opens a Messenger thread so the normal inbox/AI pipeline takes over from there.
CREATE TABLE IF NOT EXISTS fb_comment_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  comment_id TEXT NOT NULL UNIQUE,
  post_id TEXT,
  commenter_id TEXT,
  commenter_name TEXT,
  comment_text TEXT,
  reply_text TEXT,
  dm_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_comment_log_client ON fb_comment_log(client_id, id);
CREATE INDEX IF NOT EXISTS idx_knowledge_client ON knowledge(client_id);
`);

// ---- v2 migration: client_id columns on pre-v2 tables ----
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}
for (const t of ['conversations', 'products', 'orders']) {
  if (!columnExists(t, 'client_id')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN client_id INTEGER NOT NULL DEFAULT 1`);
    console.log(`[db] migrated: ${t}.client_id added`);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_conv_client ON conversations(client_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_products_client ON products(client_id)');

// Multi-account migration: channel_sessions gets slot + label columns.
// Old UNIQUE(client_id, channel) → UNIQUE(client_id, channel, slot).
const csSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_sessions'").get()?.sql || '';
if (csSql && !/slot/i.test(csSql)) {
  db.exec(`
    CREATE TABLE channel_sessions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      slot TEXT NOT NULL DEFAULT 'default',
      session_json TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      label TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(client_id, channel, slot)
    );
    INSERT INTO channel_sessions_new (id, client_id, channel, slot, session_json, status, updated_at)
      SELECT id, client_id, channel, 'default', session_json, status, updated_at FROM channel_sessions;
    DROP TABLE channel_sessions;
    ALTER TABLE channel_sessions_new RENAME TO channel_sessions;
  `);
  console.log('[db] migrated channel_sessions to multi-account (slot)');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id)');

// AI pause flag: per gateway account (client, channel, slot). While set, inbound
// messages are stored but the AI auto-reply stays silent (operator replies manually).
if (!columnExists('channel_sessions', 'ai_paused')) {
  db.exec('ALTER TABLE channel_sessions ADD COLUMN ai_paused INTEGER NOT NULL DEFAULT 0');
  console.log('[db] migrated: channel_sessions.ai_paused added');
}

// v1 had products.sku globally UNIQUE; v2 needs per-client uniqueness.
const prodSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'").get().sql;
if (prodSql && /sku\s+TEXT\s+UNIQUE/i.test(prodSql)) {
  db.exec(`
    CREATE TABLE products_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL DEFAULT 1,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      price_bdt REAL NOT NULL,
      stock INTEGER DEFAULT 0,
      image_url TEXT,
      UNIQUE(client_id, sku)
    );
    INSERT INTO products_new (id, client_id, sku, name, category, price_bdt, stock, image_url)
      SELECT id, client_id, sku, name, category, price_bdt, stock, image_url FROM products;
    DROP TABLE products;
    ALTER TABLE products_new RENAME TO products;
    CREATE INDEX idx_products_client ON products(client_id);
  `);
  console.log('[db] migrated: products.sku now unique per client');
}

// v2.1: conversations must be unique per (client, platform, user). The old
// UNIQUE(platform, platform_user_id) let one workspace silently steal another
// workspace's chat when the same customer contacted two clients.
const convSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'").get().sql;
if (convSql && !/UNIQUE\s*\(\s*client_id/i.test(convSql)) {
  const firstClient = db.prepare('SELECT id FROM clients ORDER BY id LIMIT 1').get();
  if (firstClient) {
    db.prepare('UPDATE conversations SET client_id = ? WHERE client_id NOT IN (SELECT id FROM clients)')
      .run(firstClient.id);
  }
  // Table rebuild needs FK enforcement off while the parent table is swapped
  // (messages.conversation_id references it); data was verified orphan-free above.
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE conversations_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL DEFAULT 1 REFERENCES clients(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      last_message_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      unread_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      UNIQUE(client_id, platform, platform_user_id)
    );
    INSERT INTO conversations_new (id, client_id, platform, platform_user_id, customer_name, customer_phone, last_message_at, unread_count, status)
      SELECT id, client_id, platform, platform_user_id, customer_name, customer_phone, last_message_at, unread_count, status FROM conversations;
    DROP TABLE conversations;
    ALTER TABLE conversations_new RENAME TO conversations;
    CREATE INDEX IF NOT EXISTS idx_conv_client ON conversations(client_id);
    CREATE INDEX IF NOT EXISTS idx_conv_platform ON conversations(platform);
  `);
  db.exec('PRAGMA foreign_keys = ON;');
  console.log('[db] migrated: conversations unique per (client_id, platform, platform_user_id)');
}

// v2.2: per-account (slot) conversations — a customer chatting with two
// different WhatsApp/Telegram accounts of the same client now gets one
// conversation per slot instead of merging into a single thread.
if (!columnExists('conversations', 'slot')) {
  // Table rebuild needs FK enforcement off while the parent table is swapped
  // (messages.conversation_id references it).
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE conversations_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL DEFAULT 1 REFERENCES clients(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      slot TEXT NOT NULL DEFAULT 'default',
      customer_name TEXT,
      customer_phone TEXT,
      last_message_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      unread_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      UNIQUE(client_id, platform, platform_user_id, slot)
    );
    INSERT INTO conversations_new (id, client_id, platform, platform_user_id, slot, customer_name, customer_phone, last_message_at, unread_count, status)
      SELECT id, client_id, platform, platform_user_id, 'default', customer_name, customer_phone, last_message_at, unread_count, status FROM conversations;
    DROP TABLE conversations;
    ALTER TABLE conversations_new RENAME TO conversations;
    CREATE INDEX IF NOT EXISTS idx_conv_client ON conversations(client_id);
    CREATE INDEX IF NOT EXISTS idx_conv_platform ON conversations(platform);
  `);
  db.exec('PRAGMA foreign_keys = ON;');
  console.log('[db] migrated: conversations.slot added, unique per (client_id, platform, platform_user_id, slot)');
}

// v2.3: human-handover flag — the AI can request a human ([NEEDS_HUMAN]
// contract); operators clear it when they take over. No UI change: the
// flag travels over the existing SSE broadcast as `conversation:flag`.
if (!columnExists('conversations', 'needs_human')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN needs_human INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE conversations ADD COLUMN needs_human_reason TEXT`);
  console.log('[db] migrated: conversations.needs_human added');
}

// v2.4: knowledge categories — the business-context hub (return policy,
// shipping, product info, FAQs, marketing…). Lets the prompt group entries
// by category so the AI treats policies as policies, not trivia.
if (!columnExists('knowledge', 'category')) {
  db.exec(`ALTER TABLE knowledge ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
  console.log('[db] migrated: knowledge.category added');
}

// v2.1: webhook idempotency — external platform message ids (Meta mid,
// Telegram message_id, WhatsApp id) let us ignore duplicate deliveries.
if (!columnExists('messages', 'external_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN external_id TEXT');
  console.log('[db] migrated: messages.external_id added');
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
  ON messages(conversation_id, external_id) WHERE external_id IS NOT NULL`);

// v2.1: order idempotency keys — safe client retries / double-clicks.
if (!columnExists('orders', 'idempotency_key')) {
  db.exec('ALTER TABLE orders ADD COLUMN idempotency_key TEXT');
  console.log('[db] migrated: orders.idempotency_key added');
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem
  ON orders(client_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);

// v2.8: orders history columns — backup/restore (and future code) stores the
// customer snapshot + subtotal directly on the order row, so history survives
// even when the linked conversation is gone. NOTE: the payment columns below
// were never added by any migration — a FRESH database could not create orders
// at all (createOrder INSERTs them). This block heals both old and new DBs.
for (const [col, ddl] of [
  ['delivery_charge_bdt', 'REAL NOT NULL DEFAULT 0'],
  ['advance_required_bdt', 'REAL NOT NULL DEFAULT 0'],
  ['advance_paid_bdt', 'REAL NOT NULL DEFAULT 0'],
  ['transaction_id', 'TEXT'],
  ['payment_status', "TEXT NOT NULL DEFAULT 'pending'"],
  ['customer_name', 'TEXT'],
  ['customer_phone', 'TEXT'],
  ['subtotal_bdt', 'REAL NOT NULL DEFAULT 0'],
]) {
  if (!columnExists('orders', col)) {
    db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${ddl}`);
    console.log(`[db] migrated: orders.${col} added`);
  }
}

// v2.5: lead intelligence — marketing-agency-style AI scoring on the leads
// sheet. New columns are all nullable/with-defaults so old rows keep working;
// reruns are guarded by columnExists.
for (const [col, ddl] of [
  ['stage', `ALTER TABLE leads ADD COLUMN stage TEXT NOT NULL DEFAULT 'new'`],
  ['score', `ALTER TABLE leads ADD COLUMN score INTEGER NOT NULL DEFAULT 0`],
  ['temperature', `ALTER TABLE leads ADD COLUMN temperature TEXT NOT NULL DEFAULT 'cold'`],
  ['product_affinity_json', `ALTER TABLE leads ADD COLUMN product_affinity_json TEXT NOT NULL DEFAULT '[]'`],
  ['intent_summary', `ALTER TABLE leads ADD COLUMN intent_summary TEXT NOT NULL DEFAULT ''`],
  ['predicted_value_bdt', `ALTER TABLE leads ADD COLUMN predicted_value_bdt REAL NOT NULL DEFAULT 0`],
  ['conversion_probability', `ALTER TABLE leads ADD COLUMN conversion_probability REAL NOT NULL DEFAULT 0`],
  ['next_action', `ALTER TABLE leads ADD COLUMN next_action TEXT NOT NULL DEFAULT ''`],
  ['last_intent_at', `ALTER TABLE leads ADD COLUMN last_intent_at TEXT`],
  ['followup_due_at', `ALTER TABLE leads ADD COLUMN followup_due_at TEXT`],
  ['source', `ALTER TABLE leads ADD COLUMN source TEXT NOT NULL DEFAULT ''`],
  ['verification_state', `ALTER TABLE leads ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'unverified'`],
  ['intel_updated_at', `ALTER TABLE leads ADD COLUMN intel_updated_at TEXT`],
]) {
  if (!columnExists('leads', col)) {
    db.exec(ddl);
    console.log(`[db] migrated: leads.${col} added`);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_leads_intel ON leads(client_id, temperature, score)');

// v2.6: webchat widget — per-client embed key + website URL (for the crawler),
// and source_url on knowledge so website re-syncs can diff by page.
if (!columnExists('clients', 'widget_key')) {
  db.exec('ALTER TABLE clients ADD COLUMN widget_key TEXT');
  console.log('[db] migrated: clients.widget_key added');
}
if (!columnExists('clients', 'website_url')) {
  db.exec('ALTER TABLE clients ADD COLUMN website_url TEXT');
  console.log('[db] migrated: clients.website_url added');
}
if (!columnExists('knowledge', 'source_url')) {
  db.exec('ALTER TABLE knowledge ADD COLUMN source_url TEXT');
  console.log('[db] migrated: knowledge.source_url added');
}
// v2.7: website import jobs — persistent history + per-page detail for the KB UI.
db.exec(`CREATE TABLE IF NOT EXISTS website_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  website_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT, finished_at TEXT,
  discovered INTEGER DEFAULT 0, imported INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0,
  error TEXT
)`);
// v2.8: web-push subscriptions (PWA/app notifications per client login).
db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  user_id INTEGER,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_push_subs_client ON push_subscriptions(client_id)`);
db.exec(`CREATE TABLE IF NOT EXISTS website_import_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  page_url TEXT NOT NULL,
  page_title TEXT,
  category TEXT DEFAULT 'general',
  chars INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_wimp_client ON website_imports(client_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_wimppages_import ON website_import_pages(import_id)');
// Per-client Google Drive OAuth tokens for backups.
db.exec(`CREATE TABLE IF NOT EXISTS client_drive_tokens (
  client_id INTEGER PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER DEFAULT 0,
  email TEXT,
  connected_at TEXT
)`);
// Backfill embed keys for clients created before v2.6.
for (const c of db.prepare('SELECT id FROM clients WHERE widget_key IS NULL').all()) {
  db.prepare('UPDATE clients SET widget_key = ? WHERE id = ?')
    .run(crypto.randomBytes(16).toString('hex'), c.id);
  console.log(`[db] migrated: widget_key backfilled for client ${c.id}`);
}

// v2.7: webchat appearance config — dashboard-customizable widget look.
// Stored per client; the widget fetches it via GET /api/widget/:key/config.
for (const [col, ddl] of [
  ['wc_title', 'TEXT'], ['wc_greeting', 'TEXT'], ['wc_color', 'TEXT'],
  ['wc_position', 'TEXT'], ['wc_avatar', 'TEXT'], ['wc_subtitle', 'TEXT'],
]) {
  if (!columnExists('clients', col)) {
    db.exec(`ALTER TABLE clients ADD COLUMN ${col} ${ddl}`);
    console.log(`[db] migrated: clients.${col} added`);
  }
}

// v2.8: webchat pre-chat intro (name + phone/email before chat starts) and
// the visitor's contact stored on the conversation.
if (!columnExists('clients', 'wc_require_intro')) {
  db.exec('ALTER TABLE clients ADD COLUMN wc_require_intro INTEGER DEFAULT 1');
  console.log('[db] migrated: clients.wc_require_intro added');
}
if (!columnExists('conversations', 'customer_contact')) {
  db.exec('ALTER TABLE conversations ADD COLUMN customer_contact TEXT');
  console.log('[db] migrated: conversations.customer_contact added');
}

// v2.1: DB-backed login sessions (survive process restarts; revocable).
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
`);

const now = () => new Date().toISOString();
const rowid = (info) => Number(info.lastInsertRowid);

// Default lead-field configs per business type.
const DEFAULT_LEAD_FIELDS = {
  physical: [
    { key: 'name',        label: 'Full name',        required: true  },
    { key: 'phone',       label: 'Phone number',     required: true  },
    { key: 'email',       label: 'Email',            required: false },
    { key: 'whatsapp_id', label: 'WhatsApp number',  required: false },
    { key: 'location',    label: 'Delivery location',required: true  },
  ],
  digital: [
    { key: 'name',        label: 'Full name',        required: true  },
    { key: 'phone',       label: 'Phone number',     required: true  },
    { key: 'email',       label: 'Email',            required: false },
    { key: 'whatsapp_id', label: 'WhatsApp number',  required: false },
  ],
};

// ---------------- clients ----------------
function getClients() {
  return db.prepare('SELECT * FROM clients ORDER BY id').all().map(decodeClient);
}
function decodeClient(c) {
  if (!c) return null;
  try { c.lead_fields = JSON.parse(c.lead_fields_json || '[]'); } catch { c.lead_fields = []; }
  return c;
}
function getClient(id) {
  return decodeClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
}
// Webchat widget: resolve a workspace from its public embed key.
function getClientByWidgetKey(widgetKey) {
  if (!widgetKey) return null;
  return decodeClient(db.prepare('SELECT * FROM clients WHERE widget_key = ?').get(String(widgetKey)));
}
function ensureWidgetKey(clientId) {
  const c = db.prepare('SELECT widget_key FROM clients WHERE id = ?').get(clientId);
  if (c && c.widget_key) return c.widget_key;
  const key = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE clients SET widget_key = ? WHERE id = ?').run(key, clientId);
  return key;
}
function setClientWebsite(clientId, url) {
  db.prepare('UPDATE clients SET website_url = ? WHERE id = ?').run(url || null, clientId);
  return getClient(clientId);
}
const WC_APPEARANCE_COLS = ['wc_title', 'wc_greeting', 'wc_color', 'wc_position', 'wc_avatar', 'wc_subtitle'];
function getWebchatAppearance(clientId) {
  const c = db.prepare('SELECT wc_title, wc_greeting, wc_color, wc_position, wc_avatar, wc_subtitle, wc_require_intro FROM clients WHERE id = ?').get(clientId);
  if (!c) return null;
  return {
    title: c.wc_title || null, greeting: c.wc_greeting || null, color: c.wc_color || null,
    position: c.wc_position || null, avatar: c.wc_avatar || null, subtitle: c.wc_subtitle || null,
    require_intro: c.wc_require_intro === null || c.wc_require_intro === undefined ? 1 : Number(c.wc_require_intro),
  };
}
function setWebchatAppearance(clientId, f) {
  const sets = [], params = [];
  const map = { title: 'wc_title', greeting: 'wc_greeting', color: 'wc_color', position: 'wc_position', avatar: 'wc_avatar', subtitle: 'wc_subtitle' };
  for (const [k, col] of Object.entries(map)) {
    if (f[k] !== undefined) { sets.push(`${col} = ?`); params.push(f[k] === '' ? null : f[k]); }
  }
  if (f.require_intro !== undefined) { sets.push('wc_require_intro = ?'); params.push(f.require_intro ? 1 : 0); }
  if (sets.length) { params.push(clientId); db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  return getWebchatAppearance(clientId);
}
function createClient({ name, business_type, lead_fields }) {
  const type = business_type === 'digital' ? 'digital' : 'physical';
  const fields = lead_fields || DEFAULT_LEAD_FIELDS[type];
  const info = db.prepare(
    'INSERT INTO clients (name, business_type, lead_fields_json, widget_key, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, type, JSON.stringify(fields), crypto.randomBytes(16).toString('hex'), now());
  return getClient(rowid(info));
}
function updateClient(id, { name, business_type, lead_fields }) {
  const c = getClient(id);
  if (!c) return null;
  const sets = [], params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (business_type !== undefined) { sets.push('business_type = ?'); params.push(business_type); }
  if (lead_fields !== undefined) { sets.push('lead_fields_json = ?'); params.push(JSON.stringify(lead_fields)); }
  if (sets.length) { params.push(id); db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  return getClient(id);
}
function deleteClient(id) {
  // No FK from products/orders to clients (added via ALTER), so cascade manually
  // in one transaction — never leave orphan workspace data behind.
  db.exec('BEGIN IMMEDIATE');
  try {
    const cids = db.prepare('SELECT id FROM conversations WHERE client_id = ?').all(id).map(r => r.id);
    if (cids.length) {
      const ph = cids.map(() => '?').join(',');
      // orders reference conversations(conversation_id), so delete them first
      db.prepare(`DELETE FROM orders WHERE conversation_id IN (${ph})`).run(...cids);
      db.prepare(`DELETE FROM messages WHERE conversation_id IN (${ph})`).run(...cids);
      db.prepare(`DELETE FROM conversations WHERE id IN (${ph})`).run(...cids);
    }
    for (const t of ['orders', 'products', 'leads', 'knowledge', 'channel_sessions', 'meta_pages']) {
      db.prepare(`DELETE FROM ${t} WHERE client_id = ?`).run(id);
    }
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------------- conversations (client-scoped) ----------------
function findConversation(clientId, platform, platformUserId, slot = 'default') {
  return db.prepare(
    'SELECT * FROM conversations WHERE client_id = ? AND platform = ? AND platform_user_id = ? AND slot = ?'
  ).get(clientId, platform, platformUserId, slot);
}
function upsertConversation({ clientId, platform, platformUserId, customerName, customerPhone, customerContact, slot = 'default', bumpUnread = true }) {
  const cid = clientId || 1;
  const sl = slot || 'default';
  const existing = findConversation(cid, platform, platformUserId, sl);
  if (existing) {
    // bumpUnread=false is for metadata-only fills (e.g. deferred Meta display-name
    // lookup): the name is COALESCE-filled without inflating the unread badge.
    const bump = bumpUnread ? 'unread_count = unread_count + 1,' : '';
    db.prepare(
      `UPDATE conversations SET last_message_at = ?, ${bump}
       customer_name = COALESCE(?, customer_name), customer_phone = COALESCE(?, customer_phone),
       customer_contact = COALESCE(?, customer_contact)
       WHERE id = ?`
    ).run(now(), customerName || null, customerPhone || null, customerContact || null, existing.id);
    return { ...existing, unread_count: existing.unread_count + (bumpUnread ? 1 : 0) };
  }
  const info = db.prepare(
    `INSERT INTO conversations (client_id, platform, platform_user_id, slot, customer_name, customer_phone, customer_contact, last_message_at, unread_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(cid, platform, platformUserId, sl, customerName || null, customerPhone || null, customerContact || null, now());
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(rowid(info));
}

function addMessage(conversationId, direction, text, rawJson, createdAt, externalId) {
  const ts = createdAt || now();
  const info = db.prepare(
    `INSERT INTO messages (conversation_id, direction, text, created_at, raw_json, external_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(conversationId, direction, text, ts, rawJson || null, externalId || null);
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, conversationId);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(rowid(info));
}

function findMessageByExternalId(conversationId, externalId) {
  if (!externalId) return null;
  return db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND external_id = ?')
    .get(conversationId, externalId);
}

function getConversations({ clientId, platform, q } = {}) {
  let sql = `SELECT c.*, (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
             FROM conversations c WHERE 1=1`;
  const params = [];
  if (clientId) { sql += ' AND c.client_id = ?'; params.push(clientId); }
  if (platform) { sql += ' AND c.platform = ?'; params.push(platform); }
  if (q) { sql += ' AND (c.customer_name LIKE ? OR c.customer_phone LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY c.last_message_at DESC LIMIT 500';
  return db.prepare(sql).all(...params);
}

function getConversation(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}
function getMessages(conversationId) {  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(conversationId);
}

function getRecentMessages(conversationId, limit = 10) {
  return db.prepare(
    'SELECT id, direction, text, raw_json FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
  ).all(conversationId, limit).reverse();
}

function markRead(conversationId) {
  db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conversationId);
}

// Human handover ([NEEDS_HUMAN] contract): AI sets the flag, an operator
// clears it when they take over the conversation.
function flagNeedsHuman(conversationId, reason) {
  db.prepare('UPDATE conversations SET needs_human = 1, needs_human_reason = ? WHERE id = ?')
    .run(reason || null, conversationId);
}
function clearNeedsHuman(conversationId) {
  db.prepare('UPDATE conversations SET needs_human = 0, needs_human_reason = NULL WHERE id = ?')
    .run(conversationId);
}

// ---------------- products (client-scoped) ----------------
function findProductBySku(sku, clientId) {
  let sql = 'SELECT * FROM products WHERE UPPER(sku) = UPPER(?)';
  const params = [sku];
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  return db.prepare(sql).get(...params);
}

function searchProducts(q, clientId) {
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  if (q) { sql += ' AND (name LIKE ? OR sku LIKE ? OR category LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY name';
  return db.prepare(sql).all(...params);
}

function getProduct(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function addProduct({ clientId, sku, name, category, price_bdt, stock, image_url }) {
  const info = db.prepare(
    'INSERT INTO products (client_id, sku, name, category, price_bdt, stock, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(clientId || 1, sku, name, category || null, price_bdt, stock || 0, image_url || null);
  return getProduct(rowid(info));
}

function updateProduct(id, { price_bdt, stock, name, sku, category, image_url }) {
  const sets = [], params = [];
  if (price_bdt !== undefined) { sets.push('price_bdt = ?'); params.push(price_bdt); }
  if (stock !== undefined) { sets.push('stock = ?'); params.push(stock); }
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (sku !== undefined) { sets.push('sku = ?'); params.push(sku); }
  if (category !== undefined) { sets.push('category = ?'); params.push(category); }
  if (image_url !== undefined) { sets.push('image_url = ?'); params.push(image_url); }
  if (!sets.length) return getProduct(id);
  params.push(id);
  db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProduct(id);
}

function deleteProduct(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
}

// Ownership-checked variants for tenant mutations: every mutation first
// verifies the row belongs to the caller's workspace (IDOR protection).
// Returns null when the row doesn't exist OR belongs to another client.
function updateProductOwned(id, clientId, fields) {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!p) return null;
  return updateProduct(id, fields);
}
function deleteProductOwned(id, clientId) {
  return db.prepare('DELETE FROM products WHERE id = ? AND client_id = ?').run(id, clientId).changes;
}

// ---------------- orders (client-scoped) ----------------
function createOrder(conversationId, items, idempotencyKey, payment) {
  // items: [{sku, qty}] — validated, stock decremented atomically.
  // idempotencyKey: when given, a repeated call returns the original order
  // instead of creating a duplicate (safe retries / double-clicks).
  // payment: { deliveryCharge, advanceRequired, advancePaid, transactionId, paymentStatus }
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  const clientId = conv ? conv.client_id : 1;
  const key = (idempotencyKey && String(idempotencyKey).trim()) || null;
  if (key) {
    const existing = db.prepare('SELECT * FROM orders WHERE client_id = ? AND idempotency_key = ?')
      .get(clientId, key);
    if (existing) { existing.replay = true; return existing; }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const lines = [];
    let total = 0;
    for (const { sku, qty } of items) {
      const q = parseInt(qty, 10);
      if (!sku || !Number.isFinite(q) || q < 1 || q > 10000) {
        throw new Error(`Invalid order item: sku=${sku} qty=${qty}`);
      }
      const p = findProductBySku(sku, clientId);
      if (!p) throw new Error(`Unknown SKU: ${sku}`);
      if ((p.stock || 0) < q) throw new Error(`Insufficient stock for ${p.sku} (have ${p.stock}, need ${q})`);
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(q, p.id);
      lines.push({ sku: p.sku, name: p.name, qty: q, unit_price: p.price_bdt, line_total: p.price_bdt * q });
      total += p.price_bdt * q;
    }
    const info = db.prepare(
      'INSERT INTO orders (client_id, conversation_id, items_json, total_bdt, idempotency_key, created_at, delivery_charge_bdt, advance_required_bdt, advance_paid_bdt, transaction_id, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(clientId, conversationId, JSON.stringify(lines), total, key, now(),
      (payment && payment.deliveryCharge) || 0, (payment && payment.advanceRequired) || 0,
      (payment && payment.advancePaid) || 0, (payment && payment.transactionId) || null,
      (payment && payment.paymentStatus) || 'pending');
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(rowid(info));
    db.exec('COMMIT');
    return order;
  } catch (err) {
    db.exec('ROLLBACK');
    // Lost race on the idempotency key: the other request won — return its order.
    if (key && /UNIQUE constraint failed/i.test(err.message || '')) {
      const existing = db.prepare('SELECT * FROM orders WHERE client_id = ? AND idempotency_key = ?')
        .get(clientId, key);
      if (existing) { existing.replay = true; return existing; }
    }
    throw err;
  }
}

function getOrdersByConversation(conversationId) {
  return db.prepare('SELECT * FROM orders WHERE conversation_id = ? ORDER BY id DESC').all(conversationId);
}

function getOrders(clientId) {
  let sql = 'SELECT o.*, c.customer_name, c.platform FROM orders o LEFT JOIN conversations c ON c.id = o.conversation_id WHERE 1=1';
  const params = [];
  if (clientId) { sql += ' AND o.client_id = ?'; params.push(clientId); }
  sql += ' ORDER BY o.id DESC LIMIT 100';
  return db.prepare(sql).all(...params);
}

// ---------------- leads ----------------
// Normalize phone digits: Bengali/Arabic-Indic -> ASCII, strip spaces/dashes.
// A number typed as "০১৭১২৩৪৫৬৭৮" must be stored searchable as "01712345678".
function normalizePhone(p) {
  if (p == null) return p;
  const digitMap = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
  return String(p).replace(/[০-৯٠-٩]/g, d => digitMap[d] || d).replace(/[\s\-()]/g, '');
}

function upsertLead({ clientId, platform, platformUserId, fields = {} }) {
  const existing = db.prepare(
    'SELECT * FROM leads WHERE client_id = ? AND platform = ? AND platform_user_id = ?'
  ).get(clientId, platform, platformUserId);
  // Normalize phone digits on every write path (AI capture, dashboard edits).
  if (fields.phone) fields.phone = normalizePhone(fields.phone);
  if (fields.whatsapp_id) fields.whatsapp_id = normalizePhone(fields.whatsapp_id);
  const cols = ['name', 'phone', 'email', 'whatsapp_id', 'location'];
  if (existing) {
    const sets = [], params = [];
    for (const c of cols) {
      const v = fields[c];
      if (v !== undefined && v !== null && String(v).trim() !== '' && !existing[c]) {
        sets.push(`${c} = ?`); params.push(String(v).trim());
      }
    }
    // Auto-advance: lead -> user when name+phone known
    const name = fields.name || existing.name;
    const phone = fields.phone || existing.phone;
    let status = existing.status;
    if (status === 'lead' && name && phone) status = 'user';
    if (status !== existing.status) { sets.push('status = ?'); params.push(status); }
    if (sets.length) {
      sets.push('updated_at = ?'); params.push(now()); params.push(existing.id);
      db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(existing.id);
  }
  const vals = cols.map(c => {
    const v = fields[c];
    return (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : null;
  });
  const status = (vals[0] && vals[1]) ? 'user' : 'lead';
  const info = db.prepare(
    `INSERT INTO leads (client_id, platform, platform_user_id, name, phone, email, whatsapp_id, location, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(clientId, platform, platformUserId, ...vals, status, now(), now());
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(rowid(info));
}

function getLeads({ clientId, status, q, temperature, stage } = {}) {
  let sql = 'SELECT * FROM leads WHERE 1=1';
  const params = [];
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (temperature) { sql += ' AND temperature = ?'; params.push(temperature); }
  if (stage) { sql += ' AND stage = ?'; params.push(stage); }
  if (q) { sql += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR whatsapp_id LIKE ? OR location LIKE ? OR notes LIKE ? OR intent_summary LIKE ?)'; const like = `%${q}%`; params.push(like, like, like, like, like, like, like); }
  sql += ' ORDER BY updated_at DESC LIMIT 500';
  return db.prepare(sql).all(...params);
}

function getLead(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

// Lookup by conversation identity (used by the lead-capture gate in ai.js).
function getLeadByPlatform(clientId, platform, platformUserId) {
  return db.prepare(
    'SELECT * FROM leads WHERE client_id = ? AND platform = ? AND platform_user_id = ?'
  ).get(clientId, platform, platformUserId) || null;
}

function updateLead(id, fields) {
  const allowed = ['name', 'phone', 'email', 'whatsapp_id', 'location', 'status', 'notes'];
  if (fields.phone) fields.phone = normalizePhone(fields.phone);
  if (fields.whatsapp_id) fields.whatsapp_id = normalizePhone(fields.whatsapp_id);
  const sets = [], params = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); params.push(fields[k]); }
  }
  // Manual dashboard edits: stage/temperature are operator-controlled.
  // Validated against the intel lifecycle so the UI can never write junk.
  if (fields.stage !== undefined && LEAD_STAGES.includes(fields.stage)) {
    sets.push('stage = ?'); params.push(fields.stage);
    sets.push('status = ?'); params.push(stageToStatus(fields.stage, db.prepare('SELECT * FROM leads WHERE id = ?').get(id)));
  }
  if (fields.temperature !== undefined && LEAD_TEMPS.includes(fields.temperature)) {
    sets.push('temperature = ?'); params.push(fields.temperature);
  }
  if (!sets.length) return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  sets.push('updated_at = ?'); params.push(now()); params.push(id);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

function markLeadConfirmed(clientId, platform, platformUserId) {
  const lead = db.prepare(
    'SELECT * FROM leads WHERE client_id = ? AND platform = ? AND platform_user_id = ?'
  ).get(clientId, platform, platformUserId);
  if (!lead) return;
  // A confirmed order is ground truth: status AND intel stage move together so
  // the Customers segment, the intel engine and the dashboard never disagree.
  db.prepare(
    `UPDATE leads SET status = 'confirmed', stage = 'converted', temperature = 'hot',
      score = CASE WHEN score < 95 THEN 95 ELSE score END,
      conversion_probability = 1, last_intent_at = ?, intel_updated_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(now(), now(), now(), lead.id);
}
// Ownership-checked variant (IDOR protection).
function updateLeadOwned(id, clientId, fields) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!lead) return null;
  return updateLead(id, fields);
}

// ---------------- lead intelligence ----------------
// Lifecycle stages used by the AI intel engine. The legacy `status` column
// keeps working: every intel write maps stage -> status so old flows
// (lead -> user -> confirmed) never break.
const LEAD_STAGES = ['new', 'contacted', 'qualified', 'intent', 'verified', 'converted', 'lost', 'dormant'];
const LEAD_TEMPS = ['hot', 'warm', 'cold'];
const LEAD_VERIFY = ['unverified', 'partial', 'verified'];

function stageToStatus(stage, lead) {
  if (stage === 'converted') return 'confirmed';
  if (lead && lead.name && lead.phone) return 'user';
  return 'lead';
}

// Writes AI intel fields; validates + clamps everything. Never throws on
// bad input — it sanitizes. `intel` may carry any subset of fields.
function updateLeadIntel(id, intel = {}) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) return null;
  const sets = [], params = [];
  const set = (col, val) => { sets.push(`${col} = ?`); params.push(val); };

  // Ground-truth guard: once a lead is converted (real order in the DB), the AI
  // intel engine may never downgrade it back to a prospect stage.
  const intelStage = (intel.stage !== undefined && LEAD_STAGES.includes(intel.stage)) ? intel.stage : null;
  if (lead.stage === 'converted' && intelStage && intelStage !== 'converted') {
    intel.stage = 'converted';
  }
  // A converted lead is always hot — never let intel mark a buyer 'cold'.
  if (lead.stage === 'converted' && intel.temperature && intel.temperature !== 'hot') {
    intel.temperature = 'hot';
  }
  if (intel.stage !== undefined && LEAD_STAGES.includes(intel.stage)) set('stage', intel.stage);
  if (intel.score !== undefined) set('score', Math.max(0, Math.min(100, Math.round(Number(intel.score) || 0))));
  if (intel.temperature !== undefined && LEAD_TEMPS.includes(intel.temperature)) set('temperature', intel.temperature);
  if (intel.product_affinity_json !== undefined) {
    let v = '[]';
    try {
      const a = JSON.parse(intel.product_affinity_json);
      v = JSON.stringify(Array.isArray(a) ? a.slice(0, 5) : []);
    } catch { /* keep [] */ }
    set('product_affinity_json', v);
  }
  if (intel.intent_summary !== undefined) set('intent_summary', String(intel.intent_summary).slice(0, 500));
  if (intel.predicted_value_bdt !== undefined) set('predicted_value_bdt', Math.max(0, Number(intel.predicted_value_bdt) || 0));
  if (intel.conversion_probability !== undefined) {
    set('conversion_probability', Math.max(0, Math.min(1, Number(intel.conversion_probability) || 0)));
  }
  if (intel.next_action !== undefined) set('next_action', String(intel.next_action).slice(0, 500));
  if (intel.last_intent_at !== undefined) set('last_intent_at', intel.last_intent_at || null);
  if (intel.followup_due_at !== undefined) set('followup_due_at', intel.followup_due_at || null);
  if (intel.source !== undefined) set('source', String(intel.source).slice(0, 80));
  if (intel.verification_state !== undefined && LEAD_VERIFY.includes(intel.verification_state)) {
    set('verification_state', intel.verification_state);
  }
  // Keep legacy status in sync with the intel stage.
  const effStage = (intel.stage !== undefined && LEAD_STAGES.includes(intel.stage)) ? intel.stage : lead.stage;
  const newStatus = stageToStatus(effStage, { ...lead, ...intel });
  if (newStatus !== lead.status && lead.status !== 'confirmed') set('status', newStatus);

  set('intel_updated_at', now());
  set('updated_at', now());
  params.push(id);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

// Leads whose intel is missing or older than `maxAgeMs`, most-recently-active
// first. Tenant-scoped; `clientId` null = all tenants (backfill only).
function getStaleIntelLeads(limit = 20, { maxAgeMs = 6 * 3600 * 1000, clientId = null } = {}) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  let sql = `SELECT * FROM leads WHERE (intel_updated_at IS NULL OR intel_updated_at <= ?)`;
  const params = [cutoff];
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function getLeadIntelStats(clientId) {
  const by = (col) => {
    const rows = db.prepare(
      `SELECT ${col} AS k, COUNT(*) AS n FROM leads WHERE client_id = ? GROUP BY ${col}`
    ).all(clientId);
    const o = {};
    for (const r of rows) o[r.k || 'unknown'] = r.n;
    return o;
  };
  const total = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE client_id = ?').get(clientId).n;
  return { total, byStage: by('stage'), byTemperature: by('temperature') };
}

// ---------------- FB comment automation ----------------
function logComment({ clientId, pageId, commentId, postId, commenterId, commenterName, commentText, replyText, dmSent }) {
  db.prepare(`INSERT OR IGNORE INTO fb_comment_log
    (client_id, page_id, comment_id, post_id, commenter_id, commenter_name, comment_text, reply_text, dm_sent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(clientId, pageId, commentId, postId || null, commenterId || null,
      commenterName || null, commentText || null, replyText || null, dmSent ? 1 : 0, now());
}
function commentAlreadyHandled(commentId) {
  return !!db.prepare('SELECT id FROM fb_comment_log WHERE comment_id = ?').get(commentId);
}
// Claim-first idempotency: INSERT OR IGNORE before doing any work. Returns true
// only when THIS call won the claim (a concurrent duplicate gets false).
function claimComment({ clientId, pageId, commentId, postId, commenterId, commenterName, commentText }) {
  const info = db.prepare(`INSERT OR IGNORE INTO fb_comment_log
    (client_id, page_id, comment_id, post_id, commenter_id, commenter_name, comment_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(clientId, pageId, commentId, postId || null, commenterId || null,
      commenterName || null, commentText || null, now());
  return info.changes === 1;
}
function updateCommentResult(commentId, { replyText, dmSent }) {
  db.prepare('UPDATE fb_comment_log SET reply_text = ?, dm_sent = ? WHERE comment_id = ?')
    .run(replyText || null, dmSent ? 1 : 0, commentId);
}
function getRecentComments(clientId, limit) {
  return db.prepare('SELECT * FROM fb_comment_log WHERE client_id = ? ORDER BY id DESC LIMIT ?')
    .all(clientId, limit || 50);
}
// Per-client comment automation config, stored in settings as comment.<key>.<clientId>
function getCommentConfig(clientId) {
  const g = (k, fb) => getSetting(`comment.${k}.${clientId}`, fb);
  let rules = [];
  try { rules = JSON.parse(g('rules', '[]')) || []; } catch {}
  return {
    // Standing rule (2026-10-01): inbox messages ONLY. Comment automation
    // (public replies + DM follow-ups) is OFF by default — enable per-client
    // from the dashboard only when explicitly wanted.
    autoReply: g('autoreply', '0') === '1',
    dmFollowup: g('dm', '0') === '1',
    likeComment: g('like', '0') === '1',
    rules: Array.isArray(rules) ? rules : [],
  };
}
function setCommentConfig(clientId, cfg) {
  if (cfg.autoReply !== undefined) setSetting(`comment.autoreply.${clientId}`, cfg.autoReply ? '1' : '0');
  if (cfg.dmFollowup !== undefined) setSetting(`comment.dm.${clientId}`, cfg.dmFollowup ? '1' : '0');
  if (cfg.likeComment !== undefined) setSetting(`comment.like.${clientId}`, cfg.likeComment ? '1' : '0');
  if (cfg.rules !== undefined) {
    const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).slice(0, 50).map(r => ({
      keywords: String(r.keywords || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 10),
      reply: String(r.reply || '').slice(0, 500),
    })).filter(r => r.keywords.length && r.reply);
    setSetting(`comment.rules.${clientId}`, JSON.stringify(rules));
  }
  return getCommentConfig(clientId);
}
const KNOWLEDGE_CATEGORIES = ['policy', 'shipping', 'product', 'faq', 'marketing', 'general'];
function normCategory(c) {
  c = String(c || 'general').toLowerCase().trim();
  return KNOWLEDGE_CATEGORIES.includes(c) ? c : 'general';
}
function addKnowledge(clientId, { title, content, category, source_url }) {
  const info = db.prepare(
    'INSERT INTO knowledge (client_id, title, content, category, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(clientId, title, content, normCategory(category), source_url || null, now());
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(rowid(info));
}
// Website importer: one entry per source URL — re-sync updates the same row.
function upsertKnowledgeBySource(clientId, { title, content, category, source_url }) {
  const existing = db.prepare(
    'SELECT * FROM knowledge WHERE client_id = ? AND source_url = ?'
  ).get(clientId, source_url);
  if (existing) {
    return updateKnowledge(existing.id, { title, content, category });
  }
  return addKnowledge(clientId, { title, content, category, source_url });
}
function countKnowledgeBySourcePrefix(clientId, prefix) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM knowledge WHERE client_id = ? AND source_url LIKE ?'
  ).get(clientId, prefix + '%').n;
}
function getKnowledge(clientId) {
  return db.prepare('SELECT * FROM knowledge WHERE client_id = ? ORDER BY id').all(clientId);
}
function getKnowledgeById(id) {
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id);
}
function updateKnowledge(id, { title, content, category }) {
  const sets = [], params = [];
  if (title !== undefined) { sets.push('title = ?'); params.push(title); }
  if (content !== undefined) { sets.push('content = ?'); params.push(content); }
  if (category !== undefined) { sets.push('category = ?'); params.push(normCategory(category)); }
  if (sets.length) { params.push(id); db.prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id);
}
function deleteKnowledge(id) {
  db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
}

// ---- website import jobs (KB: website import history + per-page detail) ----
function createWebsiteImport(clientId, websiteUrl) {
  const info = db.prepare(
    'INSERT INTO website_imports (client_id, website_url, status, started_at) VALUES (?, ?, \'running\', ?)'
  ).run(clientId, websiteUrl, now());
  return db.prepare('SELECT * FROM website_imports WHERE id = ?').get(rowid(info));
}
function getLatestWebsiteImport(clientId) {
  return db.prepare('SELECT * FROM website_imports WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(clientId);
}
function listWebsiteImports(clientId, limit = 10) {
  return db.prepare('SELECT * FROM website_imports WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(clientId, limit);
}
function finishWebsiteImport(id, { status, discovered, imported, skipped, error }) {
  db.prepare(
    'UPDATE website_imports SET status = ?, finished_at = ?, discovered = ?, imported = ?, skipped = ?, error = ? WHERE id = ?'
  ).run(status, now(), discovered || 0, imported || 0, skipped || 0, error || null, id);
  return db.prepare('SELECT * FROM website_imports WHERE id = ?').get(id);
}
function addWebsiteImportPage(importId, clientId, { page_url, page_title, category, chars, status, note }) {
  db.prepare(
    'INSERT INTO website_import_pages (import_id, client_id, page_url, page_title, category, chars, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(importId, clientId, page_url, page_title || null, normCategory(category), chars || 0, status, note || null, now());
}
function listWebsiteImportPages(importId) {
  return db.prepare('SELECT * FROM website_import_pages WHERE import_id = ? ORDER BY id').all(importId);
}
function countWebsiteImportPages(importId) {
  const r = db.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END) AS imp, SUM(CASE WHEN status != 'imported' THEN 1 ELSE 0 END) AS skp FROM website_import_pages WHERE import_id = ?"
  ).get(importId);
  return { processed: r.n || 0, imported: r.imp || 0, skipped: r.skp || 0 };
}
// Ownership-checked variants (IDOR protection).
function updateKnowledgeOwned(id, clientId, fields) {
  const k = db.prepare('SELECT * FROM knowledge WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!k) return null;
  return updateKnowledge(id, fields);
}
function deleteKnowledgeOwned(id, clientId) {
  return db.prepare('DELETE FROM knowledge WHERE id = ? AND client_id = ?').run(id, clientId).changes;
}

// ---------------- channel sessions (multi-account: slot per channel) ----------------
function getChannelSession(clientId, channel, slot = 'default') {
  return db.prepare('SELECT * FROM channel_sessions WHERE client_id = ? AND channel = ? AND slot = ?').get(clientId, channel, slot);
}
function listChannelSessions(clientId, channel = null) {
  if (channel) {
    return db.prepare('SELECT * FROM channel_sessions WHERE client_id = ? AND channel = ? ORDER BY slot').all(clientId, channel);
  }
  return db.prepare('SELECT * FROM channel_sessions WHERE client_id = ? ORDER BY channel, slot').all(clientId);
}
function setChannelSession(clientId, channel, { sessionJson, status, label }, slot = 'default') {
  const existing = getChannelSession(clientId, channel, slot);
  if (existing) {
    db.prepare('UPDATE channel_sessions SET session_json = COALESCE(?, session_json), status = ?, label = COALESCE(?, label), updated_at = ? WHERE id = ?')
      .run(sessionJson !== undefined ? sessionJson : null, status || existing.status, label || null, now(), existing.id);
  } else {
    db.prepare('INSERT INTO channel_sessions (client_id, channel, slot, session_json, status, label, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(clientId, channel, slot, sessionJson || null, status || 'disconnected', label || null, now());
  }
  return getChannelSession(clientId, channel, slot);
}
function deleteChannelSession(clientId, channel, slot = 'default') {
  return db.prepare('DELETE FROM channel_sessions WHERE client_id = ? AND channel = ? AND slot = ?').run(clientId, channel, slot).changes;
}
// Pause / resume AI auto-replies for one gateway account. Inbound keeps flowing
// into the inbox; the AI just stays silent until resumed. Sticky across
// disconnects and restarts (it's metadata, not socket state).
function setAiPaused(clientId, channel, slot = 'default', paused = true) {
  const existing = getChannelSession(clientId, channel, slot);
  if (existing) {
    db.prepare('UPDATE channel_sessions SET ai_paused = ?, updated_at = ? WHERE id = ?')
      .run(paused ? 1 : 0, now(), existing.id);
  } else {
    db.prepare(`INSERT INTO channel_sessions (client_id, channel, slot, session_json, status, label, ai_paused, updated_at)
                VALUES (?, ?, ?, NULL, 'disconnected', NULL, ?, ?)`)
      .run(clientId, channel, slot, paused ? 1 : 0, now());
  }
  return getChannelSession(clientId, channel, slot);
}
function isAiPaused(clientId, channel, slot = 'default') {
  const s = getChannelSession(clientId, channel, slot);
  return Boolean(s && s.ai_paused);
}
// Which client owns a connected live channel? Falls back to client 1.
function clientForChannel(channel) {
  const row = db.prepare(
    "SELECT client_id FROM channel_sessions WHERE channel = ? AND status = 'connected' ORDER BY updated_at DESC LIMIT 1"
  ).get(channel);
  if (row) return row.client_id;
  const first = db.prepare('SELECT id FROM clients ORDER BY id LIMIT 1').get();
  return first ? first.id : 1;
}

// ---------------- users / settings / audit (SaaS auth) ----------------
function createUser({ username, passwordHash, role, clientId }) {
  const r = db.prepare(`INSERT INTO users (username, password_hash, role, client_id, active)
    VALUES (?, ?, ?, ?, 1)`).run(username, passwordHash, role || 'client', clientId || null);
  return getUserById(r.lastInsertRowid);
}
function getUserById(id) {
  return db.prepare(`SELECT u.*, c.name AS client_name FROM users u
    LEFT JOIN clients c ON c.id = u.client_id WHERE u.id = ?`).get(id);
}
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(username);
}
function getUsers() {
  return db.prepare(`SELECT u.id, u.username, u.role, u.client_id, u.active, u.created_at, c.name AS client_name
    FROM users u LEFT JOIN clients c ON c.id = u.client_id ORDER BY u.id`).all();
}
function setUserPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}
function setUserActive(id, active) {
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}
// ---------------- login sessions (DB-backed: survive restarts, revocable) ----------------
function createSession(id, userId, expiresAt) {
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
}
function getSession(id) {
  return db.prepare(`SELECT s.id AS sid, s.user_id, s.expires_at,
      u.username, u.role, u.client_id, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(id);
}
function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
function deleteUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
function pruneSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
}
function close() {
  db.close();
}
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, now());
}
function addAudit(actor, event, target, ip) {
  try {
    db.prepare('INSERT INTO audit_log (actor, event, target, ip) VALUES (?, ?, ?, ?)')
      .run(actor || null, event, target || null, ip || null);
  } catch {}
}
function getAudit(limit) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit || 100);
}
function adminOverview() {
  const users = db.prepare("SELECT COUNT(*) c FROM users WHERE active = 1").get().c;
  const workspaces = db.prepare('SELECT COUNT(*) c FROM clients').get().c;
  const channels = db.prepare('SELECT COUNT(*) c FROM channel_sessions').get().c
    + db.prepare('SELECT COUNT(*) c FROM meta_pages').get().c;
  const connected = db.prepare("SELECT COUNT(*) c FROM channel_sessions WHERE status = 'connected'").get().c
    + db.prepare("SELECT COUNT(*) c FROM meta_pages WHERE status = 'connected'").get().c;
  const errored = db.prepare("SELECT COUNT(*) c FROM channel_sessions WHERE status = 'error'").get().c;
  return { workspaces, activeUsers: users, channels, connected, errored };
}
function connectedResources() {
  const rows = db.prepare(`SELECT cs.channel, cs.status, cs.updated_at,
      c.name AS workspace, c.id AS client_id, NULL AS account
    FROM channel_sessions cs JOIN clients c ON c.id = cs.client_id`).all();
  const meta = db.prepare(`SELECT mp.channel, mp.status, mp.updated_at,
      cl.name AS workspace, cl.id AS client_id,
      CASE WHEN mp.channel = 'instagram' THEN '@' || COALESCE(mp.ig_username, mp.page_id)
           ELSE mp.page_name END AS account
    FROM meta_pages mp JOIN clients cl ON cl.id = mp.client_id`).all();
  return [...rows, ...meta].map(r => ({
    channel: r.channel, account: r.account || r.workspace, workspace: r.workspace,
    status: r.status, lastSeen: r.updated_at,
  }));
}
function saveMetaPage(clientId, channel, { pageId, pageName, pageAccessToken, igUserId, igUsername }) {
  const existing = db.prepare('SELECT * FROM meta_pages WHERE client_id = ? AND channel = ?').get(clientId, channel);
  if (existing) {
    db.prepare(`UPDATE meta_pages SET page_id = ?, page_name = ?, page_access_token = ?,
      ig_user_id = COALESCE(?, ig_user_id), ig_username = COALESCE(?, ig_username),
      status = 'connected', updated_at = ? WHERE id = ?`)
      .run(pageId, pageName || null, pageAccessToken, igUserId || null, igUsername || null, now(), existing.id);
  } else {
    db.prepare(`INSERT INTO meta_pages (client_id, channel, page_id, page_name, page_access_token, ig_user_id, ig_username, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?)`)
      .run(clientId, channel, pageId, pageName || null, pageAccessToken, igUserId || null, igUsername || null, now());
  }
  return db.prepare('SELECT * FROM meta_pages WHERE client_id = ? AND channel = ?').get(clientId, channel);
}
function getMetaPages(clientId) {
  return db.prepare('SELECT * FROM meta_pages WHERE client_id = ?').all(clientId);
}
// Route a webhook entry to its owning client: entry.id is the Page ID (object=page)
// or the IG user ID (object=instagram). Never exposes the token.
function findClientByMetaPage(externalId) {
  const row = db.prepare(`SELECT client_id, channel, page_id, page_name, ig_user_id, ig_username FROM meta_pages
    WHERE (page_id = ? OR ig_user_id = ?) AND status = 'connected' LIMIT 1`).get(externalId, externalId);
  return row || null;
}
function deleteMetaPage(clientId, channel) {
  db.prepare('DELETE FROM meta_pages WHERE client_id = ? AND channel = ?').run(clientId, channel);
}
// All connected messenger pages (for boot-time feed resubscription). Tokens stay server-side.
function getAllConnectedMetaPages() {
  return db.prepare(`SELECT client_id, channel, page_id, page_name, page_access_token
    FROM meta_pages WHERE channel = 'messenger' AND status = 'connected'`).all();
}

// ---------------- stats ----------------
function getStats(clientId) {
  let wf = '', params = [];
  if (clientId) { wf = 'WHERE client_id = ?'; params = [clientId]; }
  const perPlatform = db.prepare(
    `SELECT platform, COUNT(*) AS conversations, COALESCE(SUM(unread_count),0) AS unread FROM conversations ${wf} GROUP BY platform`
  ).all(...params);
  const totalUnread = db.prepare(`SELECT COALESCE(SUM(unread_count),0) AS u FROM conversations ${wf}`).get(...params).u;
  const today = db.prepare(
    `SELECT COUNT(*) AS orders_today, COALESCE(SUM(total_bdt),0) AS revenue_today
     FROM orders ${wf ? wf + ' AND' : 'WHERE'} date(created_at) = date('now')`
  ).get(...params);
  const leadsByStatus = db.prepare(
    `SELECT status, COUNT(*) AS n FROM leads ${clientId ? 'WHERE client_id = ?' : ''} GROUP BY status`
  ).all(...(clientId ? [clientId] : []));
  return { perPlatform, totalUnread, ordersToday: today.orders_today, revenueToday: today.revenue_today, leadsByStatus };
}

function globalStats() {
  const clients = db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
  const convs = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  const orders = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total_bdt),0) AS rev FROM orders').get();
  return { clients, conversations: convs, orders: orders.n, revenue: orders.rev };
}

function isEmpty() {
  return db.prepare('SELECT COUNT(*) AS c FROM products').get().c === 0;
}

// ---- Public API keys + outbound webhooks ----
function createApiKey(clientId, name, keyHash, keyPrefix) {
  const r = db.prepare(
    'INSERT INTO api_keys (client_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)'
  ).run(clientId, name, keyHash, keyPrefix);
  return r.lastInsertRowid;
}
function listApiKeys(clientId) {
  return db.prepare(
    'SELECT id, name, key_prefix, revoked, last_used_at, created_at FROM api_keys WHERE client_id = ? ORDER BY id DESC'
  ).all(clientId);
}
function getApiKeyByHash(keyHash) {
  return db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(keyHash);
}
function revokeApiKey(id, clientId) {
  const r = db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND client_id = ?').run(id, clientId);
  return r.changes > 0;
}
function touchApiKey(id) {
  db.prepare(`UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
}
function createClientWebhook(clientId, url, events, secret) {
  const r = db.prepare(
    'INSERT INTO client_webhooks (client_id, url, events, secret) VALUES (?, ?, ?, ?)'
  ).run(clientId, url, events, secret);
  return r.lastInsertRowid;
}
function listClientWebhooks(clientId) {
  return db.prepare(
    'SELECT id, url, events, active, created_at FROM client_webhooks WHERE client_id = ? ORDER BY id DESC'
  ).all(clientId);
}
function deleteClientWebhook(id, clientId) {
  const r = db.prepare('DELETE FROM client_webhooks WHERE id = ? AND client_id = ?').run(id, clientId);
  return r.changes > 0;
}
function activeWebhooksFor(clientId) {
  return db.prepare('SELECT * FROM client_webhooks WHERE client_id = ? AND active = 1').all(clientId);
}

// ---- per-client payment & delivery config (fully dynamic, no hardcoded values) ----
function getPaymentConfig(clientId) {
  const row = db.prepare('SELECT * FROM client_payment_config WHERE client_id = ?').get(clientId);
  if (row) {
    try { row.payment_numbers = JSON.parse(row.payment_numbers_json || '{}'); } catch { row.payment_numbers = {}; }
    return row;
  }
  return {
    client_id: clientId, advance_percent: 0, delivery_inside_bdt: 0,
    delivery_outside_bdt: 0, payment_numbers: {}, cod_enabled: 1, payment_note: '',
  };
}
function savePaymentConfig(clientId, cfg) {
  const c = cfg || {};
  const adv = Math.min(100, Math.max(0, Number(c.advance_percent) || 0));
  const di = Math.max(0, Number(c.delivery_inside_bdt) || 0);
  const dout = Math.max(0, Number(c.delivery_outside_bdt) || 0);
  const nums = (c.payment_numbers && typeof c.payment_numbers === 'object') ? c.payment_numbers : {};
  const cod = c.cod_enabled === false || c.cod_enabled === 0 ? 0 : 1;
  const note = String(c.payment_note || '').slice(0, 2000);
  db.prepare(`INSERT INTO client_payment_config
    (client_id, advance_percent, delivery_inside_bdt, delivery_outside_bdt, payment_numbers_json, cod_enabled, payment_note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET advance_percent=excluded.advance_percent,
      delivery_inside_bdt=excluded.delivery_inside_bdt, delivery_outside_bdt=excluded.delivery_outside_bdt,
      payment_numbers_json=excluded.payment_numbers_json, cod_enabled=excluded.cod_enabled,
      payment_note=excluded.payment_note, updated_at=excluded.updated_at`)
    .run(clientId, adv, di, dout, JSON.stringify(nums), cod, note, now());
  return getPaymentConfig(clientId);
}

// ---- AI Rules Box: natural-language rules analyzed by AI into structured config ----
function getAiRules(clientId) {
  const row = db.prepare('SELECT * FROM client_ai_rules WHERE client_id = ?').get(clientId);
  if (row) {
    try { row.parsed = JSON.parse(row.parsed_json || '{}'); } catch { row.parsed = {}; }
    return row;
  }
  return { client_id: clientId, raw_text: '', parsed_json: '{}', parsed: {}, custom_rules_text: '', updated_at: null };
}
function saveAiRules(clientId, rawText, parsed, customRulesText) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  db.prepare(`INSERT INTO client_ai_rules (client_id, raw_text, parsed_json, custom_rules_text, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET raw_text=excluded.raw_text, parsed_json=excluded.parsed_json,
      custom_rules_text=excluded.custom_rules_text, updated_at=excluded.updated_at`)
    .run(clientId, String(rawText || '').slice(0, 20000), JSON.stringify(p),
      String(customRulesText || '').slice(0, 10000), now());
  return getAiRules(clientId);
}

module.exports = {
  DEFAULT_LEAD_FIELDS,
  getClients, getClient, getClientByWidgetKey, ensureWidgetKey, setClientWebsite, getWebchatAppearance, setWebchatAppearance, createClient, updateClient, deleteClient,
  findConversation, upsertConversation, getConversation, addMessage, findMessageByExternalId,
  getConversations, getMessages, getRecentMessages, markRead, flagNeedsHuman, clearNeedsHuman,
  findProductBySku, searchProducts, getProduct, addProduct, updateProduct, deleteProduct,
  updateProductOwned, deleteProductOwned,
  createOrder, getOrdersByConversation, getOrders,
  upsertLead, getLead, getLeadByPlatform, getLeads, updateLead, updateLeadOwned, markLeadConfirmed,
  updateLeadIntel, getStaleIntelLeads, getLeadIntelStats, stageToStatus,
  logComment, commentAlreadyHandled, claimComment, updateCommentResult,
  getRecentComments, getCommentConfig, setCommentConfig,
  addKnowledge, upsertKnowledgeBySource, countKnowledgeBySourcePrefix, getKnowledge, getKnowledgeById, updateKnowledge, deleteKnowledge,
  createWebsiteImport, getLatestWebsiteImport, listWebsiteImports, finishWebsiteImport, addWebsiteImportPage, listWebsiteImportPages, countWebsiteImportPages,
  setWebsiteImportDiscovered: (id, n) => db.prepare('UPDATE website_imports SET discovered = ? WHERE id = ?').run(n || 0, id),
  getDriveToken: (clientId) => db.prepare('SELECT * FROM client_drive_tokens WHERE client_id = ?').get(clientId),
  saveDriveToken: (clientId, t) => db.prepare(`INSERT INTO client_drive_tokens (client_id, access_token, refresh_token, expires_at, email, connected_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
    expires_at = excluded.expires_at, email = excluded.email, connected_at = excluded.connected_at`)
    .run(clientId, t.access_token, t.refresh_token, t.expires_at || 0, t.email || null, new Date().toISOString()),
  deleteDriveToken: (clientId) => db.prepare('DELETE FROM client_drive_tokens WHERE client_id = ?').run(clientId),
  updateKnowledgeOwned, deleteKnowledgeOwned,
  getChannelSession, setChannelSession, listChannelSessions, deleteChannelSession, clientForChannel,
  setAiPaused, isAiPaused,
  getPaymentConfig, savePaymentConfig,
  getAiRules, saveAiRules,
  saveMetaPage, getMetaPages, findClientByMetaPage, deleteMetaPage, getAllConnectedMetaPages,
  createUser, getUserById, getUserByUsername, getUsers, setUserPassword, setUserActive,
  createSession, getSession, deleteSession, deleteUserSessions, pruneSessions,
  getSetting, setSetting, addAudit, getAudit, adminOverview, connectedResources,
  getStats, globalStats, isEmpty, close,
  createApiKey, listApiKeys, getApiKeyByHash, revokeApiKey, touchApiKey,
  createClientWebhook, listClientWebhooks, deleteClientWebhook, activeWebhooksFor,
  // Raw SQL access for internal tooling (backup/restore, migrations).
  // SQL text is constructed by trusted server code only — never from user input.
  dbQuery: (sql, params = []) => db.prepare(sql).all(...params),
  dbRun: (sql, params = []) => db.prepare(sql).run(...params),
};
