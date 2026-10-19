// AI Brain — unified intelligence interface. The owner writes natural language
// (Bangla/English/mixed) in ONE box; the AI analyzes it and routes each piece
// to the right store: payment config, knowledge base documents, custom rules.
// Deterministic fallback keeps it working when AI tiers are down.
const ai = require('./ai');
const db = require('./db');

const BRAIN_PROMPT = `You are the brain of a commerce chatbot platform. The shop owner wrote business info in natural language (Bangla/English/mixed; Bengali ০-৯ or ASCII numerals, number words like ষাট=60, একশো বিশ=120, চল্লিশ=40).

Split it into THREE buckets and return STRICT JSON only — no markdown, no explanation:

{
  "payment": {
    "advance_percent": <0-100 or null if not mentioned>,
    "delivery_inside_bdt": <number or null>,
    "delivery_outside_bdt": <number or null>,
    "payment_numbers": { "<method>": "<digits>" },
    "cod_enabled": <true/false/null>,
    "payment_note": "<extra payment instructions or null>"
  },
  "knowledge": [
    { "title": "<short title>", "category": "<policy|shipping|product|faq|marketing|general>", "content": "<the fact, 1-3 sentences>" }
  ],
  "custom_rules": ["<behavioral instruction as imperative sentence>"],
  "business_type": "<physical|digital|null>"
}

Routing rules:
- PAYMENT bucket: advance %, delivery charges, bKash/Nagad/Rocket numbers, COD availability, payment instructions.
- KNOWLEDGE bucket: facts the AI should KNOW when answering — return/exchange policy, delivery timeline, product details, shop hours, location, FAQs, offers. One doc per distinct fact. Category: policy=returns/refunds/rules, shipping=delivery time/method, product=product info, faq=question-answer, marketing=offers/promos, general=everything else.
- CUSTOM RULES bucket: BEHAVIORAL instructions — how the AI should act ("always greet by name", "Friday no delivery", "never offer discount over 10%"). Imperative sentences.
- A sentence about delivery CHARGE → payment. About delivery TIME → knowledge/shipping.
- Null for unmentioned payment fields. Never invent values. Max 12 knowledge docs, 20 custom rules.

Owner's text:
"""`;

const BN_WORDS = {
  'শূন্য': 0, 'এক': 1, 'দুই': 2, 'তিন': 3, 'চার': 4, 'পাঁচ': 5, 'ছয়': 6, 'ছয়': 6, 'সাত': 7, 'আট': 8, 'নয়': 9, 'নয়': 9, 'দশ': 10,
  'এগার': 11, 'বার': 12, 'তের': 13, 'চৌদ্দ': 14, 'পনের': 15, 'ষোল': 16, 'ষোলো': 16, 'সতের': 17, 'আঠার': 18, 'উনিশ': 19, 'বিশ': 20,
  'একুশ': 21, 'বাইশ': 22, 'তেইশ': 23, 'চব্বিশ': 24, 'পঁচিশ': 25, 'ছাব্বিশ': 26, 'সাতাশ': 27, 'আঠাশ': 28, 'ঊনত্রিশ': 29,
  'ত্রিশ': 30, 'চল্লিশ': 40, 'পঞ্চাশ': 50, 'ষাট': 60, 'সত্তর': 70, 'আশি': 80, 'নব্বই': 90,
  'একশ': 100, 'একশো': 100, 'দুইশ': 200, 'দুইশো': 200, 'তিনশ': 300, 'তিনশো': 300,
};
function wordsToNumber(s) {
  let total = 0, found = false;
  for (const w of String(s).split(/\s+/)) {
    const v = BN_WORDS[w.trim()];
    if (v != null) { total += v; found = true; }
  }
  return found ? total : null;
}
function bnNorm(text) {
  const bn = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
  return String(text).replace(/[০-৯]/g, d => bn[d]);
}

// ---- deterministic fallback: payment extraction ----
function fallbackPayment(norm) {
  const out = { advance_percent: null, delivery_inside_bdt: null, delivery_outside_bdt: null, payment_numbers: {}, cod_enabled: null, payment_note: null };
  let m;
  const pctW = '(?:%|percent|পার্সেন্ট)';
  m = norm.match(new RegExp('(\\d{1,3})\\s*' + pctW + '[^.]*?(?:অগ্রিম|advance|আগে পাঠ)', 'i')) || norm.match(new RegExp('(?:অগ্রিম|advance)[^.]*?(\\d{1,3})\\s*' + pctW, 'i'));
  if (m) out.advance_percent = Math.min(100, parseInt(m[1], 10));
  else {
    const wm = norm.match(new RegExp('(\\S+(?:\\s+\\S+){0,2})\\s*' + pctW + '\\s*[^.]*?(?:অগ্রিম|advance|আগে)', 'i'));
    if (wm) { const n = wordsToNumber(wm[1]); if (n != null) out.advance_percent = Math.min(100, n); }
  }
  m = norm.match(/ঢাকার\s*(?:ভিতরে|মধ্যে|ভেতরে)[^.]*?(\d+)\s*টাকা/i)
    || norm.match(/(\d+)\s*(?:taka|bdt|৳)?\s*(?:inside|within)\s+dhaka/i)
    || norm.match(/(?:inside|within)\s+dhaka[^.,]*?(\d+)\s*(?:taka|bdt)?/i);
  if (m) out.delivery_inside_bdt = parseInt(m[1], 10);
  else {
    const wm = norm.match(/ঢাকার\s*(?:ভিতরে|মধ্যে|ভেতরে)[^.]*?(\S+(?:\s+\S+){0,2})\s*টাকা/i);
    if (wm) { const n = wordsToNumber(wm[1]); if (n != null) out.delivery_inside_bdt = n; }
    else {
      const cm = norm.match(/ঢাকার\s*(?:ভিতরে|মধ্যে|ভেতরে)\s*(\d+)/i);
      if (cm) out.delivery_inside_bdt = parseInt(cm[1], 10);
    }
  }
  m = norm.match(/ঢাকার\s*বাইরে[^.]*?(\d+)\s*টাকা/i)
    || norm.match(/(\d+)\s*(?:taka|bdt|৳)?\s*outside\s+dhaka/i)
    || norm.match(/outside\s+dhaka[^.,]*?(\d+)\s*(?:taka|bdt)?/i);
  if (m) out.delivery_outside_bdt = parseInt(m[1], 10);
  else {
    const wm = norm.match(/ঢাকার\s*বাইরে[^.]*?(\S+(?:\s+\S+){0,2})\s*টাকা/i);
    if (wm) { const n = wordsToNumber(wm[1]); if (n != null) out.delivery_outside_bdt = n; }
    else {
      // "80 inside Dhaka, 150 outside" — number before or after outside
      const cm = norm.match(/(\d+)[^.,\d]{0,10}outside/i) || norm.match(/(?:বাইরে|outside)[^.,\d]*(\d+)/i);
      if (cm && out.delivery_inside_bdt != null) {
        const v = parseInt(cm[1], 10);
        if (v !== out.delivery_inside_bdt) out.delivery_outside_bdt = v;
      }
    }
  }
  // also generic "delivery charge X" without Dhaka context → treat as outside/default
  if (out.delivery_inside_bdt == null && out.delivery_outside_bdt == null) {
    m = norm.match(/(?:ডেলিভারি\s*(?:চার্জ|খরচ)?|delivery\s*(?:charge)?)\s*(\d+)\s*(?:টাকা|taka|bdt)/i);
    if (m) out.delivery_outside_bdt = parseInt(m[1], 10);
  }
  for (const [key, pat] of [['bKash', /বিকাশ|bkash/i], ['Nagad', /নগদ|nagad/i], ['Rocket', /রকেট|rocket/i], ['Upay', /উপায়|upay/i]]) {
    const mm = norm.match(new RegExp('(?:' + pat.source + ')[^\\d]*?(01\\d{9})', 'i'));
    if (mm) out.payment_numbers[key] = mm[1];
  }
  if (/ক্যাশ অন ডেলিভারি|cash on delivery|\bCOD\b/i.test(norm)) out.cod_enabled = true;
  if (/COD\s*(?:নেই|নাই|বন্ধ)|no COD/i.test(norm)) out.cod_enabled = false;
  return out;
}

// ---- deterministic fallback: knowledge categorization ----
const KB_CATS = [
  ['policy', /রিটার্ন|ফেরত|return|refund|রিফান্ড|exchange|বদল|warranty|ওয়ারেন্টি|গ্যারান্টি/i],
  ['shipping', /ডেলিভারি.*(?:দিন|ঘণ্টা|সময়)|delivery.*(?:day|hour)|কুরিয়ার|courier|পাঠানো হবে|shipping time/i],
  ['product', /দাম|price|সাইজ|size|রঙ|color|colour|স্টক|stock|product|পণ্য|কাপড়|fabric/i],
  ['faq', /\?|কিভাবে|কীভাবে|how /i],
  ['marketing', /অফার|offer|ছাড়|discount|কুপন|coupon|promo|ফ্রি |free /i],
];
function fallbackKnowledge(text) {
  // Split into sentence-ish chunks, categorize each non-payment chunk
  const chunks = String(text).split(/[।\n]+/).map(s => s.trim()).filter(s => s.length > 8);
  const docs = [];
  for (const ch of chunks) {
    const norm = bnNorm(ch);
    // skip pure-payment chunks (already routed to payment bucket)
    if (/(?:অগ্রিম|advance|বিকাশ|নগদ|bkash|nagad|ক্যাশ অন ডেলিভারি|\bCOD\b|ঢাকার\s*(?:ভিতরে|বাইরে|মধ্যে))/i.test(norm) && /\d|%|01\d{9}/.test(norm)) continue;
    let cat = 'general';
    for (const [c, pat] of KB_CATS) { if (pat.test(norm)) { cat = c; break; } }
    const title = ch.slice(0, 48).replace(/\s+\S*$/, '') || 'Note';
    docs.push({ title, category: cat, content: ch.slice(0, 600) });
    if (docs.length >= 12) break;
  }
  return docs;
}

// ---- deterministic fallback: custom rules ----
function fallbackRules(text) {
  const rules = [];
  const chunks = String(text).split(/[।\n]+/).map(s => s.trim()).filter(s => s.length > 8);
  for (const ch of chunks) {
    // behavioral markers: বন্ধ, করবে না, সবসময়, কখনো, must, never, always
    if (/বন্ধ থাকে|করবে না|করো না|সবসময়|সব সময়|কখনো.*না|must|never|always|do not|don't/i.test(ch)) {
      // but not payment chunks
      if (!/(?:অগ্রিম|advance|বিকাশ|নগদ|COD|ডেলিভারি\s*চার্জ)/i.test(ch)) {
        rules.push(ch.slice(0, 500));
        if (rules.length >= 20) break;
      }
    }
  }
  return rules;
}

function sanitizeParsed(p) {
  p = p || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  const pay = p.payment || {};
  const nums = {};
  if (pay.payment_numbers && typeof pay.payment_numbers === 'object') {
    for (const [k, v] of Object.entries(pay.payment_numbers)) {
      const digits = String(v).replace(/\D/g, '');
      if (digits.length >= 6) nums[String(k).slice(0, 24)] = digits.slice(0, 20);
    }
  }
  return {
    payment: {
      advance_percent: pay.advance_percent == null ? null : Math.min(100, Math.max(0, num(pay.advance_percent) ?? 0)),
      delivery_inside_bdt: num(pay.delivery_inside_bdt),
      delivery_outside_bdt: num(pay.delivery_outside_bdt),
      payment_numbers: nums,
      cod_enabled: pay.cod_enabled == null ? null : !!pay.cod_enabled,
      payment_note: pay.payment_note ? String(pay.payment_note).slice(0, 2000) : null,
    },
    knowledge: Array.isArray(p.knowledge) ? p.knowledge.slice(0, 12).map(d => ({
      title: String(d.title || 'Note').slice(0, 120),
      category: ['policy', 'shipping', 'product', 'faq', 'marketing', 'general'].includes(d.category) ? d.category : 'general',
      content: String(d.content || '').slice(0, 2000),
    })).filter(d => d.content) : [],
    custom_rules: Array.isArray(p.custom_rules)
      ? p.custom_rules.map(String).map(s => s.slice(0, 500)).filter(Boolean).slice(0, 20) : [],
    business_type: ['physical', 'digital'].includes(p.business_type) ? p.business_type : null,
  };
}

async function analyzeBrain(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('Empty text');
  const messages = [
    { role: 'system', content: BRAIN_PROMPT + text + '\n"""' },
    { role: 'user', content: 'Analyze and return the JSON now.' },
  ];
  let parsed = null;
  try {
    const raw = await ai.getAIResponse(messages, 'global', 'bg');
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (m) parsed = sanitizeParsed(JSON.parse(m[0]));
  } catch (e) { console.warn('[brain] AI extract failed, using fallback:', e.message); }
  const aiEmpty = !parsed || (
    parsed.payment.advance_percent == null && parsed.payment.delivery_inside_bdt == null &&
    parsed.payment.delivery_outside_bdt == null && parsed.payment.cod_enabled == null &&
    !Object.keys(parsed.payment.payment_numbers).length &&
    !parsed.knowledge.length && !parsed.custom_rules.length
  );
  if (aiEmpty) {
    console.warn('[brain] using deterministic fallback');
    const norm = bnNorm(text);
    return {
      payment: fallbackPayment(norm),
      knowledge: fallbackKnowledge(text),
      custom_rules: fallbackRules(text),
      business_type: null,
      _fallback: true,
    };
  }
  return parsed;
}

async function applyBrain(clientId, rawText, parsed) {
  const result = { payment: null, knowledge: [], custom_rules: '' };
  // 1. Payment — only overwrite mentioned fields
  const p = parsed.payment || {};
  const cur = db.getPaymentConfig(clientId);
  const hasPay = p.advance_percent != null || p.delivery_inside_bdt != null ||
    p.delivery_outside_bdt != null || p.cod_enabled != null ||
    Object.keys(p.payment_numbers || {}).length || p.payment_note != null;
  if (hasPay) {
    result.payment = db.savePaymentConfig(clientId, {
      advance_percent: p.advance_percent ?? cur.advance_percent,
      delivery_inside_bdt: p.delivery_inside_bdt ?? cur.delivery_inside_bdt,
      delivery_outside_bdt: p.delivery_outside_bdt ?? cur.delivery_outside_bdt,
      payment_numbers: Object.keys(p.payment_numbers || {}).length
        ? { ...(cur.payment_numbers || {}), ...p.payment_numbers } : cur.payment_numbers,
      cod_enabled: p.cod_enabled ?? cur.cod_enabled,
      payment_note: p.payment_note ?? cur.payment_note,
    });
  }
  // 2. Knowledge — dedupe by title per client, add as new docs
  for (const d of (parsed.knowledge || [])) {
    try {
      const existing = db.getKnowledge(clientId).find(k => k.title === d.title);
      if (!existing) {
        db.addKnowledge(clientId, { title: d.title, content: d.content, category: d.category, source_url: 'ai-brain:' + Date.now() });
        result.knowledge.push(d.title);
      }
    } catch (e) { console.warn('[brain] kb add failed:', e.message); }
  }
  // 3. Custom rules → prompt injection
  const customText = (parsed.custom_rules || []).map((r, i) => `${i + 1}. ${r}`).join('\n');
  const saved = db.saveAiRules(clientId, rawText, parsed, customText);
  result.custom_rules = customText;
  result.rules_row = saved;
  try { db.addAudit(null, clientId, 'ai_brain.apply', `brain: payment ${hasPay ? 'updated' : 'unchanged'}, ${result.knowledge.length} kb docs, ${parsed.custom_rules.length} rules`); } catch {}
  return result;
}

// Back-compat: old ai-rules API maps onto the brain
async function analyzeRules(rawText) {
  const b = await analyzeBrain(rawText);
  return { ...b.payment, custom_rules: b.custom_rules, business_type: b.business_type };
}
async function applyRules(clientId, rawText, parsed) {
  // parsed here is the flat legacy shape; wrap it
  return applyBrain(clientId, rawText, {
    payment: parsed, knowledge: [], custom_rules: parsed.custom_rules || [], business_type: parsed.business_type || null,
  });
}

module.exports = { analyzeBrain, applyBrain, analyzeRules, applyRules, fallbackPayment, fallbackKnowledge, fallbackRules, bnNorm, wordsToNumber };
