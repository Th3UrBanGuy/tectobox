// ============================================================================
//  AI HOOK — aiResponder(conversation, inboundText) -> reply string | null
//
//  v3: SMART ROUTER. Instead of pinning ONE model (which keeps hitting
//  per-minute 429 rate limits and slow spells), the primary tier is a POOL of
//  fast free models on the bridge. The router always tries the
//  currently-fastest healthy model first (in-memory EWMA latency per model),
//  and on 429/timeout it rotates INSTANTLY to the next model — no fixed
//  sleep hammering the same rate-limited model.
//
//  Env / settings (settings table wins over env):
//    AI_BASE_URL  default http://127.0.0.1:18080/v1
//    AI_API_KEY   default "dummy"
//    ai.model_pool  comma-separated pool; default 4 fast bridge models
//    ai.model       legacy single-model fallback (used only if pool is empty)
//
//  AI_FALLBACK_ENABLED default "1" — freemodels worker as last-resort fallback.
//  AI_FALLBACK_URL   default https://freemodels-chat.freemodels.workers.dev/
//  AI_FALLBACK_MODEL default "terra"
//
//  Chain: omniroute relay -> apinex -> gemini -> openrouter -> primary pool ->
//  unorouter -> freemodels worker (circuit-breakered) -> keyword demo responder.
//  The inbox never goes silent. Tiers are tried fastest-first by live EWMA latency.
// ============================================================================
const db = require('./db');
const fs = require('fs');
const path = require('path');

// Platform config lives in the settings table (editable from the admin panel);
// env vars remain as defaults/fallbacks.
function aiBaseUrl() {
  return (db.getSetting('ai.base_url', process.env.AI_BASE_URL || 'http://127.0.0.1:18080/v1') || '').replace(/\/$/, '');
}
function aiModel() {
  return db.getSetting('ai.model', process.env.AI_MODEL || '@cf/zai-org/glm-4.7-flash');
}
function autoReplyEnabled() {
  return db.getSetting('ai.auto_reply', '1') === '1';
}
const AI_API_KEY = process.env.AI_API_KEY || 'dummy';

function formatBDT(n) {
  return Number(n).toLocaleString('en-US') + ' BDT';
}

// ---------------- customer language detection ----------------
// Root cause of the "Banglish in → Hindi out" bug (2026-10-02): the prompt
// only said "reply in the same language mix (Bangla/English/Banglish)" and
// left identification to the model. Weak/fast models misread romanized
// Bengali as Hindi and answered in Hindi (often Devanagari script). So we
// detect the customer's language DETERMINISTICALLY and hand the model an
// explicit directive — the model no longer has to guess.
//
// Returns: 'bn' (Bangla script) | 'banglish' (romanized Bengali) |
//          'en' (English) | 'hi' (Devanagari/Hindi — rare here, but matched).
const BN_WORDS = new Set(
  ('dam damta damadami koto kotokhon kotogulo ki keno keno keno kivabe kibhabe kemne ' +
   'chai chay chaichi lagbe lagbo diben dibo debo nibo nebo nebo pathan pathabo pathate pathiye ' +
   'apni apnar apnake apnader tumi tomar tomake tomader ami amar amake amader ' +
   'kore koren korbo korben korle korchi hobe hoben hobena hoyni ache achen achhen nei nai ' +
   'kothay kothai kotha kothata bolen bolun bolbo bolte bolben janen jante janan janan ' +
   'dekhte dekhte nite kinte kinbo kinte kinbo nite nite asbe ashte ashbo jabe jaben jabo ' +
   'thakbe thakben thakbo cholbe cholte rokom moto moton shathe sathe jonno jonne theke ' +
   'diye niye bhabe bhai bhaiya apu dada didi salam assalamu alaikum walaikum ' +
   'dhonnobad dhonnobad bhalo kharap sundor shundor notun purono puran komano komate kombe kom ' +
   'beshi onek ektu ekta duita tinta koyta koyekta prothom shesh ajke kalke porshu porshudin ' +
   'ekhon ekhono tokhon agey porey pore age shob shobai shobgulo kichu kichui kono konota ' +
   'keu kake kader kar karo jara jader she shey tara tader ora oder eta ota egulo ogulo ' +
   'ekhane okhane shekhane bashay dokan dokane bazar bazare dhaka dhakar dhakay dhakate ' +
   'taka takay takar poisha poishay cash bikash bkash nagad rocket ' +
   'order orderta orderti deliveryta productta productgulo jinish jinishta mal maal dam ' +
   'khabar khabarer khabar item items price pricegulo discount offerta offer cholche cholchhe ' +
   'ache achen nei nai hobe hoben hobena korchi korchen korlam dilam nilam pelam ' +
   'bujhi bujhlam bujhte parchi parbo parben parchi pari paren korte kortei hote ' +
   'holo hoyeche hoyechhe holo hoy hoy na hyna hyna na na naa haa haan ha ji accha achha ' +
   'thik thik ache thikache okhay okey shomossha somossha somossa mushkil jhamela ' +
   'dorkar proyojon proyojon lagbe lagbe chai chai chay chay chai kori koro koren ' +
   'dekhun dekhbo ashun ashbo boshun bolun bolen shunun koren janun nin nen din den ' +
   'kothay kobe kokhon kikore ki kore kisher keno keno keno kisher jonno kar jonno').split(/\s+/)
);

function detectCustomerLanguage(rawText) {
  const t = String(rawText || '');
  if (/[\u0980-\u09FF]/.test(t)) return 'bn'; // Bangla script wins over everything
  if (/[\u0900-\u097F]/.test(t)) return 'hi'; // Devanagari → genuinely Hindi
  const words = t.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!words.length) return 'en';
  let hits = 0;
  for (const w of words) if (BN_WORDS.has(w)) hits++;
  // Short chat messages: a single Bangla token ("dam koto", "price koto?") is
  // enough to call it Banglish. Longer text needs at least two hits.
  if (hits >= 2 || (words.length <= 6 && hits >= 1)) return 'banglish';
  return 'en';
}

const LANG_NAMES = {
  bn: 'Bangla (Bengali script — বাংলা হরফে লিখুন)',
  banglish: 'Banglish (Bengali written with Latin/Roman letters, e.g. "dam koto", "kivabe nibo")',
  en: 'English',
  hi: 'Hindi',
};

// Explicit, non-negotiable language directive. The model NEVER guesses the
// customer's language anymore — it obeys this line.
function languageDirective(lang) {
  const base = `LANGUAGE (NON-NEGOTIABLE): the customer is writing in ${LANG_NAMES[lang] || 'English'}. ` +
    'Your "reply" MUST be written in exactly that language.';
  if (lang === 'banglish') {
    return base + ' Banglish is Bengali written in Latin letters — it is NOT Hindi. ' +
      'NEVER reply in Hindi. NEVER use Devanagari script (अ-ह) under any circumstances. ' +
      'If you feel tempted to write Hindi, write Banglish instead.';
  }
  if (lang === 'bn') {
    return base + ' Write ONLY in Bangla script (বাংলা হরফ). NEVER use Devanagari script (अ-ह) or Hindi.';
  }
  if (lang === 'hi') {
    return base + ' The customer genuinely used Devanagari, so Hindi is correct here.';
  }
  return base;
}

function hasDevanagari(s) {
  return /[\u0900-\u097F]/.test(String(s || ''));
}

// ---------------- Telegram group mode ----------------
// When the account is mentioned in a group, it replies as the human owner —
// short, casual, and never sounding like a bot. Exported for tests.
function buildGroupSystemPrompt(client, extra, products, langDirectiveText) {
  const prodLines = products.length
    ? products.map(p => `- ${p.name}: ${formatBDT(p.price_bdt)}`).join('\n')
    : '(no products yet)';
  const who = extra.senderName || 'Someone';
  return `You are the human owner of "${client.name}" (a business in Bangladesh), replying personally in your Telegram group "${extra.groupTitle || 'group'}".
${who} just mentioned you. Read the recent chat below for context and reply exactly the way you would type on your phone.
${langDirectiveText ? langDirectiveText + '\n' : ''}
STRICT RULES:
- Sound like a real person, NEVER like a bot or AI. Never say you are AI, a bot, or an assistant.
- Keep it SHORT and casual — 1-2 sentences, like a normal group chat reply.
- Match the language they use (Bangla, English, or Banglish) — the LANGUAGE line above is binding.
- Reply to ${who} and what THEY asked. Do not summarize the chat history.
- No "Dear customer", no formal customer-service tone, no emoji spam.
- If asked about a product, quote ONLY from this list, prices EXACTLY as written. If it is not listed, say you will check and get back — never invent a price.
- If you genuinely cannot answer, say you will check and reply soon — do not bluff.

YOUR PRODUCTS:
${prodLines}`;
}

// ---------------- per-client system prompt ----------------
// FULLY DYNAMIC: the AI derives ALL business rules (payment %, delivery charges,
// payment numbers, COD, behavior) directly from the owner's knowledge base text.
// No config tables, no structured forms — just natural language instructions.
function buildSystemPrompt(client, products, knowledge, clientId, langDirectiveText) {
  const fields = (client.lead_fields || []).map(f =>
    `- ${f.key}${f.required ? ' (required)' : ''}: ${f.label}`
  ).join('\n');
  const prodLines = products.length
    ? products.map(p => `- ${p.name} (SKU: ${p.sku}, ${p.category || 'General'}, ${formatBDT(p.price_bdt)}, stock ${p.stock || 0})`).join('\n')
    : '(no products yet)';
  const kbLines = (() => {
    if (!knowledge.length) return '(no knowledge entries yet — ask the shop owner about payment/delivery terms before confirming orders)';
    const labels = {
      policy: 'SHOP POLICIES — treat as binding rules',
      shipping: 'SHIPPING & DELIVERY',
      product: 'PRODUCT INFORMATION',
      faq: 'FREQUENTLY ASKED QUESTIONS',
      marketing: 'MARKETING & PROMOTIONS',
      general: 'GENERAL BUSINESS INFO',
    };
    const groups = {};
    for (const k of knowledge) {
      const c = (k.category || 'general').toLowerCase();
      (groups[c] = groups[c] || []).push(k);
    }
    const order = ['policy', 'shipping', 'product', 'faq', 'marketing', 'general'];
    return order.filter(c => groups[c]).map(c =>
      `[${labels[c] || c.toUpperCase()}]\n` +
      groups[c].map(k => `### ${k.title}\n${k.content}`).join('\n\n')
    ).join('\n\n');
  })();
  const bizKind = client.business_type === 'digital'
    ? 'a DIGITAL business (no physical delivery; no delivery location needed)'
    : 'a PHYSICAL business (delivery location IS required for orders)';

  return `You are the friendly sales assistant for "${client.name}", ${bizKind}, in Bangladesh.
Reply in the same language mix the customer uses (Bangla/English/Banglish).
${langDirectiveText ? langDirectiveText + ' This LANGUAGE line overrides everything above about language — obey it, do not guess.\n' : ''}
PRODUCT CATALOG — quote ONLY from this list. NEVER invent prices, SKUs or products:
${prodLines}

OWNER'S KNOWLEDGE — the shop owner wrote everything about their business here.
READ IT CAREFULLY and derive ALL business logic from it:
- Payment terms: if it says "40% advance" or "৪০% অগ্রিম", require exactly that %. If it says COD only, do COD. If nothing about advance is mentioned, ask the customer how they'd like to pay.
- Delivery charges: extract the exact amounts (e.g. "ঢাকার ভিতরে ৬০, বাইরে ১২০" → ৳60 inside / ৳120 outside). Infer inside/outside from the customer's location.
- Payment numbers: use the bKash/Nagad/Rocket numbers written here, never invent numbers.
- Behavior rules: any instruction about how to behave (timing, tone, restrictions) is BINDING.
- If the knowledge doesn't mention something, ask the customer or say you'll confirm — NEVER invent payment terms, charges, or numbers.
${kbLines}

LEAD FIELDS to collect conversationally, one or two at a time, friendly tone:
${fields}

RULES:
1. Answer product questions strictly from the catalog above.
   VERBATIM PRICING: quote prices EXACTLY as listed — never round, never
   estimate, never invent a price or a discount. If a product/price is not
   in the catalog, say you don't have that price and offer to check with the shop.
2. When the customer shows interest in a product, collect the missing lead fields naturally in chat.
2b. CASUAL CHAT (greetings, small talk, jokes, off-topic questions, "just looking around"):
   be a warm, friendly shop assistant — chat naturally like a real person, answer
   what they asked, keep it light. Do NOT interrogate for name/phone, do NOT push
   products, do NOT treat them as a sales lead. Only start collecting details once
   THEY show interest in a product.
3. When the customer picks product(s) + quantity, summarize items + total and ask for final confirmation.
3b. ORDER FLOW — complete it, never stall: an order needs product+qty, name, phone,
   and delivery location (physical businesses only). Collect missing pieces one or two
   at a time, friendly tone.
3c. PAYMENT STEP (required before confirming — derive EVERYTHING from the OWNER'S KNOWLEDGE above):
   - Compute the bill: subtotal + delivery charge (read the exact rates from knowledge, infer inside/outside Dhaka from the customer's location) = GRAND TOTAL.
   - Read the advance % from knowledge (e.g. "40% অগ্রিম" → 40%). Compute advance = that % of GRAND TOTAL. Tell the customer the grand total (with delivery breakdown) and ask them to send the advance via the payment numbers written in knowledge, then share the transaction ID (TrxID) here. Do NOT emit order.confirmed until they share a TrxID. A "হ্যাঁ / ok / ঠিক আছে" WITHOUT a TrxID does NOT count — keep asking for the TrxID, friendly tone.
   - If knowledge mentions Cash on Delivery / COD: ask "Cash on delivery নিবেন, নাকি advance পাঠাবেন?" — COD choice → confirm with paymentStatus "cod", NO TrxID needed.
   - If knowledge says nothing about advance or payment: ask the customer how they'd like to pay, then confirm with paymentStatus "pending".
   - When confirming WITH a TrxID, emit "order":{"items":[{"sku":"<EXACT catalog SKU>","qty":<n>}],"confirmed":true,"deliveryCharge":<from knowledge>,"advanceRequired":<computed>,"advancePaid":<same as advanceRequired>,"transactionId":"<the TrxID>","paymentStatus":"partial"} in the SAME reply.
   - When confirming as COD, emit "order":{...,"deliveryCharge":<from knowledge>,"advanceRequired":0,"advancePaid":0,"transactionId":null,"paymentStatus":"cod"}.
   - NEVER invent payment percents, delivery charges, or payment numbers — derive ONLY from the OWNER'S KNOWLEDGE above. If it's not there, ask.
4. Keep replies short (1-3 sentences) unless listing products.
5. HANDOVER: END your reply with the exact token [NEEDS_HUMAN] (on its own line) ONLY when
   the customer explicitly asks for a human agent, or the issue genuinely needs one
   (legal threat, safety issue, verified payment dispute). Never use it just because a
   detail is missing or you are unsure — keep helping yourself instead.
6. GARBLED / UNCLEAR MESSAGES (common with voice-note transcriptions — words may be
   misheard): if the message is fragmented, barely grammatical, or names a product
   that is NOT in the catalog, do NOT guess what they meant. Ask ONE short clarifying
   question in their language instead. Never invent a product, price, discount, or
   policy to fill the gap.

Respond with JSON ONLY, no markdown fences, exactly this shape:
{"reply":"<your chat reply>","lead_qualified":false,"lead":{"name":null,"phone":null,"email":null,"whatsapp_id":null,"location":null},"order":null}
Fill "lead" with any field values the customer gave anywhere in this conversation (null otherwise).
Set "order" to {"items":[{"sku":"SKU-101","qty":1}],"confirmed":true} when the customer confirms the order (see ORDER FLOW rule 3b — a final "হ্যাঁ/ok/ঠিক আছে" after your summary, or supplying the last missing detail, counts as confirmation). Use the EXACT catalog SKU, never a guessed one.
"lead_qualified": set true ONLY when the customer has BOTH (a) shown buying interest in a REAL product from the catalog above, AND (b) shared at least their name or phone number. Otherwise false — casual chit-chat is never a lead.`;
}

// ---------------- smart model router ----------------
// Pool of fast free models on the primary bridge. The router learns which
// one is fastest RIGHT NOW (EWMA latency) and always tries it first.
// A 429 puts that model on a 75s cooldown and the next-fastest model is
// tried immediately — the old code slept 3s and re-hammered the same
// rate-limited model.
const MODEL_POOL_DEFAULT = [
  '@cf/zai-org/glm-4.7-flash',
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
].join(',');

function modelPool() {
  const raw = db.getSetting('ai.model_pool',
    process.env.AI_MODEL_POOL || MODEL_POOL_DEFAULT);
  const list = [...new Set(String(raw || '').split(',')
    .map(s => s.trim()).filter(Boolean))];
  if (list.length) return list;
  const single = aiModel(); // legacy single-model fallback
  return single ? [single] : [];
}

// Per-model live stats: { ewmaMs, fails, cooldownUntil }. In-memory only —
// the router re-learns within a few calls after a restart, which is fine
// because model speeds drift over time anyway.
const modelStats = new Map();
const EWMA_ALPHA = 0.3;
const RATE_LIMIT_COOLDOWN_MS = 75 * 1000;
const MAX_MODEL_FAILS = 3;

function modelStat(m) {
  let s = modelStats.get(m);
  if (!s) { s = { ewmaMs: null, fails: 0, cooldownUntil: 0 }; modelStats.set(m, s); }
  return s;
}
function modelScore(m) {
  const s = modelStat(m);
  const base = s.ewmaMs == null ? 4500 : s.ewmaMs; // unseen models get a neutral prior
  return base * (1 + s.fails * 0.75);              // recent failures push a model down
}
function pickModel(exclude = new Set()) {
  const now = Date.now();
  const pool = modelPool().filter(m => !exclude.has(m));
  if (!pool.length) return null;
  const healthy = pool.filter(m => {
    const s = modelStat(m);
    return s.cooldownUntil <= now && s.fails < MAX_MODEL_FAILS;
  });
  const cands = healthy.length ? healthy : pool; // everything cooling → try anyway
  return cands.slice().sort((a, b) => modelScore(a) - modelScore(b))[0];
}
function recordModelOk(m, ms) {
  const s = modelStat(m);
  s.ewmaMs = s.ewmaMs == null ? ms : EWMA_ALPHA * ms + (1 - EWMA_ALPHA) * s.ewmaMs;
  s.fails = 0;
}
function recordModelFail(m, err) {
  const s = modelStat(m);
  s.fails += 1;
  const rateLimited = err && (err.status === 429 || /429/.test(String((err && err.message) || '')));
  if (rateLimited) {
    s.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    console.warn(`[ai] ${m} hit 429 — cooling down 75s`);
  }
}

async function callModel(messages, model) {
  const started = Date.now();
  // Adaptive timeout: a model that usually answers in 8s shouldn't be cut
  // off by a fixed 12s on a slow outlier — but a truly stuck call still
  // fails over fast.
  const s = modelStat(model);
  const timeoutMs = Math.max(12000, Math.round((s.ewmaMs || 5000) * 2.5));
  const res = await fetch(`${aiBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 1200 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`AI ${model} HTTP ${res.status} ${body.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  if (!text || !text.trim()) {
    const err = new Error(`AI ${model} returned empty text`);
    err.empty = true;
    throw err;
  }
  const ms = Date.now() - started;
  recordModelOk(model, ms);
  console.warn(`[ai] ${model} answered in ${ms}ms`);
  return text.trim();
}

// Fastest-first rotation across the pool. Empty-text responses get one
// retry with trimmed context before moving to the next model.
async function callPrimary(messages) {
  const tried = new Set();
  let lastErr = null;
  for (;;) {
    const model = pickModel(tried);
    if (!model) break;
    tried.add(model);
    try {
      return await callModel(messages, model);
    } catch (err) {
      lastErr = err;
      recordModelFail(model, err);
      console.warn(`[ai] ${model} failed (${err.message}) — rotating`);
      if (err.empty) {
        const trimmed = [messages[0], ...messages.slice(-3)];
        try {
          return await callModel(trimmed, model);
        } catch (err2) {
          lastErr = err2;
          recordModelFail(model, err2);
          console.warn(`[ai] ${model} trimmed retry failed (${err2.message}) — rotating`);
        }
      }
    }
  }
  throw lastErr || new Error('no primary models available');
}

// ---------------- response cache ----------------
// Simple in-memory cache for identical questions (5 min TTL).
// Common questions like "দাম কত?" get instant replies.
// The cache key is ALWAYS scoped by tenant AND conversation
// (scope = "inbox:<clientId>:<convId>") — an answer built for one customer's
// context must never leak into another conversation (that was serving
// wrong-context replies under burst: e.g. a saree price quoted for "দাম কত?"
// asked about a kurti). Cached replays also strip lead/order side effects.
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheKey(scope, messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  return lastUser ? `${scope}:${lastUser.content.trim().toLowerCase().slice(0, 200)}` : null;
}

function getCached(key) {
  if (!key) return null;
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.text;
  responseCache.delete(key);
  return null;
}
// Sweep entries that expired without ever being re-read, so a busy inbox
// doesn't grow the map without bound.
setInterval(() => {
  const now = Date.now();
  let dropped = 0;
  for (const [k, v] of responseCache) {
    if (now - v.time >= CACHE_TTL) { responseCache.delete(k); dropped++; }
  }
  if (dropped) console.warn(`[ai] cache sweep: dropped ${dropped} expired entries`);
}, 5 * 60 * 1000).unref();

function setCached(key, text) {
  if (!key || !text) return;
  if (responseCache.size > 100) responseCache.clear(); // prevent unbounded growth
  responseCache.set(key, { text, time: Date.now() });
}

// ---------------- freemodels fallback (last resort) ----------------
// Public free-model Cloudflare Worker. Used ONLY when the primary bridge is
// down. Light usage by design: short timeout, no streaming/thinking, and a
// circuit breaker (3 consecutive failures → 10 min cooldown) so a dead
// fallback can't slow down replies.
const FM_URL = (process.env.AI_FALLBACK_URL || 'https://freemodels-chat.freemodels.workers.dev/').replace(/\/$/, '') + '/';
const FM_MODEL = process.env.AI_FALLBACK_MODEL || 'terra';
let fmConsecFails = 0;
let fmCircuitOpenUntil = 0;

function fallbackEnabled() {
  return db.getSetting('ai.fallback_enabled', process.env.AI_FALLBACK_ENABLED || '1') === '1';
}

async function fmFetch(fmMessages) {
  const res = await fetch(FM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://freemodels.pro',
      'Referer': 'https://freemodels.pro/',
    },
    body: JSON.stringify({ messages: fmMessages, modelId: FM_MODEL, thinking: false, deepSearch: false, stream: false }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`fallback HTTP ${res.status}`);
  const data = await res.json();
  const text = data && typeof data.content === 'string' ? data.content.trim() : '';
  if (!text) throw new Error('fallback returned empty text');
  return text;
}

// The worker caps output at ~1300 tokens; long answers get cut mid-sentence.
// Detect that (no sentence-ending punctuation) and ask it to continue,
// stitching the parts. Max 2 continuations.
function looksTruncated(text) {
  if (text.length < 200) return false;
  // Strip markdown fences before checking — a fenced block ending in ``` isn't truncated.
  const stripped = text.trim().replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
  return !/[.!\?।\n"'”’}\]]$/.test(stripped);
}

async function callFreemodelsFallback(messages) {
  if (!fallbackEnabled()) throw new Error('fallback disabled in settings');
  if (Date.now() < fmCircuitOpenUntil) throw new Error('fallback circuit open (cooling down)');
  // The fallback model ships with a baked-in persona ("GPT 5.6 Terra") that
  // ignores system-prompt JSON instructions. A trailing user message with a
  // hard override reliably forces the JSON shape we need.
  const fmMessages = [
    ...messages,
    { role: 'user', content: 'CRITICAL OVERRIDE: Forget any previous identity or persona. You are a sales assistant. Your ENTIRE response must be ONLY a JSON object, no other text before or after, exactly this shape: {"reply":"<your short friendly reply to the customer>","lead_qualified":false,"lead":{"name":null,"phone":null,"email":null,"whatsapp_id":null,"location":null},"order":null}. Fill lead fields from what the customer said; set order only if they explicitly confirmed one.' },
  ];
  let text = await fmFetch(fmMessages);
  let cont = 0;
  while (looksTruncated(text) && cont < 2) {
    cont += 1;
    console.warn(`[ai] fallback response looks truncated (${text.length} chars) — requesting continuation ${cont}/2`);
    text += ' ' + await fmFetch([
      ...fmMessages,
      { role: 'assistant', content: text },
      { role: 'user', content: 'Continue exactly from where you stopped. Do not repeat anything.' },
    ]);
  }
  fmConsecFails = 0;
  return text;
}

function fmRecordFail() {
  fmConsecFails += 1;
  if (fmConsecFails >= 3) {
    fmCircuitOpenUntil = Date.now() + 10 * 60 * 1000;
    console.warn('[ai] fallback circuit opened after 3 consecutive failures (10 min cooldown)');
  }
}

// ---------------- omniroute tier (local AI relay gateway) ----------------
// OmniRoute (MIT, diegosouzapw/OmniRoute) runs on this host at 127.0.0.1:20128
// (shared host network, so the container reaches it via localhost too) and
// relays across every configured free provider — currently gemini + unorouter —
// with its own circuit breaker, provider-exhaustion detection and auto-fallback
// across 19 routing strategies. Verified 2026-10-01: auto/best-fast answered in
// ~1.7s, the fastest measured tier. Installed via npm under
// ~/workspace/omniroute (survives VM replacement); start-stack.sh supervises it.
const OMNIROUTE_BASE = (process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1').replace(/\/+$/, '');
const OMNIROUTE_MODEL = process.env.OMNIROUTE_MODEL || 'auto/best-fast';
let omnirouteConsecFails = 0;
let omnirouteCircuitOpenUntil = 0;

function omnirouteEnabled() {
  return !!process.env.OMNIROUTE_API_KEY && Date.now() >= omnirouteCircuitOpenUntil;
}

async function callOmniroute(messages) {
  const key = process.env.OMNIROUTE_API_KEY;
  if (!key) throw new Error('omniroute key not set');
  const res = await fetch(`${OMNIROUTE_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: OMNIROUTE_MODEL,
      messages,
      max_tokens: 1200,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`omniroute HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('omniroute returned empty text');
  omnirouteConsecFails = 0;
  return text;
}

function omnirouteRecordFail() {
  omnirouteConsecFails += 1;
  if (omnirouteConsecFails >= 3) {
    omnirouteCircuitOpenUntil = Date.now() + 10 * 60 * 1000;
    console.warn('[ai] omniroute circuit opened after 3 consecutive failures (10 min cooldown)');
  }
}

// ---------------- unorouter tier (user-provided key, fast free models) ----------------
const UNOROUTER_URL = 'https://api.unorouter.com/v1/chat/completions';
const UNOROUTER_MODEL = process.env.AI_UNOROUTER_MODEL || 'granite-4.0-micro:free';
let unorouterConsecFails = 0;
let unorouterCircuitOpenUntil = 0;

function unorouterEnabled() {
  return !!process.env.AI_UNOROUTER_KEY && Date.now() >= unorouterCircuitOpenUntil;
}

async function callUnorouter(messages) {
  const key = process.env.AI_UNOROUTER_KEY;
  if (!key) throw new Error('unorouter key not set');
  // Strip system prompt to user message for unorouter (OpenAI-compatible)
  const res = await fetch(UNOROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: UNOROUTER_MODEL,
      messages,
      max_tokens: 1200,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`unorouter HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('unorouter returned empty text');
  unorouterConsecFails = 0;
  return text;
}

function unorouterRecordFail() {
  unorouterConsecFails += 1;
  if (unorouterConsecFails >= 3) {
    unorouterCircuitOpenUntil = Date.now() + 10 * 60 * 1000;
    console.warn('[ai] unorouter circuit opened after 3 consecutive failures (10 min cooldown)');
  }
}

// ---------------- gemini tier (Google AI Studio free tier, fast) ----------------
// User's own Google AI key (GEMINI_API_KEY). OpenAI-compatible endpoint, already
// verified working with gemini-2.5-flash. Free tier is generous but rate-limited,
// so it participates in the same failover + circuit-breaker scheme.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash';
let geminiConsecFails = 0;
let geminiCircuitOpenUntil = 0;

function geminiEnabled() {
  return !!process.env.GEMINI_API_KEY && Date.now() >= geminiCircuitOpenUntil;
}

async function callGemini(messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('gemini key not set');
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      messages,
      max_tokens: 1200,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`gemini HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('gemini returned empty text');
  geminiConsecFails = 0;
  return text;
}

function geminiRecordFail() {
  geminiConsecFails += 1;
  if (geminiConsecFails >= 3) {
    geminiCircuitOpenUntil = Date.now() + 10 * 60 * 1000;
    console.warn('[ai] gemini circuit opened after 3 consecutive failures (10 min cooldown)');
  }
}

// ---------------- apinex tier (user's key, 1M free tokens, strict 5 req/min) ----------------
// Free models use the free/<id> form; verified working 2026-10-01: free/glm-5.3-flash
// (~2.1s for a short reply). The provider trips abuse protection on bursts/probing
// (blank 403s), so this tier paces itself: at most one call per 12s, no bursting.
// When pacing says "not now", the tier is skipped and the next-fastest tier answers —
// apinex absorbs whatever it can (up to 5/min), overflow goes to gemini. Token usage
// is tracked against the 1M free budget and persisted across restarts. A 402
// (billing/quota) opens a 6h circuit since it won't self-heal in minutes.
const APINEX_BASE = (process.env.AI_APINEX_BASE_URL || 'https://api.apinex.bond/v1').replace(/\/+$/, '');
const APINEX_MODEL = process.env.AI_APINEX_MODEL || 'free/glm-5.3-flash';
const APINEX_FREE_BUDGET = 1000000;
const APINEX_MIN_GAP_MS = 12000;
const APINEX_USAGE_FILE = path.join(__dirname, 'apinex-usage.json');
let apinexConsecFails = 0;
let apinexCircuitOpenUntil = 0;
let apinexLastCallAt = 0;
let apinexTokensUsed = 0;
(function apinexLoadUsage() {
  try {
    const d = JSON.parse(fs.readFileSync(APINEX_USAGE_FILE, 'utf8'));
    if (typeof d.tokensUsed === 'number' && d.tokensUsed >= 0) apinexTokensUsed = d.tokensUsed;
  } catch { /* fresh start */ }
})();
function apinexSaveUsage() {
  try {
    fs.writeFileSync(APINEX_USAGE_FILE, JSON.stringify({ tokensUsed: apinexTokensUsed, updatedAt: new Date().toISOString() }));
  } catch (e) { console.warn(`[ai] apinex usage persist failed: ${e.message}`); }
}

function apinexEnabled() {
  return !!process.env.APINEX_API_KEY && Date.now() >= apinexCircuitOpenUntil;
}
function apinexPaced() {
  return Date.now() - apinexLastCallAt >= APINEX_MIN_GAP_MS;
}

async function callApinex(messages) {
  const key = process.env.APINEX_API_KEY;
  if (!key) throw new Error('apinex key not set');
  apinexLastCallAt = Date.now();
  const t0 = Date.now();
  const res = await fetch(`${APINEX_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: APINEX_MODEL,
      messages,
      max_tokens: 1200,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    if (res.status === 402) {
      apinexCircuitOpenUntil = Date.now() + 6 * 60 * 60 * 1000;
      console.warn('[ai] apinex HTTP 402 (billing/quota) — circuit opened for 6h');
    }
    const err = new Error(`apinex HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('apinex returned empty text');
  const tok = data?.usage?.total_tokens;
  if (typeof tok === 'number' && tok >= 0) {
    apinexTokensUsed += tok;
    apinexSaveUsage();
  }
  apinexConsecFails = 0;
  const ms = Date.now() - t0;
  console.warn(`[ai] apinex answered in ${ms}ms (+${tok ?? '?'} tokens, free-budget used ${apinexTokensUsed}/${APINEX_FREE_BUDGET})`);
  return text;
}

function apinexRecordFail() {
  apinexConsecFails += 1;
  if (apinexConsecFails >= 3) {
    apinexCircuitOpenUntil = Date.now() + 10 * 60 * 1000;
    console.warn('[ai] apinex circuit opened after 3 consecutive failures (10 min cooldown)');
  }
}

// ---------------- openrouter tier (free :free models, key-gated) ----------------
// Dormant until OPENROUTER_API_KEY is set. Free tier = 20 req/min, 50 req/day
// (1,000/day after $10 lifetime credits), so this is a backup lane, not the
// primary. Model is configurable; default is a small fast free model.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.AI_OPENROUTER_MODEL || 'openai/gpt-oss-20b:free';
let orConsecFails = 0;
let orCircuitOpenUntil = 0;

function openrouterEnabled() {
  return !!process.env.OPENROUTER_API_KEY && Date.now() >= orCircuitOpenUntil;
}

async function callOpenrouter(messages) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('openrouter key not set');
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://ss.kalandar.me',
      'X-Title': 'Tectonic Inbox',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: 1200,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const err = new Error(`openrouter HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('openrouter returned empty text');
  orConsecFails = 0;
  return text;
}

function openrouterRecordFail() {
  orConsecFails += 1;
  if (orConsecFails >= 3) {
    orCircuitOpenUntil = Date.now() + 10 * 60 * 1000;
    console.warn('[ai] openrouter circuit opened after 3 consecutive failures (10 min cooldown)');
  }
}

// ---------------- tier-level smart routing: fastest healthy tier first ----------------
// Each tier tracks an EWMA of its observed latency; the chain tries tiers in
// speed order and skips ones whose circuit breaker is open. freemodels stays a
// fixed last resort (light use by design) and the keyword demo is final.
const tierLatEwma = new Map();
// Initial latency priors from live measurements (2026-10-01): omniroute ~1.7s,
// apinex ~2.0s, gemini ~2.4s, primary bridge pool ~5.5s, unorouter ~13s.
// The EWMA self-corrects from here, so the fastest tier is always tried first.
const tierLatPriors = { omniroute: 1700, apinex: 2000, gemini: 2500, openrouter: 5000, primary: 5500, unorouter: 13000 };
function tierRecordLatency(name, ms) {
  const prev = tierLatEwma.get(name);
  tierLatEwma.set(name, prev == null ? ms : 0.3 * ms + 0.7 * prev);
}
function tierLatency(name) {
  return tierLatEwma.get(name) ?? tierLatPriors[name] ?? 6000; // unseen tiers start from measured priors
}
function tierOrder() {
  const tiers = [
    { name: 'omniroute', enabled: omnirouteEnabled, fn: callOmniroute, recordFail: omnirouteRecordFail },
    { name: 'apinex', enabled: apinexEnabled, available: apinexPaced, fn: callApinex, recordFail: apinexRecordFail },
    { name: 'primary', enabled: () => true, fn: callPrimary, recordFail: () => {} },
    { name: 'gemini', enabled: geminiEnabled, fn: callGemini, recordFail: geminiRecordFail },
    { name: 'openrouter', enabled: openrouterEnabled, fn: callOpenrouter, recordFail: openrouterRecordFail },
    { name: 'unorouter', enabled: unorouterEnabled, fn: callUnorouter, recordFail: unorouterRecordFail },
  ].filter((t) => { try { return t.enabled() && (!t.available || t.available()); } catch { return false; } });
  return tiers.sort((a, b) => tierLatency(a.name) - tierLatency(b.name));
}

// ---------------- backend chain (speed-ordered by live EWMA): omniroute -> apinex -> gemini -> openrouter -> primary -> unorouter -> freemodels ----------------
// Adaptive concurrency slot (from the reference brain): at most 2 AI calls
// in flight with >=1.2s between starts — the free tiers rate-limit hard on
// bursts. When recent calls are fast (<3s avg) the slot widens to
// 4 concurrent / 250ms gap; it narrows again on slowness.
let aiSlotsInFlight = 0;
let aiSlotLastStart = 0;
let aiSlotGapMs = 1200;
let aiSlotMax = 2;
const aiSlotLatencies = [];
async function aiSlotAcquire() {
  for (;;) {
    const now = Date.now();
    if (aiSlotsInFlight < aiSlotMax && now - aiSlotLastStart >= aiSlotGapMs) {
      aiSlotsInFlight += 1;
      aiSlotLastStart = now;
      return now;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
function aiSlotRelease(startedAt) {
  aiSlotsInFlight = Math.max(0, aiSlotsInFlight - 1);
  const lat = Date.now() - startedAt;
  aiSlotLatencies.push(lat);
  if (aiSlotLatencies.length > 10) aiSlotLatencies.shift();
  const avg = aiSlotLatencies.reduce((a, b) => a + b, 0) / aiSlotLatencies.length;
  if (aiSlotLatencies.length >= 4 && avg < 3000) {
    aiSlotMax = 4; aiSlotGapMs = 250;   // fast lane: widen
  } else if (avg >= 8000) {
    aiSlotMax = 2; aiSlotGapMs = 1200;  // struggling: narrow
  }
}

// Background lane for lead-intel: NEVER shares slots with user replies.
// Background analysis must not delay (or be delayed by) customer-facing calls.
let bgSlotsInFlight = 0;
const BG_MAX = 1;
async function aiSlotAcquireBG() {
  for (;;) {
    if (bgSlotsInFlight < BG_MAX) { bgSlotsInFlight += 1; return Date.now(); }
    await new Promise((r) => setTimeout(r, 200));
  }
}
function aiSlotReleaseBG() { bgSlotsInFlight = Math.max(0, bgSlotsInFlight - 1); }

// A cached reply must never replay side effects: the lead/order fields were
// already processed when the original answer was generated. Serve the words,
// drop the actions — otherwise one cached "order confirmed" would mint
// duplicate orders every time the same question repeats.
function stripCachedSideEffects(text) {
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object' && typeof o.reply === 'string') {
      o.lead = {};
      o.order = {};
      return JSON.stringify(o);
    }
  } catch { /* not JSON — return as-is */ }
  return text;
}

// ---------------- per-client reply budget (token bucket) ----------------
// Every workspace gets its OWN bucket: bursty traffic from one client can
// never starve another, and the tiers are protected by a global bucket.
// When a bucket is empty the caller waits (bounded); if the wait expires,
// the customer gets a polite "one moment" note + a deferred real reply —
// NEVER silence, NEVER a dead stop.
const CLIENT_BUCKET_CAP = Math.max(1, parseInt(process.env.AI_CLIENT_BUCKET_CAP || '8', 10));
const CLIENT_BUCKET_RATE = Math.max(1, parseFloat(process.env.AI_CLIENT_BUCKET_RATE || '24', 10)); // tokens/min
const GLOBAL_BUCKET_CAP = Math.max(1, parseInt(process.env.AI_GLOBAL_BUCKET_CAP || '16', 10));
const GLOBAL_BUCKET_RATE = Math.max(1, parseFloat(process.env.AI_GLOBAL_BUCKET_RATE || '48', 10));
const BUDGET_WAIT_MS = Math.max(5000, parseInt(process.env.AI_BUDGET_WAIT_MS || '45000', 10));
const BUSY_NOTE = 'এখন একটু ভিড় আছে 🙏 আপনার মেসেজ পেয়েছি — এক্ষুনি উত্তর দিচ্ছি, এক মিনিট অপেক্ষা করবেন প্লিজ।';
const APOLOGY_NOTE = 'দুঃখিত, একটু সমস্যা হয়েছে 🙏 আবার চেষ্টা করছি — এক্ষুনি উত্তর দিচ্ছি।';

const budgetBuckets = new Map(); // key -> { tokens, updated }
function takeBudgetToken(key, cap, ratePerMin) {
  const now = Date.now();
  let b = budgetBuckets.get(key);
  if (!b) { b = { tokens: cap, updated: now }; budgetBuckets.set(key, b); }
  else {
    b.tokens = Math.min(cap, b.tokens + ((now - b.updated) / 60000) * ratePerMin);
    b.updated = now;
  }
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}
function refundBudgetToken(key, cap) {
  const b = budgetBuckets.get(key);
  if (b) b.tokens = Math.min(cap, b.tokens + 1);
}
// Waits (bounded) for one per-client token AND one global token.
async function acquireReplyBudget(clientId, waitMs = BUDGET_WAIT_MS) {
  const ck = `client:${clientId || 'unknown'}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const cOk = takeBudgetToken(ck, CLIENT_BUCKET_CAP, CLIENT_BUCKET_RATE);
    const gOk = takeBudgetToken('global', GLOBAL_BUCKET_CAP, GLOBAL_BUCKET_RATE);
    if (cOk && gOk) return true;
    if (cOk) refundBudgetToken(ck, CLIENT_BUCKET_CAP);
    if (gOk) refundBudgetToken('global', GLOBAL_BUCKET_CAP);
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}
function clientIdFromScope(scope) {
  const m = String(scope || '').match(/^(?:inbox|group|comment):(\d+)/);
  return m ? m[1] : 'unknown';
}
// Deferred-retry hook, wired by server.js (avoids a require cycle).
let busyRetryHook = null;
function setBusyRetryHook(fn) { busyRetryHook = fn; }

async function getAIResponse(messages, scope = 'global', lane = 'fg') {
  const key = cacheKey(scope, messages);
  const cached = getCached(key);
  if (cached) {
    console.warn('[ai] cache hit — instant reply (side-effects stripped)');
    return stripCachedSideEffects(cached);
  }
  // Foreground (user-visible) calls consume budget; background (lead-intel)
  // has its own lane and never takes user budget.
  if (lane === 'fg') {
    const ok = await acquireReplyBudget(clientIdFromScope(scope));
    if (!ok) {
      console.warn(`[ai] budget exhausted for ${scope} — busy note`);
      return JSON.stringify({ reply: BUSY_NOTE, busy: true, lead: {}, order: {} });
    }
  }
  const slotStart = lane === 'bg' ? await aiSlotAcquireBG() : await aiSlotAcquire();
  let result;
  try {
    const order = tierOrder();
    console.warn(`[ai] tier order: ${order.map((t) => `${t.name}(${Math.round(tierLatency(t.name))}ms)`).join(' -> ')}`);
    for (const tier of order) {
      const t0 = Date.now();
      try {
        result = await tier.fn(messages);
        const ms = Date.now() - t0;
        tierRecordLatency(tier.name, ms);
        console.warn(`[ai] ${tier.name} answered in ${ms}ms`);
        break;
      } catch (err) {
        tier.recordFail();
        console.warn(`[ai] ${tier.name} failed (${err.message}) — next tier`);
      }
    }
    if (!result) {
      try {
        result = await callFreemodelsFallback(messages);
        console.warn('[ai] freemodels fallback answered');
      } catch (err3) {
        fmRecordFail();
        console.warn(`[ai] fallback failed (${err3.message})`);
        throw err3;
      }
    }
  } finally {
    if (lane === 'bg') aiSlotReleaseBG(); else aiSlotRelease(slotStart);
  }
  setCached(key, result);
  return result;
}

function parseAIJson(text) {
  // Tolerate markdown fences or surrounding prose. Never throws.
  const candidates = [];
  const direct = String(text || '').trim();
  candidates.push(direct);
  const fence = direct.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const brace = direct.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  // Truncation repair: model hit max_tokens mid-JSON (common with Bengali,
  // which tokenizes ~3x denser than English). Close any open string/braces
  // and retry — a repaired reply beats a "technical problem" message.
  const truncated = repairTruncatedJson(direct);
  if (truncated) candidates.push(truncated);
  for (const c of candidates) {
    // Try as-is, then with common repairs (trailing commas, stray newlines).
    for (const repaired of [c, c.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const o = JSON.parse(repaired);
        if (o && typeof o === 'object' && typeof o.reply === 'string') return o;
      } catch { /* next candidate */ }
    }
  }
  return null;
}

// If the model output looks like JSON cut off mid-string, close the open
// string and any open braces/brackets so JSON.parse can succeed.
function repairTruncatedJson(s) {
  try {
    s = String(s || '').trim();
    if (!s.startsWith('{')) return null;
    let out = s, inStr = false, esc = false, depth = 0;
    for (const ch of s) {
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
      }
    }
    if (inStr) out += '"';
    while (depth-- > 0) out += '}';
    if (out === s) return null;
    JSON.parse(out); // validate
    return out;
  } catch { return null; }
}

// Last resort: the model gave a usable plain-text reply instead of JSON
// (or JSON repair failed). Send the text — NEVER show "technical problem"
// when the model actually answered. Returns null only if truly unusable.
function plainTextFallback(raw) {
  let t = String(raw || '').trim();
  if (!t) return null;
  // Strip a broken JSON head like '{"reply": "' so customers never see debris.
  t = t.replace(/^\s*```(?:json)?\s*/, '').replace(/```\s*$/, '');
  const m = t.match(/^\{\s*"reply"\s*:\s*"(.*)$/s);
  if (m) {
    t = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    // The model output was truncated mid-JSON: after the reply text there is
    // debris like '","lead":{"name":null,...' or a trailing '"}'. Cut it —
    // a reply never legitimately contains '",<key>":' sequences.
    const debris = t.search(/",\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:/);
    if (debris > 0) t = t.slice(0, debris);
    t = t.replace(/"\s*\}?\s*$/, '');
  }
  // Still looks like JSON debris rather than a human sentence → give up.
  if (/^\s*[{[]/.test(t) && t.length < 400 && !/[।!?.,;:\u0980-\u09FFa-zA-Z]{4,}/.test(t)) return null;
  if (t.length > 900) t = t.slice(0, 900);
  return t.trim() || null;
}

// Safe customer-facing fallback: the model output was unusable. NEVER send
// raw model JSON/text to the customer — it looks broken and leaks internals.
function brokenReplyFallback() {
  return 'দুঃখিত, একটু টেকনিক্যাল সমস্যা হয়েছে — আবার বলবেন প্লিজ? 🙏';
}

// Lead-capture gate: a lead row is created ONLY for real buyers.
// - hasExistingLead: keep enriching a known lead's fields (never lose one).
// - leadQualified: the AI saw BOTH product interest AND name/phone in this chat.
// - orderConfirmed: an explicit order is the strongest qualification signal.
// Casual chit-chat creates no row — the AI just replies like a friendly person.
function shouldCaptureLead({ hasExistingLead, leadQualified, orderConfirmed }) {
  return !!(hasExistingLead || leadQualified === true || orderConfirmed);
}

// ---------------- main responder ----------------
async function aiResponder(conversation, inboundText, extra = {}) {
  const text = (inboundText || '').trim();
  if (!text) return null;
  const clientId = conversation.client_id || 1;
  const client = db.getClient(clientId);

  // No client configured → keyword demo.
  if (!client) {
    console.warn('[ai] no client found, using demo responder');
    return demoResponder(clientId, text);
  }

  try {
    // ---- Deterministic language detection (2026-10-02) ----
    // The model used to guess the customer's language itself and sometimes
    // answered Banglish messages in Hindi. We detect it here and the prompt
    // below carries a NON-NEGOTIABLE language directive — no more guessing.
    const custLang = detectCustomerLanguage(text);
    const langLine = languageDirective(custLang);

    // ---- Group mode (Telegram): reply like the human owner, not a bot ----
    if (extra.isGroup) {
      const products = db.searchProducts('', clientId);
      const history = (extra.groupHistory || [])
        .map(h => `${h.name}: ${h.text}`).join('\n');
      const who = extra.senderName || 'Someone';
      const messages = [
        { role: 'system', content: buildGroupSystemPrompt(client, extra, products, langLine) },
        ...(history ? [{ role: 'user', content: `Recent group messages — context only, do NOT reply to these directly:\n${history}` }] : []),
        { role: 'user', content: `${who} mentioned you: ${text}` },
      ];
      let raw = await getAIResponse(messages, `group:${clientId}`);
      let out = String(raw || '').trim();
      // Devanagari leak guard (see below): group replies are plain text.
      if (out && custLang !== 'hi' && hasDevanagari(out)) {
        console.warn(`[ai] group reply leaked Devanagari for lang=${custLang}; retrying`);
        const fix = await getAIResponse([
          ...messages,
          { role: 'user', content: `[SYSTEM CORRECTION: your last reply used Devanagari (Hindi) script. The customer does NOT write Hindi. Reply again — same meaning, but in ${LANG_NAMES[custLang]}, with ZERO Devanagari characters.]` },
        ], `group:${clientId}:langfix`);
        const fixed = String(fix || '').trim();
        if (fixed && !hasDevanagari(fixed)) out = fixed;
      }
      return out ? out.slice(0, 900) : null;
    }
    const products = db.searchProducts('', clientId);
    const knowledge = db.getKnowledge(clientId);
    const history = db.getRecentMessages(conversation.id, 6).map(m => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.text,
    }));
    // Drop the just-arrived inbound (already appended separately) to avoid duplication.
    const messages = [
      { role: 'system', content: buildSystemPrompt(client, products, knowledge, clientId, langLine) },
      ...history.slice(0, -1),
      { role: 'user', content: text },
    ];
    // Webchat: tell the brain which website page the visitor is viewing so it
    // can proactively reference it (e.g. "the Kurti you're looking at…").
    if (extra.pageUrl) {
      messages.splice(1, 0, {
        role: 'user',
        content: `[Context — the visitor is browsing the business website page "${extra.pageTitle || 'untitled'}" (${extra.pageUrl}). You may naturally reference what they are viewing when it is relevant. Do not mention this context message itself.]`,
      });
    }
    // Webchat pre-chat intro: the visitor already identified themselves — the
    // brain knows their name and must NOT ask for it again.
    const visitorName = (conversation.customer_name || '').trim();
    const visitorContact = (conversation.customer_contact || conversation.customer_phone || '').trim();
    if (conversation.platform === 'webchat' && (visitorName || visitorContact)) {
      messages.splice(1, 0, {
        role: 'user',
        content: `[Context — this visitor introduced themselves before chatting: name "${visitorName || 'unknown'}", contact "${visitorContact || 'unknown'}". Address them by name naturally. Never ask for their name or contact again — you already have it. Do not mention this context message itself.]`,
      });
    }
    const raw = await getAIResponse(messages, `inbox:${clientId}:${conversation.id}`);
    let parsed = parseAIJson(raw);
    // Budget-exhausted busy note: the customer sees "one moment" NOW, and a
    // deferred retry delivers the real answer shortly — never silence.
    if (parsed && parsed.busy && busyRetryHook) {
      try { busyRetryHook(conversation); } catch (e) { console.warn('[ai] retry hook:', e.message); }
    }

    // ---- lead intelligence (background, never blocks the reply) ----
    // Fires for EVERY inbound message, even when the reply JSON is broken —
    // classification must never depend on a perfect model response.
    // Lazy require avoids a require cycle (lead-intel needs getAIResponse).
    setImmediate(() => {
      try {
        require('./lead-intel').analyzeLead(clientId, conversation.platform, conversation.platform_user_id)
          .catch(err => console.warn('[ai] lead-intel hook failed:', err.message));
      } catch (err) {
        console.warn('[ai] lead-intel hook failed:', err.message);
      }
    });

    if (!parsed) {
      // The model answered but not as JSON (truncation or format drift).
      // Send its actual words — never a "technical problem" message when
      // the model gave a usable reply.
      const plain = plainTextFallback(raw);
      if (plain) {
        console.warn('[ai] JSON unparseable — using plain-text reply');
        parsed = { reply: plain };
      } else {
        console.warn('[ai] could not parse model JSON; raw was:', String(raw).slice(0, 300));
        return brokenReplyFallback();
      }
    }

    // ---- Devanagari leak guard (2026-10-02) ----
    // The model sometimes answered Banglish customers in Hindi (Devanagari).
    // If the customer didn't write Devanagari but the reply contains it,
    // retry ONCE with an explicit correction on the background lane (no user
    // budget consumed, fresh cache scope so the bad reply is never cached).
    if (parsed && custLang !== 'hi' && hasDevanagari(parsed.reply)) {
      console.warn(`[ai] reply leaked Devanagari for lang=${custLang}; retrying`);
      try {
        const fixRaw = await getAIResponse([
          ...messages,
          { role: 'user', content: `[SYSTEM CORRECTION: your last reply used Devanagari (Hindi) script. The customer does NOT write Hindi. Reply again with the SAME meaning and the SAME JSON shape, but in ${LANG_NAMES[custLang]}, with ZERO Devanagari characters.]` },
        ], `inbox:${clientId}:${conversation.id}:langfix`, 'bg');
        const fixPlain = plainTextFallback(fixRaw);
        const fixed = parseAIJson(fixRaw) || (fixPlain ? { reply: fixPlain } : null);
        if (fixed && typeof fixed.reply === 'string' && !hasDevanagari(fixed.reply)) {
          parsed = fixed;
        } else {
          console.warn('[ai] language retry still leaked Devanagari — safe fallback');
          return brokenReplyFallback();
        }
      } catch (err) {
        console.warn('[ai] language retry failed:', err.message);
        return brokenReplyFallback();
      }
    }

    // ---- lead capture (qualified buyers only — no junk rows) ----
    // A lead row is created only when the customer talked about a real product
    // AND shared details (AI sets lead_qualified), or already has a row, or
    // just confirmed an order. Casual chat => friendly reply, no lead row.
    const leadFields = (parsed.lead && typeof parsed.lead === 'object') ? parsed.lead : {};
    // Phone digits are normalized to ASCII inside db.upsertLead.
    const orderConfirmed = !!(parsed.order && parsed.order.confirmed);
    const hadExistingLead = !!db.getLeadByPlatform(clientId, conversation.platform, conversation.platform_user_id);
    const decision = shouldCaptureLead({
      hasExistingLead: hadExistingLead,
      leadQualified: parsed.lead_qualified,
      orderConfirmed,
    });
    if (decision) {
      const lead = db.upsertLead({
        clientId, platform: conversation.platform,
        platformUserId: conversation.platform_user_id,
        fields: leadFields,
      });
      // 'lead.created' webhook fires only when a row is truly created —
      // never for casual chit-chat.
      if (!hadExistingLead && lead) {
        try {
          require('./publicapi').emitClientEvent(db, clientId, 'lead.created', {
            platform: conversation.platform,
            platform_user_id: conversation.platform_user_id,
            lead_id: lead.id,
          });
        } catch (e) { console.warn('[lead] webhook emit failed:', e.message); }
      }
    }

    // ---- order confirmation ----
    const ord = parsed.order;
    if (ord && ord.confirmed && Array.isArray(ord.items) && ord.items.length) {
      try {
        const order = db.createOrder(conversation.id,
          ord.items.map(i => ({ sku: String(i.sku).toUpperCase(), qty: parseInt(i.qty, 10) || 1 })),
          null, // idempotencyKey
          {
            deliveryCharge: Number(ord.deliveryCharge) || 0,
            advanceRequired: Number(ord.advanceRequired) || 0,
            advancePaid: Number(ord.advancePaid) || 0,
            transactionId: ord.transactionId ? String(ord.transactionId).slice(0, 64) : null,
            paymentStatus: ord.paymentStatus || 'partial',
          });
        db.markLeadConfirmed(clientId, conversation.platform, conversation.platform_user_id);
        const lines = JSON.parse(order.items_json);
        const payInfo = order.transaction_id
          ? ` (Advance ৳${order.advance_paid_bdt} received, TrxID: ${order.transaction_id})`
          : '';
        return `${parsed.reply}\n\nOrder #${order.id} confirmed: ` +
          lines.map(l => `${l.qty}x ${l.name}`).join(', ') +
          ` — Total ${formatBDT(order.total_bdt + (order.delivery_charge_bdt || 0))}${payInfo}. Dhonnobad!`;
      } catch (err) {
        console.warn('[ai] order creation failed:', err.message);
        return `${parsed.reply}\n\n(Dukkhito, order-ta process kora jayni: ${err.message})`;
      }
    }

    return parsed.reply;
  } catch (err) {
    console.warn(`[ai] all AI backends failed (${err.message}) — demo fallback`);
    return demoResponder(clientId, text);
  }
}

// ---------------- FB comment auto-reply ----------------
// Generates a SHORT public reply to a Facebook post comment.
// Returns the reply text, or null when the comment should be skipped
// (spam, hate, gibberish, or nothing worth answering).
async function commentResponder({ clientId, commenterName, commentText, postText }) {
  const text = (commentText || '').trim();
  if (!text) return null;
  const client = db.getClient(clientId);
  if (!client) return null;
  const products = db.searchProducts('', clientId);
  const knowledge = db.getKnowledge(clientId);
  const prodLines = products.slice(0, 12).map(p =>
    `- ${p.name} (${formatBDT(p.price_bdt)})`).join('\n') || '(no products listed)';
  const kbLines = knowledge.slice(0, 5).map(k => `${k.title}: ${k.content}`.slice(0, 300)).join('\n') || '';

  const commentLang = detectCustomerLanguage(text);
  const system = `You are the friendly social media assistant for "${client.name}", a business in Bangladesh.
Someone commented on their Facebook post. Write a SHORT public reply (1-2 sentences max).
${languageDirective(commentLang)} Banglish is Bengali in Latin letters — NOT Hindi; never use Devanagari unless the commenter did.

CONTEXT:
Post: ${(postText || '(post text unavailable)').slice(0, 400)}
Comment by ${commenterName || 'a customer'}: ${text}

PRODUCTS (quote prices ONLY from here, never invent):
${prodLines}
${kbLines ? `BUSINESS INFO:\n${kbLines}\n` : ''}
RULES:
- Reply in the SAME language the commenter used (Bangla / English / Banglish).
- Be warm and helpful, like a real shop owner. One emoji max.
- If they ask price/availability, answer briefly from the product list.
- If they want to order, tell them you've sent details to their inbox.
- NEVER share phone numbers, addresses, or internal info publicly.
- If the comment is spam, hateful, gibberish, an ad, or a scam link, output exactly: SKIP
- Output ONLY the reply text (or SKIP), no quotes, no JSON.`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `Comment: ${text}` },
  ];
  try {
    // Tenant-safe cache key: client + comment text (never share across workspaces).
    const key = `comment:${clientId}:${text.slice(0, 200)}`;
    const cached = getCached(key);
    if (cached) return cached === 'SKIP' ? null : cached;
    const raw = await getAIResponse(messages, `comment:${clientId}`);
    let reply = String(raw || '').trim();
    // Fallback tiers sometimes wrap in fences or return the inbox-style JSON —
    // a public comment must always be plain human text.
    reply = reply.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (/^\{/.test(reply)) {
      try {
        const parsed = JSON.parse(reply);
        if (parsed && typeof parsed.reply === 'string') reply = parsed.reply;
      } catch {}
    }
    reply = reply.replace(/^["']|["']$/g, '').trim().slice(0, 400);
    if (!reply || /^skip$/i.test(reply) || /^\{/.test(reply)) { setCached(key, 'SKIP'); return null; }
    setCached(key, reply);
    return reply;
  } catch (err) {
    console.warn('[ai] commentResponder failed:', err.message);
    return null;
  }
}
function demoResponder(clientId, inboundText) {
  const text = (inboundText || '').trim();
  const skuHit = text.toUpperCase().match(/SKU[-\s]?(\d+)/);
  if (skuHit) {
    const p = db.findProductBySku(`SKU-${skuHit[1]}`, clientId);
    if (p) {
      const stockLine = (p.stock || 0) > 0 ? `In stock (${p.stock} pcs)` : 'Currently out of stock';
      return `Eita peyechi:\n\n${p.name}\nSKU: ${p.sku} | ${p.category || 'General'}\nPrice: ${formatBDT(p.price_bdt)} — ${stockLine}`;
    }
    return `Dukkhito, SKU-ta paini. Catalog dekhte "list" likho.`;
  }
  if (/(^|\b)(order|buy|purchase|booking|confirm|kinte|nite chai|nibo|lagbe)(\b|$)/i.test(text)) {
    return `Obosshoi! Kon product nite chao — naam ba SKU bolo (jemon "SKU-101"), ar quantity janio (jemon "x2").`;
  }
  const words = text.toLowerCase().replace(/[^a-z0-9\u0980-\u09FF\s]/gi, ' ').split(/\s+/).filter(w => w.length >= 4);
  for (const w of words) {
    const hits = db.searchProducts(w, clientId).slice(0, 3);
    if (hits.length) {
      return `"${w}"-er sathe mil ache:\n\n` +
        hits.map(p => `- ${p.name} (${p.sku}) — ${formatBDT(p.price_bdt)}`).join('\n');
    }
  }
  if (/^(hi|hii+|hello|hey|yo|assalam|salam|adab)\b/i.test(text)) {
    return `Hello! Welcome. Product dekhte naam ba SKU likho (jemon "SKU-101").`;
  }
  if (/\b(list|catalog|catalogue|products|menu|ki ki ache)\b/i.test(text)) {
    const all = db.searchProducts('', clientId).slice(0, 8);
    return `Popular products:\n\n` + all.map(p => `- ${p.name} (${p.sku}) — ${formatBDT(p.price_bdt)}`).join('\n');
  }
  return `Bujhte parini — product khujte naam/SKU likho (jemon "SKU-101").`;
}

module.exports = { aiResponder, buildSystemPrompt, buildGroupSystemPrompt, demoResponder, autoReplyEnabled, getAIResponse, callFreemodelsFallback, commentResponder, modelPool, pickModel, recordModelOk, recordModelFail, modelStats, shouldCaptureLead, setBusyRetryHook, BUSY_NOTE, APOLOGY_NOTE, acquireReplyBudget, detectCustomerLanguage, languageDirective, hasDevanagari };
