/**
 * Payment-claim parsing — @tectonic/ai-router (Phase 4 of the modular
 * restructure). This was api-only (api/src/ai/router.ts): the workers
 * never parse payment claims. It moved here so the api's
 * `parsePaymentClaim` import keeps working through the shared package.
 * Behaviour changed by the W5 fix (2026-11-15) — see the security
 * rules below.
 * Security rules (W5, 2026-11-15) — this is a money path:
 * - A TrxID is accepted ONLY when it matches the provider's format:
 *   bKash / Nagad / Rocket TrxIDs are exactly 10 alphanumeric
 *   characters. Anything else is reported as `trxValid: false` with a
 *   rejection reason — it must never be accepted, stored, or confirmed.
 * - The amount is NEVER invented here. It is only the amount the
 *   customer states in this message; the real order total is resolved
 *   by the caller (PaymentClaimService) from the actual order. There is
 *   no product-price fallback and no fabricated CLAIM id — the old code
 *   that generated `CLAIM-<timestamp>` and defaulted to the first
 *   product's price ("chocklate", ৳700) was the hallucination path and
 *   has been deleted entirely.
 */

import type { ProductItem } from './prompts.js';

export type PaymentMethod = 'bkash' | 'nagad' | 'rocket' | 'bank' | 'other';

/** Why a payment claim cannot be accepted. */
export type PaymentClaimRejection = 'invalid_trxid' | 'missing_trxid';

export interface PaymentClaim {
  isPaymentClaim: boolean;
  method: PaymentMethod;
  /** The TrxID exactly as the customer wrote it (upper-cased), or '' when none was given. */
  trxId: string;
  /** True only when `trxId` matches the provider's format (see `isValidTrxId`). */
  trxValid: boolean;
  /** Set only when `trxValid` is false. */
  rejectionReason?: PaymentClaimRejection;
  /**
   * Amount the customer stated in this message, in BDT. 0 means "not
   * stated" — it is never inferred from the catalog or history.
   */
  amount: number;
  senderPhone?: string;
}

/** bKash / Nagad / Rocket TrxIDs are exactly 10 alphanumeric characters. */
export const TRX_ID_LENGTH = 10;

const MFS_TRX_ID_PATTERN = /^[A-Za-z0-9]{10}$/;
/** Bank references have no fixed format; require a plausible reference. */
const BANK_REF_PATTERN = /^[A-Za-z0-9]{6,20}$/;

export function isValidTrxId(method: PaymentMethod, trxId: string): boolean {
  switch (method) {
    case 'bkash':
    case 'nagad':
    case 'rocket':
      return MFS_TRX_ID_PATTERN.test(trxId);
    case 'bank':
    case 'other':
      return BANK_REF_PATTERN.test(trxId);
  }
}

export function parsePaymentClaim(
  text: string,
  // Accepted for call-site compatibility with the widget flow. The catalog
  // and history are deliberately NOT used here: an amount must never be
  // inferred from a product price or from what was discussed earlier.
  _products: ProductItem[] = [],
  _history: Array<{ role: string; content: string }> = []
): PaymentClaim | null {
  void _products;
  void _history;
  const t = text.trim();

  // 1. Detect payment claim intent keywords
  const hasPaymentKeyword = /(b[\s\-]*kash|বিকাশ|nagad|নগদ|rocket|রকেট|upay|উপায়|bank|টাকা\s*(পাঠিয়েছি|দিছি|পাঠাইছি|পাঠানো\s*হয়েছে)|পেমেন্ট\s*(করেছি|দিছি|ডান|হয়েছে)|trx\s*id|transaction\s*id|txid|টিএক্সআইডি|paid|payment\s*done|sent\s*money)/i.test(t);

  // 2. Extract the TrxID as written (validation happens in step 5 — the
  // raw token is kept so the caller can tell the customer exactly what
  // was wrong with it instead of silently dropping it).
  // A label ("TrxID", "transaction id", "ট্রানজেকশন আইডি", ...) is
  // followed by the value, optionally with "is" / "হলো" in between
  // ("TrxID is XYZ"). A lowercase word with no digit ("not", "is") is
  // not a TrxID attempt — it means the customer gave no id at all.
  let trxId = '';
  const labelMatch = t.match(/(trx\s*id|transaction\s*id|txid|টিএক্সআইডি|ট্রানজেকশন\s*আইডি)/i);
  if (labelMatch && labelMatch.index !== undefined) {
    const after = t.slice(labelMatch.index + labelMatch[0].length);
    const cleaned = after.replace(/^[\s:;#-]*(?:is\s+|হলো\s+)?/, '');
    const token = cleaned.match(/^[A-Za-z0-9]{1,20}/)?.[0] ?? '';
    if (token && (/\d/.test(token) || token === token.toUpperCase())) {
      trxId = token;
    }
  }

  // Standalone alphanumeric token (e.g. "I paid ABCDEFGHIJ via bKash").
  // Must contain both a letter and a digit so phone numbers and bare
  // amounts are never mistaken for a TrxID. A bare 10-character
  // all-uppercase token is also a TrxID attempt (real TrxIDs can be
  // all letters); lowercase words are not.
  if (!trxId && hasPaymentKeyword) {
    const tokens = t.split(/[\s,;:!]+/);
    for (const tok of tokens) {
      if (/^[A-Za-z0-9]{8,14}$/.test(tok) && /\d/.test(tok) && /[A-Za-z]/.test(tok)) {
        trxId = tok;
        break;
      }
    }
    if (!trxId) {
      for (const tok of tokens) {
        if (/^[A-Z0-9]{10}$/.test(tok) && /[A-Z]/.test(tok)) {
          trxId = tok;
          break;
        }
      }
    }
  }

  if (!hasPaymentKeyword && !trxId) {
    return null;
  }

  // 3. Extract method
  let method: PaymentMethod = 'bkash';
  if (/nagad|নগদ/i.test(t)) method = 'nagad';
  else if (/rocket|রকেট/i.test(t)) method = 'rocket';
  else if (/bank|ব্যাংক/i.test(t)) method = 'bank';
  else if (/bkash|বিকাশ/i.test(t)) method = 'bkash';

  // 4. Extract the amount the customer STATED in this message — and only
  // that. No fallback to any product price or to history.
  let amount = 0;
  const amtMatch = t.match(/(?:৳|tk|taka|bdt|টাকা)?\s*(\d{2,6})\s*(?:৳|tk|taka|bdt|টাকা)/i) ||
                   t.match(/(\d{3,6})\s*(?:taka|tk|৳|টাকা)/i) ||
                   t.match(/(?:amount|taka|tk|৳|টাকা|পরিমাণ)[:\s]*(\d{2,6})/i);
  if (amtMatch) {
    amount = Number(amtMatch[1]);
  }

  // 5. Extract Sender Phone
  const phoneMatch = t.match(/\b(01[3-9]\d{8})\b/);
  const senderPhone = phoneMatch ? phoneMatch[1] : undefined;

  // 6. Validate the TrxID format for the detected provider. An invalid or
  // missing TrxID is NOT replaced with a generated id — the claim is
  // returned as invalid and the caller must reject it without storing
  // or confirming anything.
  const normalizedTrxId = trxId.toUpperCase();
  if (!trxId) {
    return {
      isPaymentClaim: true,
      method,
      trxId: '',
      trxValid: false,
      rejectionReason: 'missing_trxid',
      amount,
      senderPhone,
    };
  }
  if (!isValidTrxId(method, normalizedTrxId)) {
    return {
      isPaymentClaim: true,
      method,
      trxId: normalizedTrxId,
      trxValid: false,
      rejectionReason: 'invalid_trxid',
      amount,
      senderPhone,
    };
  }

  return {
    isPaymentClaim: true,
    method,
    trxId: normalizedTrxId,
    trxValid: true,
    amount,
    senderPhone,
  };
}
