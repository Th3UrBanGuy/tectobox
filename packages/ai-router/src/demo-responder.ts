/**
 * Deterministic template responder — @tectonic/ai-router (Phase 4 of
 * the modular restructure). The api and the workers each had their own
 * copy of the ai router (api/src/ai/router.ts vs workers/src/ai/);
 * this package is the one implementation both import.
 *
 * Fixed 2026-11-15 (Segment A): the product matcher no longer falls
 * back to products[0] (the "chocklate 700" hallucination); TEST-
 * prefixes are stripped, hyphens split, and 3-letter words ("mug",
 * "tea", "spf") match. Stock, category, cheapest, compare, payment,
 * shop-hours and advance-payment intents are answered from the
 * catalog/knowledge in Bengali, Banglish, English and Hindi; the
 * policy branch scores entries by policy type instead of taking the
 * first match; the order branch uses details already given in the
 * message (W12) and refuses out-of-stock items. The Go responder in
 * services/ai/pkg/router/responder.go implements the same logic —
 * keep the two in sync.
 */

import { detectCustomerLanguage } from './language.js';
import type { ProductItem, KnowledgeItem } from './prompts.js';
import { DEFAULT_DELIVERY_CHARGE_BDT, toBengaliDigits } from './prompts.js';

export interface ExtractedDetails {
  name?: string;
  phone?: string;
  address?: string;
  quantity?: number;
}

/** Words in a product name too generic to identify it on their own. */
const GENERIC_PRODUCT_WORDS = new Set([
  'pro', 'plus', 'max', 'mini', 'lite', 'new', 'premium', 'standard',
  'classic', 'basic', 'deluxe', 'set', 'pc', '2pc', '1l', '100ml', '200g',
  'x2', 'fit', 'the', 'a', 'an',
]);

/**
 * Bengali/Hindi transliterations of common product words → English.
 * Lets "ওয়্যারলেস ইয়ারবাডসের দাম কত?" and "वायरलेस ईयरबड्स की कीमत"
 * match the English catalog ("Wireless Earbuds Pro"). Longest keys
 * are tried first; a token starting with a key maps to its value.
 */
const TRANSLITERATIONS: Array<[string, string]> = [
  ['ইয়ারবাডস', 'earbuds'], ['ইয়ারবাড', 'earbuds'], ['ওয়্যারলেস', 'wireless'],
  ['টি-শার্ট', 't-shirt'], ['টিশার্ট', 't-shirt'], ['শার্ট', 'shirt'],
  ['স্মার্ট', 'smart'], ['ওয়াচ', 'watch'], ['ঘড়ি', 'watch'],
  ['বোতল', 'bottle'], ['পানি', 'water'], ['স্টিল', 'steel'],
  ['গ্রিন', 'green'], ['টি', 'tea'], ['চা', 'tea'], ['ওয়ালেট', 'wallet'],
  ['চামড়া', 'leather'], ['স্পিকার', 'speaker'], ['ব্লুটুথ', 'bluetooth'],
  ['জুতা', 'shoes'], ['জুতো', 'shoes'], ['মগ', 'mug'], ['কফি', 'coffee'],
  ['সানস্ক্রিন', 'sunscreen'], ['চার্জার', 'charger'], ['ল্যাপটপ', 'laptop'],
  ['কাপড়', 'clothing'], ['ইলেকট্রনিক্স', 'electronics'], ['পোশাক', 'clothing'],
  ['ईयरबड्स', 'earbuds'], ['इयरबड्स', 'earbuds'], ['वायरलेस', 'wireless'],
  ['टी-शर्ट', 't-shirt'], ['टीशर्ट', 't-shirt'], ['शर्ट', 'shirt'],
  ['स्मार्ट', 'smart'], ['वॉच', 'watch'], ['घड़ी', 'watch'],
  ['बोतल', 'bottle'], ['पानी', 'water'], ['स्टील', 'steel'],
  ['ग्रीन', 'green'], ['चाय', 'tea'], ['वॉलेट', 'wallet'],
  ['चमड़ा', 'leather'], ['स्पीकर', 'speaker'], ['ब्लूटूथ', 'bluetooth'],
  ['जूते', 'shoes'], ['जूता', 'shoes'], ['मग', 'mug'], ['कॉफ़ी', 'coffee'],
  ['कॉफी', 'coffee'], ['सनस्क्रीन', 'sunscreen'], ['चार्जर', 'charger'],
  ['लैपटॉप', 'laptop'], ['कपड़े', 'clothing'], ['इलेक्ट्रॉनिक्स', 'electronics'],
];

TRANSLITERATIONS.sort((a, b) => b[0].length - a[0].length);

/** Category labels → product-name keywords that belong to the category. */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  electronics: ['earbuds', 'earphone', 'headphone', 'speaker', 'watch', 'smart', 'charger', 'phone', 'laptop', 'tablet', 'cable', 'bluetooth', 'camera', 'keyboard', 'mouse'],
  clothing: ['shirt', 't-shirt', 'tshirt', 'pant', 'pants', 'dress', 'jacket', 'hoodie', 'kurta', 'saree', 'punjabi'],
  footwear: ['shoe', 'shoes', 'sneaker', 'sandal', 'boot'],
  food: ['tea', 'coffee', 'honey', 'spice', 'snack', 'organic', 'food', 'grocery'],
  accessories: ['wallet', 'bottle', 'mug', 'sunscreen', 'bag', 'belt', 'sunglasses', 'cap'],
};

const CATEGORY_LABELS: Array<[RegExp, string]> = [
  [/electronics?|ইলেকট্রনিক্স|इलेक्ट्रॉनिक्स/iu, 'electronics'],
  [/clothing|clothes|apparel|পোশাক|কাপড়|कपड़े/iu, 'clothing'],
  [/footwear|জুতা|जूते/iu, 'footwear'],
  [/\bfood\b|grocery|খাবার/iu, 'food'],
  [/accessories/iu, 'accessories'],
];

const BENGALI_DIGITS: Record<string, string> = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

function toAsciiDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => BENGALI_DIGITS[d] || d);
}

function stripTestPrefix(name: string): string {
  return name.replace(/^test[- ]/i, '');
}

function productWords(p: ProductItem): string[] {
  return stripTestPrefix(p.name.toLowerCase()).split(/[\s\-/]+/).filter(Boolean);
}

function priceOf(p: ProductItem): number {
  const n = typeof p.price_bdt === 'number' ? p.price_bdt : parseFloat(String(p.price_bdt));
  return Number.isFinite(n) ? n : 0;
}

function transliterateForMatch(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((tok) => {
      for (const [key, value] of TRANSLITERATIONS) {
        if (tok.startsWith(key)) return value;
      }
      return tok
        .split('-')
        .map((part) => {
          for (const [key, value] of TRANSLITERATIONS) {
            if (part === key) return value;
          }
          return part;
        })
        .join('-');
    })
    .join(' ');
}

function matchWord(str: string, word: string): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])${escaped}(?:[^\\p{L}\\p{M}\\p{N}_]|$)`, 'iu');
  return pattern.test(str);
}

/** Score one product against the message. Full-name phrase = 10;
 * each distinctive name word found = 2; a numeric token = 1.
 * Generic words ("pro", "mini", ...) never score on their own, so
 * "iPhone 15 Pro" does not match "Wireless Earbuds Pro". */
function scoreProduct(p: ProductItem, matchText: string, rawText: string): number {
  const normName = stripTestPrefix(p.name.toLowerCase());
  if (matchWord(matchText, normName)) return 10;
  let score = 0;
  for (const w of productWords(p)) {
    if (GENERIC_PRODUCT_WORDS.has(w)) continue;
    if (w.length < 3) continue;
    if (matchWord(matchText, w) || matchWord(rawText, w)) {
      score += /^\d+$/.test(w) ? 1 : 2;
      continue;
    }
    // Prefix/substring match for short keywords ("earbud" ~ "earbuds").
    if (w.length >= 4) {
      const tokens = matchText.split(/[^a-z0-9]+/).filter(Boolean);
      for (const tok of tokens) {
        if (tok.length >= 4 && (tok.startsWith(w) || w.startsWith(tok))) {
          score += 2;
          break;
        }
      }
    }
    if (w === 'charger' && matchWord(rawText, 'চার্জার')) score += 2;
    if (w === 'চার্জার' && matchWord(rawText, 'charger')) score += 2;
  }
  return score;
}

/** Catalog products matching a message, best score first. */
function matchProducts(sourceText: string, products: ProductItem[]): ProductItem[] {
  const matchText = transliterateForMatch(sourceText);
  return products
    .map((p) => ({ p, score: scoreProduct(p, matchText, sourceText) }))
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.p);
}

/**
 * Best-matching catalog product for a message, or undefined when
 * nothing scores a real match. Exported so the order-creation flow
 * identifies the SAME product the responder matched — one matcher,
 * no second implementation (W3/W4).
 */
export function findProduct(sourceText: string, products: ProductItem[]): ProductItem | undefined {
  return matchProducts(sourceText, products)[0];
}

/**
 * First in-stock product other than `exclude` — the alternative
 * offered when the ordered item is out of stock (W4). Prefers an
 * in-stock product from the SAME category as the requested item
 * (e.g. another electronics item for an out-of-stock smart watch),
 * so the suggestion is relevant instead of the lowest-id product
 * in the catalog. Falls back to any in-stock item when no
 * same-category item is available.
 */
export function findInStockAlternative(products: ProductItem[], exclude: ProductItem): ProductItem | undefined {
  const inStock = products.filter((o) => o !== exclude && (o.stock ?? 0) > 0);
  if (inStock.length === 0) return undefined;
  const category = (exclude.category || '').trim().toLowerCase();
  if (category) {
    const sameCategory = inStock.find((o) => (o.category || '').trim().toLowerCase() === category);
    if (sameCategory) return sameCategory;
  }
  return inStock[0];
}

/** Reply-variant picker for the module-level reply builders below. */
function pickReply(text: string, bn: string, banglish: string, en: string, hiDev: string, hiRoman: string): string {
  const lang = detectCustomerLanguage(text);
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  switch (lang) {
    case 'bn': return bn;
    case 'banglish': return banglish;
    case 'hi': return hasDevanagari ? hiDev : hiRoman;
    default: return en;
  }
}

/**
 * "Out of stock" reply for a product, with an in-stock alternative
 * when one exists. Module-level so the order service refuses
 * out-of-stock orders with the SAME reply the responder gives (W4):
 * the responder's order branch calls this, and the order service
 * calls it when its pre-creation stock check fails.
 */
export function buildOutOfStockReply(text: string, p: ProductItem, products: ProductItem[]): string {
  const alt = findInStockAlternative(products, p);
  const altText = alt
    ? pickReply(
        text,
        ` এর বদলে ${alt.name} (${alt.price_bdt} টাকা) নিতে পারেন — এটি স্টকে আছে।`,
        ` Er bodle ${alt.name} (${alt.price_bdt} BDT) nite paren — eta stock e ache.`,
        ` You could take ${alt.name} (${alt.price_bdt} BDT) instead — it is in stock.`,
        ` आप इसके बजाय ${alt.name} (${alt.price_bdt} BDT) ले सकते हैं — यह स्टॉक में है।`,
        ` Aap iske bajay ${alt.name} (${alt.price_bdt} BDT) le sakte hain — ye stock mein hai.`
      )
    : '';
  return pickReply(
    text,
    `দুঃখিত, ${p.name} বর্তমানে স্টক আউট আছে।${altText}`,
    `Dukkhito, ${p.name} ekhon stock out ache.${altText}`,
    `Sorry, ${p.name} is currently out of stock.${altText}`,
    `माफ़ कीजिए, ${p.name} अभी स्टॉक में नहीं है।${altText}`,
    `Maaf kijiye, ${p.name} abhi stock mein nahi hai.${altText}`
  );
}

/**
 * Extract name / phone / address / quantity from one customer message.
 * Exported so the order-creation flow can reuse it instead of re-asking
 * for details the customer already gave (W12). Phone is matched first
 * and removed before quantity is read, so a phone number is never
 * mistaken for a quantity. Quantity is only read from this message,
 * never from history (a house number in an old address is not a qty).
 */
export function extractCustomerDetails(rawText: string): ExtractedDetails {
  const out: ExtractedDetails = {};
  const text = String(rawText || '');
  const ascii = toAsciiDigits(text);

  const phoneMatch = ascii.match(/(?:\+?880[\s\-]?1[3-9]\d{2}[\s\-]?\d{6}|01[3-9]\d{8}|1[3-9]\d{8})/);
  if (phoneMatch) {
    out.phone = phoneMatch[0].replace(/[\s\-+]/g, '');
  }

  const namePatterns = [
    /my name is\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i,
    /amar naam(?:e)?\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i,
    /আমার নাম\s+([^\s,।]+(?:\s+[^\s,।]+){0,2})/,
    /naam\s+(?:hai|hain|mera|meri)?\s*([A-Za-z][A-Za-z.'\- ]{1,40})/i,
    /\bi am\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i,
  ];
  for (const re of namePatterns) {
    const m = text.match(re);
    if (m) {
      let name = m[1].trim();
      name = name.split(/,|\.| phone| my | and /i)[0].trim();
      const parts = name.split(/\s+/).slice(0, 3).join(' ');
      if (parts.length >= 2) {
        out.name = parts;
        break;
      }
    }
  }

  const addressMatch =
    text.match(/(?:deliver to|address(?: is|:)?|ঠিকানা|thikana)\s*:?\s*([^.\n;।]{3,200})/i);
  if (addressMatch) {
    out.address = addressMatch[1].trim();
  }

  const withoutPhone = phoneMatch ? ascii.replace(phoneMatch[0], ' ') : ascii;
  const qtyMatch =
    withoutPhone.match(/(?:quantity|qty)\s*:?\s*(\d{1,2})\b/i) ||
    withoutPhone.match(/\b(\d{1,2})\s*(?:ta|ti|pcs?|pieces?)\b/i) ||
    withoutPhone.match(/\bx\s*(\d{1,2})\b/i) ||
    withoutPhone.match(/\b(\d{1,2})\s+(?:ta|ti)\b/i);
  if (qtyMatch) {
    const q = parseInt(qtyMatch[1], 10);
    if (q >= 1 && q <= 99) out.quantity = q;
  } else {
    // "buy 2 earbuds": a bare number right before a product word.
    const bare = withoutPhone.match(/\b(\d{1,2})\s+(?=[A-Za-z]{3,})/);
    if (bare) {
      const q = parseInt(bare[1], 10);
      if (q >= 1 && q <= 99) out.quantity = q;
    }
  }

  return out;
}

export function demoResponder(
  clientId: string | number,
  text: string,
  products: ProductItem[] = [],
  historyOrKnowledge: Array<{ role?: string; title?: string; content?: string }> = [],
  knowledgeOrHistory: Array<{ role?: string; title?: string; content?: string }> = []
): string {
  let history: Array<{ role: string; content: string }> = [];
  let knowledge: KnowledgeItem[] = [];

  // Flexibly handle knowledge passed as 4th or 5th argument
  if (Array.isArray(historyOrKnowledge) && historyOrKnowledge.length > 0) {
    if ('role' in historyOrKnowledge[0]) {
      history = historyOrKnowledge as Array<{ role: string; content: string }>;
    } else {
      knowledge = historyOrKnowledge as KnowledgeItem[];
    }
  }
  if (Array.isArray(knowledgeOrHistory) && knowledgeOrHistory.length > 0) {
    if ('title' in knowledgeOrHistory[0] || 'content' in knowledgeOrHistory[0]) {
      knowledge = knowledgeOrHistory as KnowledgeItem[];
    } else {
      history = knowledgeOrHistory as Array<{ role: string; content: string }>;
    }
  }

  const lang = detectCustomerLanguage(text);
  const hasDevanagari = /[\u0900-\u097F]/.test(text);

  /** Pick the reply variant for the customer's language. Hindi uses
   * Devanagari when the customer wrote Devanagari, Roman Hindi when
   * they wrote Roman Hindi. */
  function pick(bn: string, banglish: string, en: string, hiDev: string, hiRoman: string): string {
    switch (lang) {
      case 'bn': return bn;
      case 'banglish': return banglish;
      case 'hi': return hasDevanagari ? hiDev : hiRoman;
      default: return en;
    }
  }

  // Module-level matcher (same scoring the responder uses): the
  // order service imports findProduct so both agree on the product.
  const matchProductsFor = (t: string): ProductItem[] => matchProducts(t, products);
  const matchProduct = (t: string): ProductItem | undefined => findProduct(t, products);
  const outOfStockReply = (p: ProductItem): string => buildOutOfStockReply(text, p, products);

  /** Closest alternative for a "we don't carry that" reply: any
   * product sharing even a generic token with the question ("Pro",
   * "100ml"). Only used when no product scored a real match. */
  function closestAlternative(sourceText: string): ProductItem | undefined {
    const tokens = transliterateForMatch(sourceText).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    let best: ProductItem | undefined;
    let bestCount = 0;
    for (const p of products) {
      const normName = stripTestPrefix(p.name.toLowerCase());
      let count = 0;
      for (const tok of tokens) {
        if (normName.includes(tok)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        best = p;
      }
    }
    return bestCount > 0 ? best : undefined;
  }

  /** Best knowledge entry by keyword score: title hit = 3, content hit = 1. */
  function findKnowledge(keywords: string[]): KnowledgeItem | undefined {
    let best: KnowledgeItem | undefined;
    let bestScore = 0;
    for (const k of knowledge) {
      const title = `${k.title || ''}`.toLowerCase();
      const body = `${k.content || ''} ${k.category || ''}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (title.includes(kw)) score += 3;
        else if (body.includes(kw)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return bestScore > 0 ? best : undefined;
  }

  function notFoundReply(): string {
    const alt = closestAlternative(text);
    const altText = alt
      ? pick(
          ` কাছাকাছি আমাদের কাছে ${alt.name} আছে (${alt.price_bdt} টাকা)।`,
          ` Kachakachi amader kache ${alt.name} ache (${alt.price_bdt} BDT).`,
          ` The closest we have is ${alt.name} (${alt.price_bdt} BDT).`,
          ` हमारे पास इससे मिलता-जुलता ${alt.name} है (${alt.price_bdt} BDT)।`,
          ` Hamare paas isse milta-julta ${alt.name} hai (${alt.price_bdt} BDT).`
        )
      : '';
    return pick(
      `দুঃখিত, এই প্রোডাক্টটি আমাদের কাছে নেই।${altText}`,
      `Dukkhito, ei product-ta amader kache nei.${altText}`,
      `Sorry, we do not carry that item.${altText}`,
      `माफ़ कीजिए, यह प्रोडक्ट हमारे पास नहीं है।${altText}`,
      `Maaf kijiye, ye product hamare paas nahi hai.${altText}`
    );
  }

  function priceReply(p: ProductItem): string {
    if (p.stock !== undefined && p.stock <= 0) return outOfStockReply(p);
    return pick(
      `${p.name}-এর মূল্য ${p.price_bdt} টাকা। আপনি কি এটি অর্ডার করতে চান?`,
      `${p.name}-er price ${p.price_bdt} BDT. Apni ki eta order korte chan?`,
      `${p.name} is ${p.price_bdt} BDT. Would you like to order it?`,
      `${p.name} की कीमत ${p.price_bdt} BDT है। क्या आप इसे ऑर्डर करना चाहेंगे?`,
      `${p.name} ki keemat ${p.price_bdt} BDT hai. Kya aap ise order karna chahenge?`
    );
  }

  // 0. Advance-payment question — NEVER an order prompt (W13).
  const reAdvance = /(?:^|[^\p{L}\p{M}\p{N}_])(advance|অগ্রিম|agrim|एडवांस|अग्रिम)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reAdvance.test(text)) {
    const entry = findKnowledge(['advance', 'অগ্রিম', 'एडवांस', 'अग्रिम']);
    if (entry) {
      return pick(
        `অগ্রিম পেমেন্ট সম্পর্কে: ${entry.content}`,
        `Advance payment somporke: ${entry.content}`,
        `About advance payment: ${entry.content}`,
        `अग्रिम भुगतान के बारे में: ${entry.content}`,
        `Advance payment ke baare mein: ${entry.content}`
      );
    }
    // No advance rule in knowledge: answer with the payment info
    // (knowledge if present, else the payment fallback) — never invent
    // an advance rule and never start the order flow.
    const payEntry = findKnowledge(['bkash', 'nagad', 'payment', 'পেমেন্ট', 'cash on delivery', 'cod', 'rocket', 'বিকাশ', 'নগদ', 'भुगतान']);
    const payContent = payEntry
      ? payEntry.content
      : 'We accept bKash, Nagad, Rocket, and Cash on Delivery.';
    return pick(
      `অগ্রিম পেমেন্ট সম্পর্কে: ${payContent}`,
      `Advance payment somporke: ${payContent}`,
      `About advance payment: ${payContent}`,
      `अग्रिम भुगतान के बारे में: ${payContent}`,
      `Advance payment ke baare mein: ${payContent}`
    );
  }

  // 1. Payment methods — before delivery, so "Can I pay cash on
  // delivery?" gets the payment answer, not the delivery template (W9/L5).
  const rePayment = /(?:^|[^\p{L}\p{M}\p{N}_])(payment|pay|paid|bkash|nagad|rocket|cash on delivery|cod|upi|পেমেন্ট|পে|ক্যাশ অন ডেলিভারি|বিকাশ|নগদ|রকেট|भुगतान)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (rePayment.test(text)) {
    const entry = findKnowledge(['bkash', 'nagad', 'payment', 'পেমেন্ট', 'cash on delivery', 'cod', 'rocket', 'বিকাশ', 'নগদ', 'भुगतान', 'upi']);
    if (entry) {
      return pick(
        `আমাদের পেমেন্ট তথ্য: ${entry.content}`,
        `Amader payment info: ${entry.content}`,
        `Our payment options: ${entry.content}`,
        `हमारे भुगतान विकल्प: ${entry.content}`,
        `Hamare payment options: ${entry.content}`
      );
    }
    return pick(
      'আমরা bKash, Nagad, Rocket এবং ক্যাশ অন ডেলিভারি গ্রহণ করি।',
      'Amra bKash, Nagad, Rocket ebong Cash on Delivery accept kori.',
      'We accept bKash, Nagad, Rocket, and Cash on Delivery.',
      'हम bKash, Nagad, Rocket और Cash on Delivery स्वीकार करते हैं।',
      'Hum bKash, Nagad, Rocket aur Cash on Delivery accept karte hain.'
    );
  }

  // 2. Shop opening hours (W9/L2/L3/L5) — knowledge first, fallback
  // is the seeded 9am–9pm Sat–Thu hours.
  const reHours = /(?:^|[^\p{L}\p{M}\p{N}_])(open|opening|opening hours|shop hours|store hours|shop open|khola|khula|খোলা|খুলা|खुला|खुलता|kokhon khola|dokan kokhon)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reHours.test(text)) {
    const entry = findKnowledge(['open', 'hours', 'hour', 'খোলা', 'khola', 'khula', 'खुला', '9am', '9 am', 'timing', 'shop hours', 'opening']);
    if (entry) {
      return pick(
        `আমাদের দোকানের সময়: ${entry.content}`,
        `Amader dokaner somoy: ${entry.content}`,
        `Our shop hours: ${entry.content}`,
        `हमारी दुकान का समय: ${entry.content}`,
        `Hamari dukaan ka samay: ${entry.content}`
      );
    }
    return pick(
      'আমাদের দোকান শনিবার থেকে বৃহস্পতিবার, সকাল 9টা থেকে রাত 9টা পর্যন্ত খোলা থাকে।',
      'Amader dokan Shonibar theke Brihoshpotibar, shokal 9ta theke raat 9ta porjonto khola thake.',
      'Our shop is open Saturday to Thursday, 9am to 9pm.',
      'हमारी दुकान शनिवार से गुरुवार, सुबह 9 बजे से रात 9 बजे तक खुली रहती है।',
      'Hamari dukaan Shanivar se Guruvar, subah 9 baje se raat 9 baje tak khuli rehti hai.'
    );
  }

  // 3. Delivery / Shipping intent (word boundaries avoid matching in 'charger' or 'চার্জার')
  const reDelivery = /(?:^|[^\p{L}\p{M}\p{N}_])(delivery|charge|shipping|courier|pathan|kobe|somoy|shomoy|ডেলিভারি|চার্জ|কুরিয়ার|কুরিয়ার|পাঠান|সময়|কবে)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reDelivery.test(text)) {
    // Check knowledge FIRST for delivery / charge / shipping entries
    if (knowledge && knowledge.length > 0) {
      for (const k of knowledge) {
        const combined = `${k.title || ''} ${k.content || ''} ${k.category || ''}`.toLowerCase();
        if (
          combined.includes('delivery') ||
          combined.includes('charge') ||
          combined.includes('shipping') ||
          combined.includes('courier') ||
          combined.includes('ডেলিভারি') ||
          combined.includes('চার্জ') ||
          combined.includes('কুরিয়ার') ||
          combined.includes('কুরিয়ার')
        ) {
          return pick(
            `আমাদের ডেলিভারি তথ্য: ${k.content}`,
            `Amader delivery info: ${k.content}`,
            `Our delivery policy: ${k.content}`,
            `हमारी डिलीवरी जानकारी: ${k.content}`,
            `Hamari delivery jaankari: ${k.content}`
          );
        }
      }
    }

    return pick(
      `আমাদের ডেলিভারি চার্জ ঢাকার ভেতরে ${toBengaliDigits(DEFAULT_DELIVERY_CHARGE_BDT.insideDhaka)} টাকা (২৪-৪৮ ঘণ্টা) এবং ঢাকার বাইরে ${toBengaliDigits(DEFAULT_DELIVERY_CHARGE_BDT.outsideDhaka)} টাকা (২-৩ দিন)। ক্যাশ অন ডেলিভারি সুবিধা রয়েছে।`,
      `Amader delivery charge Dhaka city-r bhitore ${DEFAULT_DELIVERY_CHARGE_BDT.insideDhaka} taka (24-48 hours) ebong Dhaka-r baire ${DEFAULT_DELIVERY_CHARGE_BDT.outsideDhaka} taka (2-3 days). Cash on delivery available ache.`,
      `Our delivery charge is ${DEFAULT_DELIVERY_CHARGE_BDT.insideDhaka} BDT inside Dhaka (24-48h) and ${DEFAULT_DELIVERY_CHARGE_BDT.outsideDhaka} BDT outside Dhaka (2-3 days). Cash on Delivery is available.`,
      `हमारा डिलीवरी चार्ज ढाका के अंदर ${DEFAULT_DELIVERY_CHARGE_BDT.insideDhaka} BDT (24-48 घंटे) और ढाका के बाहर ${DEFAULT_DELIVERY_CHARGE_BDT.outsideDhaka} BDT (2-3 दिन) है। Cash on Delivery उपलब्ध है।`,
      `Hamara delivery charge Dhaka ke andar ${DEFAULT_DELIVERY_CHARGE_BDT.insideDhaka} BDT (24-48 hours) aur Dhaka ke baahar ${DEFAULT_DELIVERY_CHARGE_BDT.outsideDhaka} BDT (2-3 days) hai. Cash on Delivery available hai.`
    );
  }

  // 4. Stock questions (W6/L2/L7) — answer from the stock field, with
  // the price included so "টি-শার্ট কি স্টকে আছে?" gets its 599.
  const reStock = /(?:^|[^\p{L}\p{M}\p{N}_])(stock|in stock|out of stock|available|availability|স্টক|স্টকে|स्टॉक|uplabdh|stock ache|stock e)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reStock.test(text)) {
    const matched = matchProduct(text);
    if (matched) {
      if (matched.stock !== undefined && matched.stock <= 0) return outOfStockReply(matched);
      const count = matched.stock !== undefined ? matched.stock : null;
      return pick(
        count !== null
          ? `হ্যাঁ, ${matched.name} স্টকে আছে — ${count}টি আছে। মূল্য ${matched.price_bdt} টাকা।`
          : `হ্যাঁ, ${matched.name} স্টকে আছে। মূল্য ${matched.price_bdt} টাকা।`,
        count !== null
          ? `Hyaan, ${matched.name} stock e ache — ${count}ta available ache. Price ${matched.price_bdt} BDT.`
          : `Hyaan, ${matched.name} stock e ache. Price ${matched.price_bdt} BDT.`,
        count !== null
          ? `Yes, ${matched.name} is in stock — ${count} available. Price: ${matched.price_bdt} BDT.`
          : `Yes, ${matched.name} is in stock. Price: ${matched.price_bdt} BDT.`,
        count !== null
          ? `हाँ, ${matched.name} स्टॉक में है — ${count} उपलब्ध है। कीमत: ${matched.price_bdt} BDT।`
          : `हाँ, ${matched.name} स्टॉक में है। कीमत: ${matched.price_bdt} BDT।`,
        count !== null
          ? `Haan, ${matched.name} stock mein hai — ${count} available hai. Keemat: ${matched.price_bdt} BDT.`
          : `Haan, ${matched.name} stock mein hai. Keemat: ${matched.price_bdt} BDT.`
      );
    }
    const inStock = products.filter((p) => (p.stock ?? 1) > 0);
    if (inStock.length > 0 && products.length > 0) {
      const list = inStock.map((p) => `${p.name} (${p.price_bdt} BDT)`).join(', ');
      return pick(
        `স্টকে থাকা প্রোডাক্টগুলো: ${list}। কোনটি সম্পর্কে জানতে চান?`,
        `Stock e thaka product-gulo: ${list}. Konti somporke jante chan?`,
        `These are in stock: ${list}. Which one would you like to know about?`,
        `स्टॉक में ये प्रोडक्ट हैं: ${list}। आप किसके बारे में जानना चाहेंगे?`,
        `Stock mein ye products hain: ${list}. Aap kiske baare mein jaanna chahenge?`
      );
    }
    return notFoundReply();
  }

  // 5. Policy questions (W10) — score entries by the SPECIFIC policy
  // type asked about; never return the wrong policy. "Broken / not
  // working" counts as a warranty question.
  const rePolicy = /(?:^|[^\p{L}\p{M}\p{N}_])(return|refund|exchange|warranty|guarantee|ferot|change|policy|ফেরত|ওয়ারেন্টি|ওয়ারেন্টি|পলিসি|broken|not working|stopped working|damaged|নষ্ট|खराब|টাকা ফেরত)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (rePolicy.test(text) && knowledge && knowledge.length > 0) {
    const wanted: Array<{ keywords: string[] }> = [];
    if (/(warranty|guarantee|ওয়ারেন্টি|ওয়ারেন্টি|वारंटी|गारंटी|broken|not working|stopped working|damaged|নষ্ট|खराब)/iu.test(text)) {
      wanted.push({ keywords: ['warranty', 'guarantee', 'ওয়ারেন্টি', 'ওয়ারেন্টি', 'वारंटी'] });
    }
    if (/(refund|রিফান্ড|रिफंड|টাকা ফেরত)/iu.test(text)) {
      wanted.push({ keywords: ['refund', 'রিফান্ড', 'रिफंड'] });
    }
    if (/(return|exchange|ferot|ফেরত|वापसी|बदल|বদল)/iu.test(text)) {
      wanted.push({ keywords: ['return', 'exchange', 'ferot', 'ফেরত', 'वापसी', 'बदल', 'বদল'] });
    }
    let best: KnowledgeItem | undefined;
    let bestScore = 0;
    for (const k of knowledge) {
      const combined = `${k.title || ''} ${k.content || ''} ${k.category || ''}`.toLowerCase();
      let score = 0;
      for (const w of wanted) {
        for (const kw of w.keywords) {
          if (combined.includes(kw)) score += 3;
        }
      }
      if (combined.includes('policy') || combined.includes('পলিসি')) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (!best) {
      // No entry scored for the asked type: first entry with any policy word.
      for (const k of knowledge) {
        const combined = `${k.title || ''} ${k.content || ''} ${k.category || ''}`.toLowerCase();
        if (
          combined.includes('return') || combined.includes('refund') ||
          combined.includes('policy') || combined.includes('warranty') ||
          combined.includes('ফেরত') || combined.includes('পলিসি')
        ) {
          best = k;
          break;
        }
      }
    }
    if (best) {
      return pick(
        `আমাদের পলিসি: ${best.content}। বিস্তারিত জানতে আমাদের জানাতে পারেন।`,
        `Amader policy: ${best.content}. Kono query thakle janate paren.`,
        `Our policy: ${best.content}.`,
        `हमारी पॉलिसी: ${best.content}।`,
        `Hamari policy: ${best.content}.`
      );
    }
  }

  // 6. Compare two named products (W8): "Which is cheaper, the
  // earbuds or the speaker?" — answer with the cheaper of the two.
  const reCompare = /(?:^|[^\p{L}\p{M}\p{N}_])(cheaper|compare|comparison|কম দাম|सस्ता)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reCompare.test(text)) {
    const matched = matchProductsFor(text);
    if (matched.length >= 2) {
      const [a, b] = matched;
      const cheaper = priceOf(a) <= priceOf(b) ? a : b;
      const dearer = cheaper === a ? b : a;
      return pick(
        `${cheaper.name} সস্তা — ${cheaper.price_bdt} টাকা, আর ${dearer.name} ${dearer.price_bdt} টাকা।`,
        `${cheaper.name} sosta — ${cheaper.price_bdt} BDT, ar ${dearer.name} ${dearer.price_bdt} BDT.`,
        `${cheaper.name} is cheaper — ${cheaper.price_bdt} BDT, while ${dearer.name} is ${dearer.price_bdt} BDT.`,
        `${cheaper.name} सस्ता है — ${cheaper.price_bdt} BDT, जबकि ${dearer.name} ${dearer.price_bdt} BDT है।`,
        `${cheaper.name} sasta hai — ${cheaper.price_bdt} BDT, jabki ${dearer.name} ${dearer.price_bdt} BDT hai.`
      );
    }
  }

  // 7. Cheapest product (W8): minimum price across the catalog.
  const reCheapest = /(?:^|[^\p{L}\p{M}\p{N}_])(cheapest|lowest price|lowest|sobcheye kom|সবচেয়ে কম|সবচেয়ে কম|সবচেয়ে সস্তা|সবচেয়ে সস্তা|sabse sasta|sabse kam|sobcheye sosta|সস্তা|sasta)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reCheapest.test(text) && products.length > 0) {
    let cheapest = products[0];
    for (const p of products) {
      if (priceOf(p) < priceOf(cheapest)) cheapest = p;
    }
    return pick(
      `আমাদের সবচেয়ে কম দামের প্রোডাক্ট ${cheapest.name} — ${cheapest.price_bdt} টাকা।`,
      `Amader sobcheye kom damer product ${cheapest.name} — ${cheapest.price_bdt} BDT.`,
      `Our cheapest product is ${cheapest.name} — ${cheapest.price_bdt} BDT.`,
      `हमारा सबसे सस्ता प्रोडक्ट ${cheapest.name} है — ${cheapest.price_bdt} BDT।`,
      `Hamara sabse sasta product ${cheapest.name} hai — ${cheapest.price_bdt} BDT.`
    );
  }

  // 8. Category listing (W8): a category label, or a list-all request.
  const reCategoryList = /(?:^|[^\p{L}\p{M}\p{N}_])(what products|what do you have|list (your|all|the)? ?(products|items)?|all products|catalogue?|তালিকা|সব প্রোডাক্ট|show me (your|all|everything))(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  let categoryLabel: string | undefined;
  for (const [re, label] of CATEGORY_LABELS) {
    if (re.test(text)) {
      categoryLabel = label;
      break;
    }
  }
  if ((categoryLabel || reCategoryList.test(text)) && products.length > 0) {
    let listed = products;
    if (categoryLabel) {
      const keywords = CATEGORY_KEYWORDS[categoryLabel] || [];
      listed = products.filter((p) => {
        const cat = (p.category || '').toLowerCase();
        if (cat && (cat.includes(categoryLabel) || keywords.some((kw) => cat.includes(kw)))) return true;
        const words = productWords(p);
        return keywords.some((kw) => words.includes(kw));
      });
      if (listed.length === 0) {
        return pick(
          `দুঃখিত, এই ক্যাটাগরিতে আমাদের কাছে কোনো প্রোডাক্ট নেই।`,
          `Dukkhito, ei category-te amader kache kono product nei.`,
          `Sorry, we do not carry anything in that category.`,
          `माफ़ कीजिए, इस कैटेगरी में हमारे पास कोई प्रोडक्ट नहीं है।`,
          `Maaf kijiye, is category mein hamare paas koi product nahi hai.`
        );
      }
    }
    const list = listed.map((p) => `${p.name} (${p.price_bdt} BDT)`).join(', ');
    return pick(
      categoryLabel
        ? `এই ক্যাটাগরিতে আমাদের আছে: ${list}।`
        : `আমাদের প্রোডাক্টগুলো: ${list}।`,
      categoryLabel
        ? `Ei category-te amader ache: ${list}.`
        : `Amader product-gulo: ${list}.`,
      categoryLabel
        ? `In this category we have: ${list}.`
        : `Our products: ${list}.`,
      categoryLabel
        ? `इस कैटेगरी में हमारे पास है: ${list}।`
        : `हमारे प्रोडक्ट: ${list}।`,
      categoryLabel
        ? `Is category mein hamare paas hai: ${list}.`
        : `Hamare products: ${list}.`
    );
  }

  // 9. Order intent (with word boundaries and conversational memory).
  // Uses details already given (W12) and refuses out-of-stock items.
  const reOrder = /(?:^|[^\p{L}\p{M}\p{N}_])(order|buy|purchase|kinte|nibo|nebo|lagbe|nite|chai|chaichi|haa|ha|yes|confirm|অর্ডার|কিনব|কিনতে|নিব|চাই|নিতে|চাচ্ছি|হাঁ|হ্যাঁ)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reOrder.test(text)) {
    let matched = matchProduct(text);
    if (!matched) {
      for (const h of [...history].reverse()) {
        matched = matchProduct(h.content || '');
        if (matched) break;
      }
    }

    if (matched && matched.stock !== undefined && matched.stock <= 0) {
      return outOfStockReply(matched);
    }

    const details = extractCustomerDetails(text);
    for (const h of [...history].reverse()) {
      if (details.name && details.phone && details.address) break;
      const older = extractCustomerDetails(h.content || '');
      if (!details.name && older.name) details.name = older.name;
      if (!details.phone && older.phone) details.phone = older.phone;
      if (!details.address && older.address) details.address = older.address;
    }

    const prodLabel = matched ? ` (${matched.name} — ${matched.price_bdt} BDT${details.quantity ? ` x ${details.quantity}` : ''})` : '';
    const missing: string[] = [];
    if (!details.name) missing.push(pick('নাম', 'naam', 'name', 'नाम', 'naam'));
    if (!details.phone) missing.push(pick('ফোন নম্বর', 'phone number', 'phone number', 'फ़ोन नंबर', 'phone number'));
    if (!details.address) missing.push(pick('ডেলিভারি ঠিকানা', 'delivery address', 'delivery address', 'डिलीवरी पता', 'delivery address'));
    const givenBits: string[] = [];
    if (details.name) givenBits.push(details.name);
    if (details.phone) givenBits.push(details.phone);
    if (details.address) givenBits.push(details.address);
    const given = givenBits.join(', ');
    const detailsNote = given
      ? pick(
          ` বিস্তারিত: ${given}।`,
          ` Details: ${given}.`,
          ` Details on file: ${given}.`,
          ` विवरण: ${given}।`,
          ` Details: ${given}.`
        )
      : '';

    if (missing.length === 0) {
      return pick(
        `ধন্যবাদ${details.name ? `, ${details.name}` : ''}! আপনার অর্ডারটি${prodLabel} কনফার্ম করতে "confirm" লিখে পাঠান।${detailsNote}`,
        `Dhonnobad${details.name ? `, ${details.name}` : ''}! Apnar order${prodLabel} confirm korte "confirm" likhe pathan.${detailsNote}`,
        `Thanks${details.name ? `, ${details.name}` : ''}! I have your details for your order${prodLabel}. Reply "confirm" to place it.${detailsNote}`,
        `धन्यवाद${details.name ? `, ${details.name}` : ''}! आपका ऑर्डर${prodLabel} कन्फर्म करने के लिए "confirm" लिखकर भेजें।${detailsNote}`,
        `Dhanyavaad${details.name ? `, ${details.name}` : ''}! Aapka order${prodLabel} confirm karne ke liye "confirm" likhkar bhejein.${detailsNote}`
      );
    }
    return pick(
      `আপনার অর্ডারটি${prodLabel} কনফার্ম করার জন্য অনুগ্রহ করে আপনার ${missing.join(', ')} লিখে দিন।${given ? ` আমরা পেয়েছি: ${given}।` : ''}`,
      `Apnar order${prodLabel} confirm korte ${missing.join(', ')} ta ekhane likhe din please.${given ? ` Amra peyechi: ${given}.` : ''}`,
      `To confirm your order${prodLabel}, please provide your ${missing.join(', ')}.${given ? ` We already have: ${given}.` : ''}`,
      `आपका ऑर्डर${prodLabel} कन्फर्म करने के लिए कृपया अपना ${missing.join(', ')} लिखकर भेजें।${given ? ` हमें मिल गया है: ${given}।` : ''}`,
      `Aapka order${prodLabel} confirm karne ke liye kripya apna ${missing.join(', ')} likhkar bhejein.${given ? ` Humein mil gaya hai: ${given}.` : ''}`
    );
  }

  // 10. Price inquiry with intelligent product name matching.
  // No products[0] fallback: an unmatched price question says the
  // product was not found instead of quoting the wrong product (W2/L1).
  const rePrice = /(?:^|[^\p{L}\p{M}\p{N}_])(dam|daam|price|cost|koto|rate|দাম|মূল্য|কত|keemat|kimat|कीमत|कितने)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  const matched = matchProduct(text);
  if (rePrice.test(text) || matched) {
    if (matched) {
      if (/total/i.test(text)) {
        const all = matchProductsFor(text);
        if (all.length >= 2) {
          const lines = all.map((p) => `${p.name} (${p.price_bdt} BDT)`).join(' + ');
          const total = all.reduce((s, p) => s + priceOf(p), 0);
          return pick(
            `${lines} = মোট ${total} টাকা।`,
            `${lines} = mot ${total} BDT.`,
            `${lines} = ${total} BDT in total.`,
            `${lines} = कुल ${total} BDT।`,
            `${lines} = kul ${total} BDT.`
          );
        }
      }
      return priceReply(matched);
    }
    if (rePrice.test(text)) {
      return notFoundReply();
    }
  }

  // 11. Out-of-catalog product question (W7): "Do you have iPhone 15?"
  const reProductQuestion = /(?:^|[^\p{L}\p{M}\p{N}_])(do you (have|sell|carry|offer|stock)|have you got|is there|are there|do you have|আছে|ache|আছেন|है|sells?|carry)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reProductQuestion.test(text) && products.length > 0) {
    return notFoundReply();
  }

  // 12. Greetings & general inquiry
  return pick(
    'ধন্যবাদ মেসেজ দেওয়ার জন্য! আমি আপনাকে কীভাবে সাহায্য করতে পারি?',
    'Message korar jonno dhonnobad! Apnake kivabe shahajjo korte pari?',
    'Thank you for reaching out! How can we assist you today?',
    'नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?',
    'Namaste! Main aapki kaise madad kar sakta hoon?'
  );
}
