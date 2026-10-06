// Tectonic backup engine — export/import all client data.
// Exports: one JSON bundle (machine-readable, importable) + one MD summary
// (human-readable). Backups can go to Google Drive or download directly.
// Restore is MERGE-only: it never deletes existing data, and every record
// type is idempotent (re-importing the same file changes nothing).

const db = require('./db');

const BACKUP_VERSION = 1;

// Collect everything belonging to one client into a portable bundle.
function exportClientData(clientId) {
  const client = db.getClient(clientId);
  if (!client) throw new Error('Client not found');

  const bundle = {
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    app: 'tectonic-inbox',
    client: {
      id: client.id,
      name: client.name,
      business_type: client.business_type,
      lead_fields: client.lead_fields,
      created_at: client.created_at,
    },
    products: [],
    knowledge: [],
    leads: [],
    orders: [],
    conversations: [],
    appearance: null,
    channel_sessions: [],
  };

  try { bundle.products = db.searchProducts('', clientId); } catch (e) { console.warn('[backup] products export failed:', e.message); }
  try { bundle.knowledge = db.getKnowledge(clientId); } catch (e) { console.warn('[backup] knowledge export failed:', e.message); }
  try { bundle.leads = db.getLeads({ clientId }); } catch (e) { console.warn('[backup] leads export failed:', e.message); }
  try { bundle.orders = db.getOrders(clientId); } catch (e) { console.warn('[backup] orders export failed:', e.message); }
  try {
    const convs = db.getConversations({ clientId });
    bundle.conversations = convs.map(c => ({
      ...c,
      messages: db.getMessages(c.id),
    }));
  } catch (e) { console.warn('[backup] conversations export failed:', e.message); }
  try { bundle.appearance = db.getWebchatAppearance(clientId); } catch (e) { console.warn('[backup] appearance export failed:', e.message); }
  try {
    const sessions = db.listChannelSessions(clientId) || [];
    // Never export secrets/tokens — only connection metadata.
    bundle.channel_sessions = sessions.map(s => ({
      channel: s.channel, slot: s.slot, status: s.status,
      ai_paused: s.ai_paused, updated_at: s.updated_at,
    }));
  } catch (e) { console.warn('[backup] sessions export failed:', e.message); }

  return bundle;
}

// Super-admin: one bundle with EVERY client (client list + all business data).
function exportAllClients() {
  const clients = db.getClients();
  return {
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    app: 'tectonic-inbox',
    scope: 'all-clients',
    clients: clients.map(c => ({
      client: {
        id: c.id, name: c.name, business_type: c.business_type,
        lead_fields: c.lead_fields, widget_key: c.widget_key,
        website_url: c.website_url, created_at: c.created_at,
      },
      data: exportClientData(c.id),
    })),
  };
}

// Human-readable Markdown summary of a backup bundle.
function bundleToMarkdown(bundle) {
  const c = bundle.client;
  const L = [];
  L.push(`# Tectonic Backup — ${c.name}`);
  L.push(``);
  L.push(`- Exported: ${bundle.exported_at}`);
  L.push(`- Backup version: ${bundle.version}`);
  L.push(`- Business type: ${c.business_type || 'physical'}`);
  L.push(``);
  L.push(`## Contents`);
  L.push(``);
  L.push(`| Data | Count |`);
  L.push(`|------|-------|`);
  L.push(`| Products | ${bundle.products.length} |`);
  L.push(`| Knowledge documents | ${bundle.knowledge.length} |`);
  L.push(`| Leads | ${bundle.leads.length} |`);
  L.push(`| Orders | ${bundle.orders.length} |`);
  L.push(`| Conversations | ${bundle.conversations.length} |`);
  const msgCount = bundle.conversations.reduce((n, cv) => n + (cv.messages || []).length, 0);
  L.push(`| Messages | ${msgCount} |`);
  L.push(``);

  if (bundle.products.length) {
    L.push(`## Products`);
    L.push(``);
    bundle.products.forEach(p => {
      L.push(`- **${p.name}** (SKU: ${p.sku}) — ৳${p.price_bdt}, stock ${p.stock || 0}`);
    });
    L.push(``);
  }
  if (bundle.knowledge.length) {
    L.push(`## Knowledge Base`);
    L.push(``);
    bundle.knowledge.forEach(k => {
      L.push(`### ${k.title} [${k.category || 'general'}]`);
      L.push(``);
      L.push((k.content || '').slice(0, 2000));
      L.push(``);
    });
  }
  if (bundle.orders.length) {
    L.push(`## Orders`);
    L.push(``);
    L.push(`| # | Customer | Total | Advance | Status | Date |`);
    L.push(`|---|----------|-------|---------|--------|------|`);
    bundle.orders.slice(0, 100).forEach(o => {
      const total = (o.subtotal_bdt || 0) + (o.delivery_charge_bdt || 0);
      L.push(`| ${o.id} | ${(o.customer_name || '').replace(/\|/g, ' ')} | ৳${total} | ৳${o.advance_paid_bdt || 0} | ${o.payment_status || o.status} | ${(o.created_at || '').slice(0, 10)} |`);
    });
    L.push(``);
  }
  L.push(`---`);
  L.push(`*Full machine-readable data is in the accompanying .json file. Import it via Settings → Backup → Import.*`);
  L.push(``);
  return L.join('\n');
}

// Restore a bundle into a client. MERGE-only, idempotent:
// re-importing the same file imports 0 new rows.
// Returns counts of imported rows.
function importClientData(clientId, bundle) {
  if (!bundle || bundle.version !== BACKUP_VERSION || bundle.app !== 'tectonic-inbox') {
    throw new Error('Not a valid Tectonic backup file');
  }
  const now = new Date().toISOString();
  const counts = { products: 0, knowledge: 0, leads: 0, orders: 0, conversations: 0, messages: 0, appearance: 0 };

  // Products — dedupe by SKU (case-insensitive).
  for (const p of bundle.products || []) {
    try {
      if (!p.sku || !p.name) continue;
      if (db.findProductBySku(p.sku, clientId)) continue;
      db.addProduct({
        clientId, sku: p.sku, name: p.name, category: p.category,
        price_bdt: p.price_bdt, stock: p.stock || 0, image_url: p.image_url || null,
      });
      counts.products++;
    } catch (e) { console.warn('[backup] product restore skipped:', e.message); }
  }

  // Knowledge — upsert by a stable backup source key. Content is always
  // refreshed from the backup; the count only rises for newly created docs
  // (so re-importing the same file is a no-op).
  for (const k of bundle.knowledge || []) {
    try {
      if (!k.title && !k.content) continue;
      const sourceUrl = k.source_url || ('backup:' + (k.title || '').slice(0, 60));
      const existed = db.dbQuery('SELECT id FROM knowledge WHERE client_id = ? AND source_url = ? LIMIT 1', [clientId, sourceUrl]);
      db.upsertKnowledgeBySource(clientId, {
        title: k.title || '(untitled)', content: k.content || '',
        category: k.category || 'general', source_url: sourceUrl,
      });
      if (!existed.length) counts.knowledge++;
    } catch (e) { console.warn('[backup] knowledge restore skipped:', e.message); }
  }

  // Leads — keep the existing row if the person is already known (merge, no clobber).
  for (const l of bundle.leads || []) {
    try {
      if (!l.platform || !l.platform_user_id) continue;
      if (db.getLeadByPlatform(clientId, l.platform, l.platform_user_id)) continue;
      db.upsertLead({
        clientId, platform: l.platform, platformUserId: l.platform_user_id,
        fields: {
          name: l.name, phone: l.phone, email: l.email, whatsapp_id: l.whatsapp_id, location: l.location,
          notes: '[restored ' + (bundle.exported_at || '').slice(0, 10) + '] ' + (l.notes || ''),
          status: l.status,
        },
      });
      counts.leads++;
    } catch (e) { console.warn('[backup] lead restore skipped:', e.message); }
  }

  // Conversations + messages — upsert by (platform, platform_user_id, slot);
  // messages deduped by external_id or exact (direction, text, created_at).
  const convIdMap = new Map(); // old conversation id -> new conversation id
  for (const c of bundle.conversations || []) {
    try {
      if (!c.platform || !c.platform_user_id) continue;
      const slot = c.slot || 'default';
      const existed = db.findConversation(clientId, c.platform, c.platform_user_id, slot);
      const conv = db.upsertConversation({
        clientId, platform: c.platform, platformUserId: c.platform_user_id,
        customerName: c.customer_name, customerPhone: c.customer_phone,
        customerContact: c.customer_contact, slot,
        bumpUnread: false,
      });
      convIdMap.set(c.id, conv.id);
      // Restore original timestamps/unread state (upsert defaults aren't history).
      try {
        db.dbRun('UPDATE conversations SET last_message_at = ?, unread_count = ?, needs_human = ? WHERE id = ?',
          [c.last_message_at || conv.last_message_at, c.unread_count || 0, c.needs_human ? 1 : 0, conv.id]);
      } catch {}
      if (!existed) counts.conversations++;
      for (const m of c.messages || []) {
        try {
          if (m.external_id && db.findMessageByExternalId(conv.id, m.external_id)) continue;
          if (!m.external_id) {
            const dup = db.dbQuery(
              'SELECT id FROM messages WHERE conversation_id = ? AND direction = ? AND text = ? AND created_at = ? LIMIT 1',
              [conv.id, m.direction, m.text || '', m.created_at || '']);
            if (dup.length) continue;
          }
          db.addMessage(conv.id, m.direction, m.text || '', m.raw_json || m.raw || null, m.created_at || now, m.external_id || null);
          counts.messages++;
        } catch (e) { console.warn('[backup] message restore skipped:', e.message); }
      }
    } catch (e) { console.warn('[backup] conversation restore skipped:', e.message); }
  }

  // Orders — inserted as HISTORY (no stock decrement, unlike a live sale).
  // Idempotency: synthetic key per (export batch, original order id).
  for (const o of bundle.orders || []) {
    try {
      const idemKey = `backup:${bundle.exported_at}:${o.id}`;
      const exists = db.dbQuery('SELECT id FROM orders WHERE client_id = ? AND idempotency_key = ? LIMIT 1', [clientId, idemKey]);
      if (exists.length) continue;
      const newConvId = (o.conversation_id && convIdMap.get(o.conversation_id)) || null;
      const subtotal = o.subtotal_bdt || 0, delivery = o.delivery_charge_bdt || 0;
      db.dbRun(`INSERT INTO orders (client_id, conversation_id, customer_name, customer_phone, items_json,
        subtotal_bdt, total_bdt, delivery_charge_bdt, advance_required_bdt, advance_paid_bdt, transaction_id,
        payment_status, status, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [clientId, newConvId, o.customer_name, o.customer_phone, o.items_json,
          subtotal, subtotal + delivery, delivery, o.advance_required_bdt || 0,
          o.advance_paid_bdt || 0, o.transaction_id, o.payment_status, o.status || 'confirmed',
          idemKey, o.created_at || now]);
      counts.orders++;
    } catch (e) { console.warn('[backup] order restore skipped:', e.message); }
  }

  // Appearance — restore the widget look. getWebchatAppearance returns mapped
  // keys (title/color/..., not wc_*). Skip when nothing would change so a
  // re-import stays a no-op.
  try {
    const a = bundle.appearance;
    if (a && (a.title || a.greeting || a.color || a.position || a.avatar || a.subtitle || a.require_intro !== undefined)) {
      const cur = db.getWebchatAppearance(clientId) || {};
      const same = ['title', 'greeting', 'color', 'position', 'avatar', 'subtitle'].every(k => (cur[k] || null) === (a[k] || null))
        && Number(cur.require_intro ? 1 : 0) === Number(a.require_intro ? 1 : 0);
      if (!same) {
        db.setWebchatAppearance(clientId, {
          title: a.title, greeting: a.greeting, color: a.color,
          position: a.position, avatar: a.avatar, subtitle: a.subtitle,
          require_intro: !!a.require_intro,
        });
        counts.appearance = 1;
      }
    }
  } catch (e) { console.warn('[backup] appearance restore skipped:', e.message); }

  // Channel sessions: connection metadata only — live sessions/tokens can't be
  // restored from a backup (they must be re-paired). Exported for reference.
  return counts;
}

module.exports = { exportClientData, exportAllClients, bundleToMarkdown, importClientData, BACKUP_VERSION };
