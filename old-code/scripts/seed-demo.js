// Seed clean demo data for the test workspace (client_id=4).
// Run: node scripts/seed-demo.js   (server must be STOPPED — SQLite lock)
// Wipes ALL data for client 4 first (products, conversations, messages,
// leads, knowledge) — authorized by the owner for clean marketing screenshots.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'tectonic-inbox.db');
const db = new DatabaseSync(dbPath);
const D = require('../src/db.js');
const CLIENT = 4;

function wipe() {
  db.prepare('DELETE FROM orders WHERE conversation_id IN (SELECT id FROM conversations WHERE client_id = ?)').run(CLIENT);
  db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE client_id = ?)').run(CLIENT);
  db.prepare('DELETE FROM conversations WHERE client_id = ?').run(CLIENT);
  db.prepare('DELETE FROM products WHERE client_id = ?').run(CLIENT);
  db.prepare('DELETE FROM leads WHERE client_id = ?').run(CLIENT);
  db.prepare('DELETE FROM knowledge WHERE client_id = ?').run(CLIENT);
  console.log('wiped test data for client', CLIENT);
}

function seed() {
  const products = [
    { sku: 'buds-pro', name: 'AirBuds Pro', category: 'Electronics', price_bdt: 1800, stock: 25 },
    { sku: 'kurti-red', name: 'Cotton Kurti (Red)', category: 'Fashion', price_bdt: 1200, stock: 40 },
    { sku: 'panjabi-white', name: 'Premium Panjabi (White)', category: 'Fashion', price_bdt: 2500, stock: 14 },
    { sku: 'watch-fit', name: 'FitBand Smart Watch', category: 'Electronics', price_bdt: 3200, stock: 18 },
    { sku: 'hijab-silk', name: 'Silk Hijab (Black)', category: 'Fashion', price_bdt: 650, stock: 60 },
    { sku: 'shoe-run', name: 'Runner Sports Shoe', category: 'Footwear', price_bdt: 2800, stock: 22 },
  ];
  for (const p of products) D.addProduct({ clientId: CLIENT, ...p });
  console.log('seeded', products.length, 'products');

  const chats = [
    { platform: 'whatsapp', uid: 'demo-wa-1', name: 'Rahim Uddin', phone: '01711111111', msgs: [
      ['in', 'Assalamu alaikum, AirBuds Pro ta ki available?'],
      ['out', 'Walaikum assalam! Yes, AirBuds Pro is available — 1,800 BDT, in stock.'],
      ['in', 'Delivery charge koto Dhaka te?'],
      ['out', 'Inside Dhaka delivery is 60 BDT, takes 1-2 days.'],
      ['in', 'Ok order korbo, cash on delivery hobe?'],
      ['out', 'Yes! Cash on delivery available. Please share your full address to confirm.'],
    ]},
    { platform: 'telegram', uid: 'demo-tg-1', name: 'Nusrat Jahan', phone: '', msgs: [
      ['in', 'Hi! Is the red kurti in stock in size M?'],
      ['out', 'Hi Nusrat! Yes — Cotton Kurti (Red) is in stock, 1,200 BDT. Size M available.'],
      ['in', 'Great, how do I order?'],
      ['out', 'Just share your name, phone and address — we will confirm your order right away.'],
    ]},
    { platform: 'webchat', uid: 'demo-wc-1', name: 'Tanvir Hasan', phone: '01822222222', msgs: [
      ['in', 'Smart watch er battery backup koto?'],
      ['out', 'FitBand Smart Watch gives up to 7 days battery backup — 3,200 BDT.'],
      ['in', 'Warranty ache?'],
      ['out', 'Yes, 6 months official warranty included.'],
    ]},
    { platform: 'whatsapp', uid: 'demo-wa-2', name: 'Mim Akter', phone: '01933333333', msgs: [
      ['in', 'Panjabi ta white chara onno color ache?'],
      ['out', 'Premium Panjabi currently comes in White — 2,500 BDT. New colors arriving next week!'],
      ['in', 'Ok, white tai nibo. Order process?'],
    ]},
    { platform: 'telegram', uid: 'demo-tg-2', name: 'Arif Chowdhury', phone: '', msgs: [
      ['in', 'Runner sports shoe size 42 available?'],
      ['out', 'Yes! Runner Sports Shoe, size 42 in stock — 2,800 BDT.'],
    ]},
  ];
  for (const c of chats) {
    const conv = D.upsertConversation({
      clientId: CLIENT, platform: c.platform, platformUserId: c.uid,
      customerName: c.name, customerPhone: c.phone, bumpUnread: false,
    });
    for (const [dir, text] of c.msgs) D.addMessage(conv.id, dir, text, null);
    db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conv.id);
  }
  console.log('seeded', chats.length, 'conversations');

  const leads = [
    { platform: 'whatsapp', uid: 'demo-wa-1', name: 'Rahim Uddin', phone: '01711111111', score: 85, temp: 'hot', notes: 'Wants AirBuds Pro, asked about COD — ready to order.' },
    { platform: 'telegram', uid: 'demo-tg-1', name: 'Nusrat Jahan', phone: '', score: 78, temp: 'hot', notes: 'Red kurti size M — asked how to order.' },
    { platform: 'webchat', uid: 'demo-wc-1', name: 'Tanvir Hasan', phone: '01822222222', score: 62, temp: 'warm', notes: 'Interested in smart watch, asked about warranty.' },
    { platform: 'whatsapp', uid: 'demo-wa-2', name: 'Mim Akter', phone: '01933333333', score: 55, temp: 'warm', notes: 'Panjabi (White) — wants to order.' },
    { platform: 'telegram', uid: 'demo-tg-2', name: 'Arif Chowdhury', phone: '', score: 40, temp: 'cold', notes: 'Asked about shoe size availability.' },
  ];
  for (const l of leads) {
    D.upsertLead({ clientId: CLIENT, platform: l.platform, platformUserId: l.uid,
      fields: { name: l.name, phone: l.phone, notes: l.notes } });
    db.prepare('UPDATE leads SET score = ?, temperature = ? WHERE client_id = ? AND platform_user_id = ?')
      .run(l.score, l.temp, CLIENT, l.uid);
  }
  console.log('seeded', leads.length, 'leads');

  const docs = [
    { title: 'Shipping Policy', content: 'Inside Dhaka: 60 BDT, 1-2 days. Outside Dhaka: 120 BDT, 3-4 days. Free delivery on orders above 5,000 BDT.', category: 'policy' },
    { title: 'Returns & Exchange', content: '7-day easy exchange for size issues. Product must be unused with tags. Refunds via bKash/Nagad within 3 working days.', category: 'policy' },
    { title: 'Payment Methods', content: 'We accept Cash on Delivery, bKash, Nagad and Rocket. All online payments are confirmed before dispatch.', category: 'policy' },
  ];
  for (const d of docs) D.addKnowledge(CLIENT, d);
  console.log('seeded', docs.length, 'knowledge docs');
}

wipe();
seed();
db.close();
console.log('DONE');
