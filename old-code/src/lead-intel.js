// Lead Intelligence engine — marketing-agency-style AI scoring for the leads sheet.
//
// Runs OUTSIDE the chat reply path (background worker). After each inbound
// message a debounced analyzeLead() refreshes the lead's stage / score /
// product affinity / conversion prediction / next action. A periodic sweep
// (server.js) catches anything the hook missed.
//
// Tenant safety: every lookup is scoped by clientId. Nothing here ever sends
// a message to a customer — next_action is suggestion text for the operator.
const db = require('./db');
const { getAIResponse } = require('./ai');

const DEBOUNCE_MS = 15 * 60 * 1000; // skip re-analysis within 15 min unless forced
const MAX_MSG = 20;                 // messages fed to the intel prompt
const SWEEP_DELAY_MS = 2000;        // gap between sweep analyses (be gentle on the AI slot limiter)

const SYSTEM = `You are a senior performance-marketing analyst for a Bangladeshi social-commerce business.
You read a customer's chat history and score the lead. Reply with STRICT JSON only, no prose, no fences:
{"stage":"new|contacted|qualified|intent|verified|converted|lost|dormant",
 "score":0-100,
 "temperature":"hot|warm|cold",
 "product_affinity":[{"product":"<catalog name>","confidence":0-1}],
 "intent_summary":"<one short line: what the customer wants>",
 "predicted_value_bdt":<number>,
 "conversion_probability":<0-1>,
 "next_action":"<one short operator action, e.g. follow-up text suggestion>",
 "followup_due_at":"<ISO datetime or null>",
 "verification_state":"unverified|partial|verified",
 "reasoning":"<one line: why this score>"}

Scoring guidance (Bengali + English signals):
- price / delivery / stock / discount questions, product name mentions: +intent
- explicit intent words ("নিবো", "নিতে চাই", "অর্ডার করব", "পাঠিয়ে দিন", "দাম কত", "buy", "order", "price koto"): strong +
- contact details given (name/phone/address): +; phone looks like a real BD mobile: verification_state toward verified
- ordered before or explicitly confirmed an order: stage=converted, score 95+
- asked once then went silent, vague chatter, price-shock ("এত দাম!"), wrong-number: score low, stage lost/dormant
- responsiveness (quick back-and-forth) and budget signals ("বাজেট আছে", bulk qty): +
Temperature: hot >= 70, warm 40-69, cold < 40. Stages: new (just appeared), contacted (we replied), qualified (real need identified), intent (wants a specific product), verified (contact confirmed), converted (ordered), lost/dormant.
product_affinity: only products from the catalog below, max 3, confidence 0-1. predicted_value_bdt: likely order value from affinity prices. followup_due_at: when the operator should follow up (null if none needed). next_action is a suggestion for the human operator — never an auto-sent message.`;

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function findLead(clientId, platform, platformUserId) {
  return db.getLeads({ clientId }).find(
    l => l.platform === platform && String(l.platform_user_id) === String(platformUserId)
  ) || null;
}

function buildUserMessage(lead, conv, products, knowledge) {
  const msgs = conv
    ? db.getRecentMessages(conv.id, MAX_MSG).map(m =>
        `${m.direction === 'in' ? 'Customer' : 'Shop'}: ${trunc(m.text, 300)}`).join('\n')
    : '(no conversation found)';
  const catalog = (products || []).slice(0, 60).map(p =>
    `- ${p.name} (${p.price_bdt} BDT${p.category ? ', ' + p.category : ''}${p.stock != null ? ', stock ' + p.stock : ''})`
  ).join('\n') || '(empty catalog)';
  const kb = (knowledge || []).slice(0, 12).map(k =>
    `[${k.category || 'general'}] ${trunc(k.title, 60)}: ${trunc(k.content, 200)}`
  ).join('\n') || '(no knowledge base)';
  return [
    `Now (UTC): ${new Date().toISOString()}`,
    `Lead: name=${lead.name || '—'} phone=${lead.phone || '—'} email=${lead.email || '—'} location=${lead.location || '—'} platform=${lead.platform}`,
    `Current stage=${lead.stage || 'new'} score=${lead.score || 0} status=${lead.status}`,
    ``,
    `--- recent chat (oldest first) ---`,
    msgs,
    ``,
    `--- product catalog ---`,
    catalog,
    ``,
    `--- business context ---`,
    kb,
  ].join('\n');
}

const INTEL_KEYS = [
  'stage', 'score', 'temperature', 'product_affinity', 'intent_summary',
  'predicted_value_bdt', 'conversion_probability', 'next_action', 'followup_due_at',
];
function parseIntelJson(text) {
  // Strict: must look like intel output. Rejects chat-format replies
  // ({reply, lead, order}) that the AI fallback tier emits when the real
  // tiers are down — otherwise any JSON object would write an empty row.
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const shaped = INTEL_KEYS.some((k) => o[k] !== undefined && o[k] !== null);
    return shaped ? o : null;
  } catch { return null; }
}

// Analyze one lead. Never throws — failures are logged and swallowed so the
// chat path and sweeps can never crash because of intel.
async function analyzeLead(clientId, platform, platformUserId, { force = false } = {}) {
  try {
    const lead = findLead(clientId, platform, platformUserId);
    if (!lead) return { skipped: 'no-lead' };
    if (!force && lead.intel_updated_at) {
      const age = Date.now() - new Date(lead.intel_updated_at).getTime();
      if (age < DEBOUNCE_MS) return { skipped: 'debounced', leadId: lead.id };
    }
    const convs = db.getConversations({ clientId, platform })
      .filter(c => String(c.platform_user_id) === String(platformUserId));
    const conv = convs.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))[0] || null;

    const products = db.searchProducts('', clientId);
    const knowledge = db.getKnowledge(clientId);
    const raw = await getAIResponse(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUserMessage(lead, conv, products, knowledge) },
      ],
      `leadintel:${clientId}:${platform}:${platformUserId}`,
      'bg' // background lane: never competes with user-reply slots
    );
    const intel = parseIntelJson(raw);
    if (!intel) {
      console.warn('[lead-intel] unparseable AI output, skipping lead', lead.id);
      return { skipped: 'unparseable', leadId: lead.id };
    }
    // Ground-truth override: a real order row in the DB beats any AI guess.
    // If this conversation already produced an order, the lead IS a customer.
    try {
      if (conv && db.getOrdersByConversation(conv.id).length > 0) {
        intel.stage = 'converted';
        intel.temperature = 'hot';
        if (!(intel.score >= 95)) intel.score = 95;
        intel.conversion_probability = 1;
        if (!intel.intent_summary) intel.intent_summary = 'Order placed';
      }
    } catch { /* ground-truth check is best-effort */ }
    const updated = db.updateLeadIntel(lead.id, {
      stage: intel.stage,
      score: intel.score,
      temperature: intel.temperature,
      product_affinity_json: JSON.stringify(intel.product_affinity || []),
      intent_summary: intel.intent_summary,
      predicted_value_bdt: intel.predicted_value_bdt,
      conversion_probability: intel.conversion_probability,
      next_action: intel.next_action,
      followup_due_at: intel.followup_due_at,
      verification_state: intel.verification_state,
      source: lead.source || platform,
      last_intent_at: (intel.stage === 'intent' || intel.stage === 'verified' || intel.stage === 'converted')
        ? new Date().toISOString() : (lead.last_intent_at || null),
    });
    console.warn(`[lead-intel] lead ${lead.id} -> stage=${updated.stage} score=${updated.score} temp=${updated.temperature}`);
    return { ok: true, lead: updated };
  } catch (err) {
    console.warn('[lead-intel] analyzeLead failed:', err.message);
    return { skipped: 'error', error: err.message };
  }
}

// Background sweep: analyze stale leads sequentially with a small delay.
// Never throws.
async function sweepStaleLeads(limit = 20, { clientId = null } = {}) {
  const out = { analyzed: 0, skipped: 0 };
  try {
    const stale = db.getStaleIntelLeads(limit, { clientId });
    for (const lead of stale) {
      const r = await analyzeLead(lead.client_id, lead.platform, lead.platform_user_id);
      if (r.ok) out.analyzed++; else out.skipped++;
      await new Promise(res => setTimeout(res, SWEEP_DELAY_MS));
    }
  } catch (err) {
    console.warn('[lead-intel] sweep failed:', err.message);
  }
  return out;
}

module.exports = { analyzeLead, sweepStaleLeads, DEBOUNCE_MS };
