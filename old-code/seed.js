// Seed script: v2 — creates demo clients, catalog, conversations, orders,
// knowledge base entries and leads on first run.
// Run manually with `npm run seed`; server.js also calls maybeSeed() at startup.
const db = require('./src/db');

const CLIENTS = [
  { name: 'Demo Fashion Store', business_type: 'physical' },
  { name: 'Demo Digital Services', business_type: 'digital' },
];

const PRODUCTS = [
  { sku: 'SKU-101', name: 'AirBeat Wireless Earbuds',    category: 'Electronics', price_bdt: 1850, stock: 24 },
  { sku: 'SKU-102', name: 'KeyForge Mechanical Keyboard', category: 'Electronics', price_bdt: 4200, stock: 12 },
  { sku: 'SKU-103', name: 'Flexi Smartphone Stand',      category: 'Accessories', price_bdt: 450,  stock: 60 },
  { sku: 'SKU-104', name: 'VoltCore 65W USB-C Charger',  category: 'Electronics', price_bdt: 1650, stock: 30 },
  { sku: 'SKU-105', name: 'Premium Cotton Panjabi',      category: 'Fashion',     price_bdt: 2400, stock: 18 },
  { sku: 'SKU-106', name: 'StrideX Running Shoes',       category: 'Fashion',     price_bdt: 3800, stock: 15 },
  { sku: 'SKU-107', name: 'LumaDesk LED Desk Lamp',      category: 'Electronics', price_bdt: 1250, stock: 22 },
  { sku: 'SKU-108', name: 'TrekMate Backpack 25L',       category: 'Accessories', price_bdt: 1950, stock: 20 },
  { sku: 'SKU-109', name: 'PulseFit Smart Watch',        category: 'Electronics', price_bdt: 5500, stock: 9 },
  { sku: 'SKU-110', name: 'BoomBox Bluetooth Speaker',   category: 'Electronics', price_bdt: 2750, stock: 14 },
];

const KNOWLEDGE_1 = [
  { title: 'Delivery policy',
    content: 'Dhakar vitore delivery 60 BDT, dhakar baire 120 BDT. Order confirm howar 2-3 working day er moddhe delivery. Cash on delivery available.' },
  { title: 'Return policy',
    content: 'Product-e manufacturing defect thakle 7 diner moddhe replacement. Size issue-te exchange possible (Fashion items), delivery charge customer-er.' },
  { title: 'Payment',
    content: 'bKash, Nagad, Rocket ebong Cash on Delivery accept kori. Advance payment-e 5% discount.' },
  { title: 'FAQ — warranty',
    content: 'Electronics product-e 6 mash er service warranty ache. Physical damage warranty-r baire.' },
];

const KNOWLEDGE_2 = [
  { title: 'Services',
    content: 'Amra website design, Facebook page setup, ebong logo design service di. Package price website-e deya ache; custom quote-er jonno inbox koro.' },
  { title: 'Delivery (digital)',
    content: 'Sob service online delivery hoy — email/WhatsApp-e file ebong access pathano hoy. Kono physical delivery nei.' },
  { title: 'Payment',
    content: 'bKash/Nagad-e 50% advance, delivery-r age baki 50%.' },
];

const CONVERSATIONS = [
  {
    platform: 'whatsapp', platformUserId: '8801712345678', customerName: 'Rahim Uddin', customerPhone: '+8801712345678',
    chat: [
      ['in',  'Assalamu alaikum, earbuds ache?'],
      ['out', 'Walaikum assalam! Ji ache — AirBeat Wireless Earbuds (SKU-101), dam 1,850 BDT. Details jante SKU likho.'],
      ['in',  'SKU-101'],
      ['out', 'AirBeat Wireless Earbuds\nSKU: SKU-101 | Electronics\nPrice: 1,850 BDT — In stock (24 pcs)\nOrder korte likho: "order SKU-101 x1"'],
      ['in',  'warranty ache?'],
    ],
  },
  {
    platform: 'telegram', platformUserId: '5120042331', customerName: 'Nusrat Jahan', customerPhone: null,
    chat: [
      ['in',  'hi, keyboard er price koto?'],
      ['in',  'mechanical keyboard'],
      ['out', '"keyboard"-er sathe mil ache:\n\n- KeyForge Mechanical Keyboard (SKU-102) — 4,200 BDT\n\nDetails jante SKU likho (jemon SKU-102).'],
      ['in',  'order SKU-102 x1'],
      ['out', 'Confirm korchi: 1 x KeyForge Mechanical Keyboard (SKU-102) = 4,200 BDT.\n"confirm" likhle order place hoye jabe, delivery address-soho.'],
    ],
  },
  {
    platform: 'messenger', platformUserId: '10293847561001', customerName: 'Tanvir Ahmed', customerPhone: null,
    chat: [
      ['in',  'Smart watch ta dekhte chai'],
      ['out', '"watch"-er sathe mil ache:\n\n- PulseFit Smart Watch (SKU-109) — 5,500 BDT\n\nDetails jante SKU likho (jemon SKU-109).'],
      ['in',  'SKU-109'],
      ['out', 'PulseFit Smart Watch\nSKU: SKU-109 | Electronics\nPrice: 5,500 BDT — In stock (9 pcs)\nOrder korte likho: "order SKU-109 x1"'],
    ],
  },
  {
    platform: 'instagram', platformUserId: '17841401234567890', customerName: 'Priya Das', customerPhone: null,
    chat: [
      ['in',  'panjabi hobe? eid er jonno'],
      ['out', '"panjabi"-er sathe mil ache:\n\n- Premium Cotton Panjabi (SKU-105) — 2,400 BDT\n\nDetails jante SKU likho (jemon SKU-105).'],
      ['in',  'size ki ki ache'],
    ],
  },
  {
    platform: 'whatsapp', platformUserId: '8801811223344', customerName: 'Karim Sheikh', customerPhone: '+8801811223344',
    chat: [
      ['in',  'charger lagbe urgent, 65W'],
      ['out', '"charger"-er sathe mil ache:\n\n- VoltCore 65W USB-C Charger (SKU-104) — 1,650 BDT\n\nDetails jante SKU likho (jemon SKU-104).'],
      ['in',  'order SKU-104 x2'],
      ['out', 'Confirm korchi: 2 x VoltCore 65W USB-C Charger (SKU-104) = 3,300 BDT.\n"confirm" likhle order place hoye jabe, delivery address-soho.'],
      ['in',  'confirm'],
      ['out', 'Order #1 confirmed: 2x VoltCore 65W USB-C Charger — Total 3,300 BDT. Delivery in 2-3 days. Dhonnobad!'],
    ],
  },
  {
    platform: 'messenger', platformUserId: '10293847562202', customerName: 'Sadia Islam', customerPhone: null,
    chat: [
      ['in',  'list'],
      ['out', 'Amader popular products:\n\n- AirBeat Wireless Earbuds (SKU-101) — 1,850 BDT\n- BoomBox Bluetooth Speaker (SKU-110) — 2,750 BDT\n- Flexi Smartphone Stand (SKU-103) — 450 BDT\n\nDetails jante jekono SKU likho.'],
      ['in',  'speaker ta nite chai'],
    ],
  },
  {
    platform: 'instagram', platformUserId: '17841409876543210', customerName: 'Arif Chowdhury', customerPhone: null,
    chat: [
      ['in',  'backpack er dam?'],
      ['out', '"backpack"-er sathe mil ache:\n\n- TrekMate Backpack 25L (SKU-108) — 1,950 BDT\n\nDetails jante SKU likho (jemon SKU-108).'],
    ],
  },
];

function seedKnowledgeAndLeads(c1, c2) {
  if (db.getKnowledge(c1.id).length === 0) {
    for (const k of KNOWLEDGE_1) db.addKnowledge(c1.id, k);
    for (const k of KNOWLEDGE_2) db.addKnowledge(c2.id, k);
  }
  if (db.getLeads({ clientId: c1.id }).length === 0) {
    // Sample leads at different pipeline stages.
    db.upsertLead({ clientId: c1.id, platform: 'whatsapp', platformUserId: '8801712345678',
      fields: { name: 'Rahim Uddin', phone: '+8801712345678' } });
    db.upsertLead({ clientId: c1.id, platform: 'whatsapp', platformUserId: '8801811223344',
      fields: { name: 'Karim Sheikh', phone: '+8801811223344', location: 'Chattogram, GEC Circle' } });
    db.updateLead(db.upsertLead({ clientId: c1.id, platform: 'whatsapp', platformUserId: '8801811223344', fields: {} }).id,
      { status: 'confirmed' });
    db.upsertLead({ clientId: c1.id, platform: 'instagram', platformUserId: '17841401234567890',
      fields: { name: 'Priya Das' } });
    db.upsertLead({ clientId: c2.id, platform: 'telegram', platformUserId: '777000111',
      fields: { name: 'Fahim Rahman', phone: '+8801912345678', email: 'fahim@example.com' } });
  }
}

function maybeSeed() {
  const existing = db.getClients();
  if (existing.length > 0) {
    // v1 → v2 migration: data already assigned to client 1 via DEFAULT 1;
    // just backfill knowledge + sample leads if missing.
    seedKnowledgeAndLeads(existing[0], existing[1] || existing[0]);
    return false;
  }

  const [c1, c2] = CLIENTS.map(c => db.createClient(c));
  console.log(`[seed] clients: ${c1.id} "${c1.name}", ${c2.id} "${c2.name}"`);

  // All demo catalog + chats belong to client 1 (physical store).
  for (const p of PRODUCTS) db.addProduct({ ...p, clientId: c1.id });

  const convIds = {};
  CONVERSATIONS.forEach((c, idx) => {
    const conv = db.upsertConversation({
      clientId: c1.id,
      platform: c.platform,
      platformUserId: c.platformUserId,
      customerName: c.customerName,
      customerPhone: c.customerPhone,
    });
    c.chat.forEach(([dir, text], i) => {
      const ts = new Date(Date.now() - (CONVERSATIONS.length - idx) * 3600e3 - (c.chat.length - i) * 60e3).toISOString();
      db.addMessage(conv.id, dir, text, null, ts);
    });
    convIds[c.customerName] = conv.id;
    if (idx < CONVERSATIONS.length - 2) db.markRead(conv.id);
  });

  db.createOrder(convIds['Karim Sheikh'], [{ sku: 'SKU-104', qty: 2 }]);
  db.createOrder(convIds['Nusrat Jahan'], [{ sku: 'SKU-101', qty: 1 }]);

  seedKnowledgeAndLeads(c1, c2);

  console.log('[seed] v2 demo data created (catalog, chats, orders, knowledge, leads).');
  return true;
}

if (require.main === module) maybeSeed();
module.exports = { maybeSeed };
