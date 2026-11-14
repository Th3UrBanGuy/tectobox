/**
 * Payment-claim parsing — @tectonic/ai-router (Phase 4 of the modular
 * restructure). This was api-only (api/src/ai/router.ts): the workers
 * never parse payment claims. It moved here verbatim so the api's
 * `parsePaymentClaim` import keeps working through the shared package.
 * No behaviour change.
 */

import type { ProductItem } from './prompts.js';

export interface PaymentClaim {
  isPaymentClaim: boolean;
  method: 'bkash' | 'nagad' | 'rocket' | 'bank' | 'other';
  trxId: string;
  amount: number;
  senderPhone?: string;
}

export function parsePaymentClaim(
  text: string,
  products: ProductItem[] = [],
  history: Array<{ role: string; content: string }> = []
): PaymentClaim | null {
  const t = text.trim();

  // 1. Detect payment claim intent keywords
  const hasPaymentKeyword = /(b[\s\-]*kash|বিকাশ|nagad|নগদ|rocket|রকেট|upay|উপায়|bank|টাকা\s*(পাঠিয়েছি|দিছি|পাঠাইছি|পাঠানো\s*হয়েছে)|পেমেন্ট\s*(করেছি|দিছি|ডান|হয়েছে)|trx\s*id|transaction\s*id|txid|টিএক্সআইডি|paid|payment\s*done|sent\s*money)/i.test(t);

  // 2. Extract TrxID
  let trxMatch = t.match(/(?:trx\s*id|transaction\s*id|txid|টিএক্সআইডি|ট্রানজেকশন\s*আইডি)[:\s#-]*([A-Za-z0-9]{6,16})/i);
  let trxId = trxMatch ? trxMatch[1] : '';

  // Standalone uppercase alphanumeric token
  if (!trxId && hasPaymentKeyword) {
    const tokens = t.split(/[\s,;:!]+/);
    for (const tok of tokens) {
      if (/^[A-Za-z0-9]{8,14}$/.test(tok) && /\d/.test(tok) && /[A-Za-z]/.test(tok)) {
        trxId = tok;
        break;
      }
    }
  }

  if (!hasPaymentKeyword && !trxId) {
    return null;
  }

  // 3. Extract method
  let method: 'bkash' | 'nagad' | 'rocket' | 'bank' | 'other' = 'bkash';
  if (/nagad|নগদ/i.test(t)) method = 'nagad';
  else if (/rocket|রকেট/i.test(t)) method = 'rocket';
  else if (/bank|ব্যাংক/i.test(t)) method = 'bank';
  else if (/bkash|বিকাশ/i.test(t)) method = 'bkash';

  // 4. Extract Amount
  let amount = 0;
  const amtMatch = t.match(/(?:৳|tk|taka|bdt|টাকা)?\s*(\d{2,6})\s*(?:৳|tk|taka|bdt|টাকা)/i) ||
                   t.match(/(\d{3,6})\s*(?:taka|tk|৳|টাকা)/i) ||
                   t.match(/(?:amount|taka|tk|৳|টাকা|পরিমাণ)[:\s]*(\d{2,6})/i);
  if (amtMatch) {
    amount = Number(amtMatch[1]);
  } else {
    for (const h of [...history].reverse()) {
      const hText = (h.content || '').toLowerCase();
      for (const p of products) {
        if (hText.includes(p.name.toLowerCase())) {
          amount = Number(p.price_bdt) || 0;
          break;
        }
      }
      if (amount > 0) break;
    }
    if (amount === 0 && products.length > 0) {
      amount = Number(products[0].price_bdt) || 0;
    }
  }

  // 5. Extract Sender Phone
  const phoneMatch = t.match(/\b(01[3-9]\d{8})\b/);
  const senderPhone = phoneMatch ? phoneMatch[1] : undefined;

  if (!trxId) {
    trxId = `CLAIM-${Date.now().toString().slice(-6)}`;
  }

  return {
    isPaymentClaim: true,
    method,
    trxId: trxId.toUpperCase(),
    amount,
    senderPhone,
  };
}
