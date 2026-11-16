/**
 * Shop payment configuration — @tectonic/ai-router (2026-11-16 order/payment audit).
 *
 * One source of truth for how a shop takes money, stored as columns on
 * `clients` (migration 007) and edited by the shop owner in Settings →
 * Payment Settings (`POST /api/payment-config`). The order service, the
 * deterministic responder (TS + Go mirror) and both system-prompt
 * builders read it from here — never from a free-text knowledge doc,
 * and NEVER from an invented generic fallback ("We accept bKash, Nagad,
 * Rocket, and Cash on Delivery") when nothing is configured.
 *
 * Honesty rule: when a shop has configured nothing, every reply says
 * so plainly instead of claiming payment methods the shop never set.
 * A payment number shown to a customer is always the owner's own
 * configured number — never invented, never a placeholder.
 */

import { toBengaliDigits } from './prompts.js';

export type PaymentModes = 'cod' | 'online' | 'both';

export interface PaymentConfig {
  modes: PaymentModes;
  /** Advance (অগ্রিম) required per order, BDT. 0 = no advance. */
  advanceBdt: number;
  bkash?: string | null;
  nagad?: string | null;
  rocket?: string | null;
}

export const EMPTY_PAYMENT_CONFIG: PaymentConfig = {
  modes: 'cod',
  advanceBdt: 0,
  bkash: null,
  nagad: null,
  rocket: null,
};

/** Build a PaymentConfig from a `clients` row (or any object with the columns). */
export function parsePaymentConfig(row: any): PaymentConfig {
  const modesRaw = String(row?.payment_modes || 'cod').toLowerCase();
  const modes: PaymentModes =
    modesRaw === 'online' || modesRaw === 'both' ? (modesRaw as PaymentModes) : 'cod';
  const advance = Number(row?.advance_required_bdt);
  const clean = (v: any): string | null => {
    const s = String(v || '').replace(/[\s\-+]/g, '');
    return s.length >= 7 && s.length <= 15 ? s : null;
  };
  return {
    modes,
    advanceBdt: Number.isFinite(advance) && advance > 0 ? Math.floor(advance) : 0,
    bkash: clean(row?.bkash_number),
    nagad: clean(row?.nagad_number),
    rocket: clean(row?.rocket_number),
  };
}

/** True when the owner configured anything payment-related. */
export function paymentConfigured(cfg: PaymentConfig): boolean {
  return cfg.advanceBdt > 0 || !!cfg.bkash || !!cfg.nagad || !!cfg.rocket || cfg.modes !== 'cod';
}

function numberList(cfg: PaymentConfig): string[] {
  const out: string[] = [];
  if (cfg.bkash) out.push(`bKash ${cfg.bkash}`);
  if (cfg.nagad) out.push(`Nagad ${cfg.nagad}`);
  if (cfg.rocket) out.push(`Rocket ${cfg.rocket}`);
  return out;
}

type Lang5 = 'bn' | 'banglish' | 'en' | 'hiDev' | 'hiRoman';

function pick5(lang: Lang5, bn: string, banglish: string, en: string, hiDev: string, hiRoman: string): string {
  switch (lang) {
    case 'bn': return bn;
    case 'banglish': return banglish;
    case 'hiDev': return hiDev;
    case 'hiRoman': return hiRoman;
    default: return en;
  }
}

/**
 * One-line payment info for a payment question ("ক্যাশ অন ডেলিভারি হবে?").
 * Configured: real methods + numbers + advance. Not configured: honest
 * "not set yet" — never the invented generic list.
 */
export function paymentInfoText(cfg: PaymentConfig, lang: Lang5): string {
  if (!paymentConfigured(cfg)) {
    return pick5(
      lang,
      'দুঃখিত, আমাদের পেমেন্টের তথ্য এখনো ঠিক করা হয়নি — দোকান থেকে শীঘ্রই জানানো হবে।',
      'Dukkhito, amader payment-er tottho ekhono thik kora hoy ni — dokan theke shighroi janano hobe.',
      'Sorry, our payment details have not been set up yet — the shop will share them soon.',
      'माफ़ कीजिए, हमारे भुगतान की जानकारी अभी सेट नहीं हुई है — दुकान जल्द ही बताएगी।',
      'Maaf kijiye, hamare bhugtan ki jaankari abhi set nahi hui hai — dukaan jald hi batayegi.',
    );
  }
  const nums = numberList(cfg);
  const numsText = nums.length ? nums.join(', ') : '';
  const advanceText =
    cfg.advanceBdt > 0 ? ` — অগ্রিম ${cfg.advanceBdt} টাকা` : '';
  const advanceTextBn =
    cfg.advanceBdt > 0 ? ` — অগ্রিম ${toBengaliDigits(cfg.advanceBdt)} টাকা` : '';
  if (cfg.modes === 'cod') {
    return pick5(
      lang,
      `আমরা ক্যাশ অন ডেলিভারি গ্রহণ করি${advanceTextBn ? ` (অগ্রিম ${toBengaliDigits(cfg.advanceBdt)} টাকা দিতে হবে)` : ''}।`,
      `Amra Cash on Delivery accept kori${advanceText ? ` (advance ${cfg.advanceBdt} BDT dite hobe)` : ''}.`,
      `We accept Cash on Delivery${advanceText ? ` (an advance of ${cfg.advanceBdt} BDT is required)` : ''}.`,
      `हम Cash on Delivery स्वीकार करते हैं${advanceText ? ` (${cfg.advanceBdt} BDT अग्रिम देना होगा)` : ''}।`,
      `Hum Cash on Delivery accept karte hain${advanceText ? ` (${cfg.advanceBdt} BDT advance dena hoga)` : ''}.`,
    );
  }
  if (cfg.modes === 'online') {
    return pick5(
      lang,
      `অনলাইন পেমেন্ট: ${numsText || 'নম্বর শীঘ্রই জানানো হবে'}${advanceTextBn}।`,
      `Online payment: ${numsText || 'number shighroi janano hobe'}${advanceText}.`,
      `Online payment: ${numsText || 'number will be shared soon'}${advanceText}.`,
      `ऑनलाइन भुगतान: ${numsText || 'नंबर जल्द ही बताया जाएगा'}${advanceText}।`,
      `Online payment: ${numsText || 'number jald hi bataya jayega'}${advanceText}.`,
    );
  }
  return pick5(
    lang,
    `ক্যাশ অন ডেলিভারি বা অনলাইন — যেটা সুবিধা: ${numsText || 'অনলাইন নম্বর শীঘ্রই জানানো হবে'}${advanceTextBn}।`,
    `Cash on Delivery ba online — jeta subidha: ${numsText || 'online number shighroi janano hobe'}${advanceText}.`,
    `Cash on Delivery or online — whichever suits you: ${numsText || 'online number will be shared soon'}${advanceText}.`,
    `Cash on Delivery या ऑनलाइन — जो सुविधाजनक हो: ${numsText || 'ऑनलाइन नंबर जल्द ही बताया जाएगा'}${advanceText}।`,
    `Cash on Delivery ya online — jo suvidhajanak ho: ${numsText || 'online number jald hi bataya jayega'}${advanceText}.`,
  );
}

/**
 * Payment sentence(s) appended to an order-confirmation reply.
 * `total` is the order total (incl. delivery). Advance, when set, is
 * due now; the rest is due on delivery (COD) or online per the mode.
 */
export function paymentLineForConfirmation(cfg: PaymentConfig, total: number, lang: Lang5): string {
  const advance = cfg.advanceBdt > 0 ? Math.min(cfg.advanceBdt, total) : 0;
  const rest = Math.max(0, total - advance);
  const nums = numberList(cfg);
  const payTo = nums.length ? nums[0] : '';
  if (advance > 0 && payTo) {
    return pick5(
      lang,
      `পেমেন্ট: অগ্রিম ৳${toBengaliDigits(advance)} ${payTo}-এ পাঠান (TrxID-টি এখানে পাঠিয়ে দিন), বাকি ৳${toBengaliDigits(rest)} ডেলিভারির সময় ক্যাশে দিতে হবে।`,
      `Payment: advance ৳${advance} ${payTo}-e pathan (TrxID-ta ekhane pathiye din), baki ৳${rest} delivery-r somoy cash-e dite hobe.`,
      `Payment: please send an advance of ৳${advance} to ${payTo} (share the TrxID here); the remaining ৳${rest} is due in cash on delivery.`,
      `भुगतान: कृपया ৳${advance} अग्रिम ${payTo} पर भेजें (TrxID यहाँ भेजें); शेष ৳${rest} डिलीवरी के समय नकद देना होगा।`,
      `Payment: kripya ৳${advance} advance ${payTo} par bhejein (TrxID yahan bhejein); shesh ৳${rest} delivery ke samay cash dena hoga.`,
    );
  }
  if (advance > 0) {
    return pick5(
      lang,
      `পেমেন্ট: অগ্রিম ৳${toBengaliDigits(advance)} দিতে হবে — পেমেন্টের নম্বর দোকান থেকে জানানো হবে। বাকি ৳${toBengaliDigits(rest)} ডেলিভারির সময় দিতে হবে।`,
      `Payment: advance ৳${advance} dite hobe — payment-er number dokan theke janano hobe. Baki ৳${rest} delivery-r somoy dite hobe.`,
      `Payment: an advance of ৳${advance} is required — the shop will share the payment number. The remaining ৳${rest} is due on delivery.`,
      `भुगतान: ৳${advance} अग्रिम देना होगा — भुगतान नंबर दुकान बताएगी। शेष ৳${rest} डिलीवरी के समय देना होगा।`,
      `Payment: ৳${advance} advance dena hoga — payment number dukaan batayegi. Shesh ৳${rest} delivery ke samay dena hoga.`,
    );
  }
  if (cfg.modes === 'online') {
    return pick5(
      lang,
      `পেমেন্ট: মোট ৳${toBengaliDigits(total)} অনলাইনে পাঠাতে হবে — ${payTo || 'নম্বর শীঘ্রই জানানো হবে'}।`,
      `Payment: mot ৳${total} online-e pathate hobe — ${payTo || 'number shighroi janano hobe'}.`,
      `Payment: please send the total of ৳${total} online — ${payTo || 'number will be shared soon'}.`,
      `भुगतान: कृपया कुल ৳${total} ऑनलाइन भेजें — ${payTo || 'नंबर जल्द ही बताया जाएगा'}।`,
      `Payment: kripya kul ৳${total} online bhejein — ${payTo || 'number jald hi bataya jayega'}.`,
    );
  }
  return pick5(
    lang,
    `পেমেন্ট: মোট ৳${toBengaliDigits(total)} ক্যাশ অন ডেলিভারি দিতে হবে।`,
    `Payment: mot ৳${total} Cash on Delivery dite hobe.`,
    `Payment: ৳${total} in total is due in cash on delivery.`,
    `भुगतान: कुल ৳${total} Cash on Delivery देना होगा।`,
    `Payment: kul ৳${total} Cash on Delivery dena hoga.`,
  );
}

/** Answer to an advance (অগ্রিম) question: the required advance + where to send it, or that no advance is needed. */
export function advanceInfoText(cfg: PaymentConfig, lang: Lang5): string {
  if (!paymentConfigured(cfg)) return paymentInfoText(cfg, lang);
  if (cfg.advanceBdt > 0) {
    const nums = numberList(cfg);
    const payTo = nums.length ? nums[0] : '';
    if (payTo) {
      return pick5(
        lang,
        `অগ্রিম ${toBengaliDigits(cfg.advanceBdt)} টাকা দিতে হবে — ${payTo}-এ পাঠান (TrxID-টি এখানে পাঠিয়ে দিন)।`,
        `Advance ${cfg.advanceBdt} BDT dite hobe — ${payTo}-e pathan (TrxID-ta ekhane pathiye din).`,
        `An advance of ${cfg.advanceBdt} BDT is required — please send it to ${payTo} (share the TrxID here).`,
        `${cfg.advanceBdt} BDT अग्रिम देना होगा — कृपया ${payTo} पर भेजें (TrxID यहाँ भेजें)।`,
        `${cfg.advanceBdt} BDT advance dena hoga — kripya ${payTo} par bhejein (TrxID yahan bhejein).`,
      );
    }
    return pick5(
      lang,
      `অগ্রিম ${toBengaliDigits(cfg.advanceBdt)} টাকা দিতে হবে — পেমেন্টের নম্বর দোকান থেকে জানানো হবে।`,
      `Advance ${cfg.advanceBdt} BDT dite hobe — payment-er number dokan theke janano hobe.`,
      `An advance of ${cfg.advanceBdt} BDT is required — the shop will share the payment number.`,
      `${cfg.advanceBdt} BDT अग्रिम देना होगा — भुगतान नंबर दुकान बताएगी।`,
      `${cfg.advanceBdt} BDT advance dena hoga — payment number dukaan batayegi.`,
    );
  }
  const cod = cfg.modes === 'cod' || cfg.modes === 'both';
  return pick5(
    lang,
    `এই দোকানে অগ্রিম লাগে না — পুরো টাকা ${cod ? 'ক্যাশ অন ডেলিভারি' : 'অনলাইনে'} দিতে হবে।`,
    `Ei dokane advance lage na — puro taka ${cod ? 'Cash on Delivery' : 'online-e'} dite hobe.`,
    `This shop requires no advance — the full amount is due ${cod ? 'in cash on delivery' : 'online'}.`,
    `इस दुकान में अग्रिम नहीं लगता — पूरी राशि ${cod ? 'Cash on Delivery' : 'ऑनलाइन'} देनी होगी।`,
    `Is dukaan mein advance nahi lagta — poori raashi ${cod ? 'Cash on Delivery' : 'online'} deni hogi.`,
  );
}

/** Short COD-availability sentence for the delivery branch. Unconfigured shops get no COD claim — only the honest "not set yet" line. */
export function codSentence(cfg: PaymentConfig, lang: Lang5): string {
  if (!paymentConfigured(cfg)) {
    return pick5(
      lang,
      'পেমেন্টের মাধ্যম সম্পর্কে দোকান থেকে জানানো হবে।',
      'Payment-er maddhom somporke dokan theke janano hobe.',
      'The shop will share its payment methods.',
      'भुगतान के तरीकों के बारे में दुकान बताएगी।',
      'Bhugtan ke tareekon ke baare mein dukaan batayegi.',
    );
  }
  if (cfg.modes === 'cod' || cfg.modes === 'both') {
    return pick5(
      lang,
      'ক্যাশ অন ডেলিভারি সুবিধা রয়েছে।',
      'Cash on delivery available ache.',
      'Cash on Delivery is available.',
      'Cash on Delivery उपलब्ध है।',
      'Cash on Delivery available hai.',
    );
  }
  return pick5(
    lang,
    'এই দোকানে ক্যাশ অন ডেলিভারি নেই — অনলাইন পেমেন্ট করতে হবে।',
    'Ei dokane Cash on Delivery nei — online payment korte hobe.',
    'This shop does not offer Cash on Delivery — please pay online.',
    'इस दुकान में Cash on Delivery नहीं है — कृपया ऑनलाइन भुगतान करें।',
    'Is dukaan mein Cash on Delivery nahi hai — kripya online payment karein.',
  );
}
