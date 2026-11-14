/**
 * Payment-claim trigger gate — @tectonic/ai-router (P16, 2026-11-15).
 *
 * The claim flow must be TRIGGERED only when the customer states they
 * actually paid, with a TrxID. A mere question about payment ("Can I pay
 * with bKash?", "What is your bKash number?") must NEVER create — or
 * even route into — a payment claim; it is answered by the normal AI
 * reply path instead (payment methods, merchant number, …).
 *
 * This module owns the TRIGGER only. TrxID format validation and the
 * amount rules live in `payment-claim.ts` (Seg C, W5) and are NOT
 * changed here: a statement with a malformed TrxID still routes to the
 * claim handler, which rejects it with a clear "send the real TrxID"
 * reply instead of storing anything.
 *
 * A message is an actual payment statement when it BOTH:
 *  1. contains a paid-statement verb — the customer says the money is
 *     already sent ("paid", "payment done", "sent money", "টাকা
 *     পাঠিয়েছি", "পেমেন্ট করেছি", …), and
 *  2. carries a TrxID token (the `trxId` `parsePaymentClaim` extracted;
 *     the gate takes it as an argument so the parser stays the single
 *     source of TrxID extraction).
 * Questions ("can I pay", "what is your number", "how do I pay", "do
 * you accept bKash") have no paid-statement verb and never pass.
 */
const PAID_STATEMENT_PATTERN =
  /(paid|payment\s*(done|complete|completed|successful|sent|made)|sent\s*(the\s*)?money|send\s*(the\s*)?money|money\s*sent|i\s*(have\s*)?pay[ae]d|pay\s*(korechi|korlam|kore\s*felchi)|taka\s*(pathiyechi|pathalam|diyechi|send\s*korechi)|টাকা\s*(পাঠিয়েছি|পাঠাইছি|দিছি|দিয়েছি|পাঠানো\s*হয়েছে|পাঠিয়ে\s*দিয়েছি)|পেমেন্ট\s*(করেছি|দিছি|ডান|হয়েছে|করা\s*হয়েছে|করে\s*দিয়েছি)|পাঠিয়ে\s*দিয়েছি|পেইড|trx\s*id\s*(is|:)?\s*[a-z0-9]{6,}|transaction\s*id\s*(is|:)?\s*[a-z0-9]{6,}|payment\s*(korechi|korlam|done|complete))/i;

/** Question-only payment mentions — never a payment statement. */
const PAYMENT_QUESTION_PATTERN =
  /(can\s+i\s*pay|how\s*(do\s+i|to)\s*pay|what\s*is\s*your\s*(bkash|nagad|rocket|bank|payment)?\s*(number|no\.?|account)|do\s+you\s+accept|is\s+(bkash|nagad|rocket)\s*(available|accepted)|kivabe\s*(pay|payment|taka)\s*(korbo|korbo|dibo)|apnar\s*(bkash|nagad|rocket)?\s*(number|নম্বর|নাম্বার)|কিভাবে\s*(পে|পেমেন্ট|টাকা)|আপনার\s*(বিকাশ|নগদ|রকেট)?\s*(নম্বর|নাম্বার)|কি\s*পেমেন্ট\s*করতে\s*পারবো|পেমেন্ট\s*করতে\s*পারবো)/i;

export function isActualPaymentStatement(text: string, trxId: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  // A question about payment is never a claim, even if it happens to
  // contain a TrxID-looking token ("What is your bKash number?").
  if (PAYMENT_QUESTION_PATTERN.test(t)) return false;
  if (!trxId) return false;
  return PAID_STATEMENT_PATTERN.test(t);
}
