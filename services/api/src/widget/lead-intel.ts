/**
 * Lead intelligence from real chat — @tectonic/api widget (P15, 2026-11-15).
 *
 * The intake lead upsert used to hardcode score 20 / temperature 'warm'
 * and never filled `intent_summary`, `product_affinity_json`,
 * `predicted_value_bdt`, `conversion_probability` or `next_action` —
 * so all 50 leads in the audit looked identical (Customer "—", Wants
 * "—", Likely products "—", Convert 0%, Value ৳0) even though the chats
 * contained the data. This module extracts those signals
 * deterministically from the message text + the client's catalog, with
 * NO invented data: when the chat says nothing, every field stays at
 * its empty/zero default — never a placeholder.
 *
 * Scoring (transparent, no ML claims):
 *  - +30 when the message names a catalog product (affinity),
 *  - +20 when it states an intent (buy / price / order / delivery),
 *  - +10 when a phone number is present in the message,
 *  - +10 when a quantity is mentioned.
 * Temperature: score >= 60 → 'hot', >= 35 → 'warm', else 'cold'.
 * Conversion probability is score/100. Predicted value is the
 * affinity product's price × quantity (1 when no quantity given).
 */
export interface ProductLike {
  id?: number;
  name: string;
  price_bdt: number | string;
  stock?: number;
}

export interface LeadSignals {
  /** Product the customer is talking about, if any. */
  productAffinity: { productId?: number; name: string; priceBdt: number; quantity: number }[];
  intentSummary: string;
  score: number;
  temperature: 'hot' | 'warm' | 'cold';
  predictedValueBdt: number;
  conversionProbability: number;
  nextAction: string;
}

const INTENT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /buy|order|kinte|cah|chai|lagbe|কিনতে|কিনবো|অর্ডার|চাই|লাগবে/i, label: 'wants to buy' },
  { re: /price|koto|দাম|কত/i, label: 'asking price' },
  { re: /delivery|ডেলিভারি/i, label: 'asking delivery' },
  { re: /discount|offer|ছাড়|অফার/i, label: 'asking discount' },
  { re: /available|stock|আছে/i, label: 'checking availability' },
];

const PHONE_RE = /(?:\+?880|0)1[3-9]\d{8}/;
const QTY_RE = /(\d+)\s*(?:pcs?|pieces?|ta|টা|টি|x)?\s*(?:kinte|chai|lagbe|কিনতে|চাই|লাগবে)?/i;

function normalize(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u0980-\u09ff ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractLeadSignals(text: string, products: ProductLike[]): LeadSignals {
  const t = String(text || '');
  const norm = normalize(t);
  let score = 0;
  const affinity: LeadSignals['productAffinity'] = [];

  for (const p of products || []) {
    const name = normalize(p.name);
    if (!name) continue;
    // Match on any word of the product name (multi-word names: any
    // distinctive word matches; single-word names match as-is).
    const words = name.split(' ').filter((w) => w.length >= 3);
    if (words.some((w) => norm.includes(w))) {
      const price = Number(p.price_bdt) || 0;
      const qtyMatch = t.match(QTY_RE);
      const quantity = qtyMatch ? Math.max(1, Math.min(999, parseInt(qtyMatch[1], 10) || 1)) : 1;
      affinity.push({ productId: p.id, name: p.name, priceBdt: price, quantity });
      score += 30;
      break; // one affinity product per message is enough for the signal
    }
  }

  const intents: string[] = [];
  for (const { re, label } of INTENT_PATTERNS) {
    if (re.test(t)) {
      intents.push(label);
      score += 20;
      break; // first intent wins — keep the summary single-topic
    }
  }

  if (PHONE_RE.test(t)) score += 10;
  if (QTY_RE.test(t) && affinity.length) score += 10;

  score = Math.min(100, score);
  const temperature: LeadSignals['temperature'] = score >= 60 ? 'hot' : score >= 35 ? 'warm' : 'cold';
  const predictedValueBdt = affinity.length ? affinity[0].priceBdt * affinity[0].quantity : 0;

  let nextAction = '';
  if (affinity.length && intents.includes('wants to buy')) nextAction = `Confirm order for ${affinity[0].name}`;
  else if (affinity.length) nextAction = `Share price & delivery for ${affinity[0].name}`;
  else if (intents.length) nextAction = 'Reply with catalog & prices';

  return {
    productAffinity: affinity,
    intentSummary: intents[0] || (affinity.length ? `interested in ${affinity[0].name}` : ''),
    score,
    temperature,
    predictedValueBdt,
    conversionProbability: score / 100,
    nextAction,
  };
}
