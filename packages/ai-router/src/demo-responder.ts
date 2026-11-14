/**
 * Deterministic template responder — @tectonic/ai-router (Phase 4 of
 * the modular restructure). The api and the workers each had their own
 * copy of the ai router (api/src/ai/router.ts vs workers/src/ai/);
 * this package is the one implementation both import. Code moved
 * verbatim from the workers split; no behaviour change.
 */

import { detectCustomerLanguage } from './language.js';
import type { ProductItem, KnowledgeItem } from './prompts.js';

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

  function matchWord(str: string, word: string): boolean {
    if (!word) return false;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])${escaped}(?:[^\\p{L}\\p{M}\\p{N}_]|$)`, 'iu');
    return pattern.test(str);
  }

  // 1. Delivery / Shipping intent (word boundaries avoid matching in 'charger' or 'চার্জার')
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
          if (lang === 'bn') {
            return `আমাদের ডেলিভারি তথ্য: ${k.content}`;
          }
          if (lang === 'banglish') {
            return `Amader delivery info: ${k.content}`;
          }
          return `Our delivery policy: ${k.content}`;
        }
      }
    }

    if (lang === 'bn') {
      return 'আমাদের ডেলিভারি চার্জ ঢাকার ভেতরে ৬০ টাকা এবং ঢাকার বাইরে ১২০ টাকা। ক্যাশ অন ডেলিভারি সুবিধা রয়েছে।';
    }
    if (lang === 'banglish') {
      return 'Amader delivery charge Dhaka city-r bhitore 60 taka ebong Dhaka-r baire 120 taka. Cash on delivery available ache.';
    }
    return 'Our delivery charge is 60 BDT inside Dhaka and 120 BDT outside Dhaka. Cash on Delivery is available.';
  }

  // 2. Order intent (with word boundaries and conversational memory)
  const reOrder = /(?:^|[^\p{L}\p{M}\p{N}_])(order|buy|purchase|kinte|nibo|nebo|lagbe|nite|chai|chaichi|haa|ha|yes|confirm|অর্ডার|কিনব|কিনতে|নিব|চাই|নিতে|চাচ্ছি|হাঁ|হ্যাঁ)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (reOrder.test(text)) {
    // Scan previous history for referenced product
    let referencedProduct: ProductItem | undefined;
    for (const h of [...history].reverse()) {
      const hText = (h.content || '').toLowerCase();
      for (const p of products) {
        if (hText.includes(p.name.toLowerCase())) {
          referencedProduct = p;
          break;
        }
      }
      if (referencedProduct) break;
    }

    const prodLabel = referencedProduct ? ` (${referencedProduct.name})` : '';
    if (lang === 'bn') {
      return `আপনার অর্ডারটি${prodLabel} কনফার্ম করার জন্য অনুগ্রহ করে আপনার নাম, ফোন নম্বর এবং সম্পূর্ণ ডেলিভারি ঠিকানা লিখে দিন।`;
    }
    if (lang === 'banglish') {
      return `Apnar order${prodLabel} confirm korte naam, phone number ar delivery address ta ekhane likhe din please.`;
    }
    return `To confirm your order${prodLabel}, please provide your name, phone number, and delivery address.`;
  }

  // 3. Knowledge Base & Policies inquiry
  const rePolicy = /(?:^|[^\p{L}\p{M}\p{N}_])(return|refund|exchange|warranty|guarantee|ferot|change|policy|ফেরত|ওয়ারেন্টি|ওয়ারেন্টি|পলিসি)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (rePolicy.test(text) && knowledge && knowledge.length > 0) {
    for (const k of knowledge) {
      const combined = `${k.title || ''} ${k.content || ''} ${k.category || ''}`.toLowerCase();
      if (
        combined.includes('return') ||
        combined.includes('refund') ||
        combined.includes('policy') ||
        combined.includes('warranty') ||
        combined.includes('ফেরত') ||
        combined.includes('পলিসি')
      ) {
        if (lang === 'bn') {
          return `আমাদের পলিসি: ${k.content}। বিস্তারিত জানতে আমাদের জানাতে পারেন।`;
        }
        if (lang === 'banglish') {
          return `Amader policy: ${k.content}. Kono query thakle janate paren.`;
        }
        return `Our policy: ${k.content}.`;
      }
    }
  }

  // 4. Price inquiry with intelligent product name matching
  const rePrice = /(?:^|[^\p{L}\p{M}\p{N}_])(dam|daam|price|cost|koto|rate|দাম|মূল্য|কত)(?:[^\p{L}\p{M}\p{N}_]|$)/iu;
  if (rePrice.test(text) || products.length > 0) {
    if (products.length > 0) {
      let matched: ProductItem | undefined;
      for (const p of products) {
        const pNameLower = p.name.toLowerCase();
        if (matchWord(text, pNameLower)) {
          matched = p;
          break;
        }
        const words = pNameLower.split(/\s+/);
        for (const w of words) {
          if (w.length > 3 && (matchWord(text, w) || (w === 'charger' && matchWord(text, 'চার্জার')) || (w === 'চার্জার' && matchWord(text, 'charger')))) {
            matched = p;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched && rePrice.test(text)) {
        matched = products[0];
      }

      if (matched) {
        if (matched.stock !== undefined && matched.stock <= 0) {
          if (lang === 'bn') return `দুঃখিত, ${matched.name} বর্তমানে স্টক আউট আছে।`;
          if (lang === 'banglish') return `Dukkhito, ${matched.name} ekhon stock out ache.`;
          return `Sorry, ${matched.name} is currently out of stock.`;
        }
        if (lang === 'bn') {
          return `${matched.name}-এর মূল্য ${matched.price_bdt} টাকা। আপনি কি এটি অর্ডার করতে চান?`;
        }
        if (lang === 'banglish') {
          return `${matched.name}-er price ${matched.price_bdt} BDT. Apni ki eta order korte chan?`;
        }
        return `${matched.name} is ${matched.price_bdt} BDT. Would you like to order it?`;
      }
    }
  }

  if (lang === 'bn') {
    return 'ধন্যবাদ মেসেজ দেওয়ার জন্য! আমি আপনাকে কীভাবে সাহায্য করতে পারি?';
  }
  if (lang === 'banglish') {
    return 'Message korar jonno dhonnobad! Apnake kivabe shahajjo korte pari?';
  }
  return 'Thank you for reaching out! How can we assist you today?';
}
