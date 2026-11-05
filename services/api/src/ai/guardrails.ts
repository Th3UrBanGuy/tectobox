import { detectCustomerLanguage } from './router.js';

export type ThreatType = 
  | 'prompt_leak' 
  | 'instruction_override' 
  | 'jailbreak' 
  | 'price_tampering' 
  | 'code_injection' 
  | 'policy_bypass';

export interface GuardrailResult {
  isSafe: boolean;
  threatType?: ThreatType;
  matchedPattern?: string;
  safeDefusalReply?: string;
}

// 1. Direct prompt leakage & extraction attempts
const PROMPT_LEAK_REGEXES = [
  /(?:system\s*prompt|initial\s*prompt|base\s*prompt|hidden\s*prompt)/i,
  /(?:reveal|show|print|output|display|repeat|tell\s*me)\s+(?:all\s+)?(?:your\s+)?(?:system|initial|base|developer|internal)\s+(?:prompt|instructions?|rules?|directives?)/i,
  /(?:what\s+(?:are|were)\s+your\s+(?:system\s+)?instructions?)/i,
  /(?:output\s+(?:the\s+)?(?:text|words)\s+above)/i,
  /(?:system\s*prompt\s*টা\s*কি|তোমার\s*(?:আসল\s*)?ইন্সট্রাকশন\s*(?:কি|বলো))/i,
  /(?:promp?t\s*(?:leak|print|show|bolun|dekhao))/i,
];

// 2. Instruction overrides, role reversals, and jailbreaks
const INSTRUCTION_OVERRIDE_REGEXES = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|directives?|rules?|constraints?)/i,
  /disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|rules?)/i,
  /forget\s+(?:all\s+)?(?:rules?|instructions?|training|guidelines?)/i,
  /(?:system\s*override|mode\s*override|security\s*override|developer\s*mode|god\s*mode)/i,
  /(?:you\s+are\s+now\s+(?:in\s+)?(?:DAN|unrestricted|jailbreak|chaos|evil|admin)\s*(?:mode)?)/i,
  /(?:stop\s+being\s+(?:a|an)\s+(?:sales|ai|store)\s*(?:bot|assistant)?)/i,
  /(?:pretend\s+(?:you\s+have\s+no\s+rules|you\s+are\s+unconstrained))/i,
  /(?:আগের\s*সব\s*(?:ভুলে\s*যাও|বাদ\s*দাও)|সব\s*নিয়ম\s*বাতিল\s*কর)/i,
  /(?:ager\s*shob\s*(?:bhule\s*jao|bad\s*dao)|shob\s*rule\s*ignore\s*koro)/i,
];

// 3. Unauthorized price override & catalog tampering
const PRICE_TAMPERING_REGEXES = [
  /(?:set|change|make)\s+(?:the\s+)?price\s+(?:to|as)\s+(?:0|zero|free|1\s*bdt|1\s*taka)/i,
  /(?:give\s+(?:it|product|everything)\s+to\s+me\s+for\s+(?:free|0|nothing|1\s*tk))/i,
  /(?:the\s+owner\s+(?:authorized|told\s+you|said)\s+to\s+give\s+(?:100%|99%|free|zero))/i,
  /(?:override\s+catalog\s+price)/i,
  /(?:apply\s+(?:secret|admin|bypass)\s+coupon)/i,
  /(?:১\s*টাকায়\s*দাও|ফ্রি\s*তে\s*দাও|১০০%\s*ডিসকাউন্ট\s*দাও)/i,
  /(?:1\s*takay\s*dao|free\s*te\s*dao|price\s*0\s*kore\s*dao)/i,
];

// 4. Malicious code, command injection, and SQL strings
const CODE_INJECTION_REGEXES = [
  /(?:DROP\s+TABLE|UNION\s+SELECT|INSERT\s+INTO|ALTER\s+TABLE|DELETE\s+FROM)\b/i,
  /<script\b[^>]*>[\s\S]*?<\/script>/i,
  /(?:javascript:|onerror=|onload=|<svg\s+onload)/i,
  /(?:rm\s+-rf\s+|curl\s+-s\s+|wget\s+http|cat\s+\/etc\/passwd)/i,
  /(?:(?:exec|spawn|eval)\s*\()/i,
];

/**
 * Evaluates whether an incoming user message contains adversarial prompt injection,
 * system prompt extraction, jailbreak attempts, or unauthorized price manipulation.
 */
export function evaluatePromptSafety(text: string): GuardrailResult {
  const clean = String(text || '').trim();
  if (!clean) return { isSafe: true };

  const lang = detectCustomerLanguage(clean);

  // Check 1: Prompt Leakage
  for (const rx of PROMPT_LEAK_REGEXES) {
    if (rx.test(clean)) {
      return {
        isSafe: false,
        threatType: 'prompt_leak',
        matchedPattern: rx.source,
        safeDefusalReply: getDefusalMessage('prompt_leak', lang),
      };
    }
  }

  // Check 2: Instruction Overrides & Jailbreaks
  for (const rx of INSTRUCTION_OVERRIDE_REGEXES) {
    if (rx.test(clean)) {
      return {
        isSafe: false,
        threatType: 'instruction_override',
        matchedPattern: rx.source,
        safeDefusalReply: getDefusalMessage('instruction_override', lang),
      };
    }
  }

  // Check 3: Price Tampering & Catalog Hijacking
  for (const rx of PRICE_TAMPERING_REGEXES) {
    if (rx.test(clean)) {
      return {
        isSafe: false,
        threatType: 'price_tampering',
        matchedPattern: rx.source,
        safeDefusalReply: getDefusalMessage('price_tampering', lang),
      };
    }
  }

  // Check 4: Code / SQL / Exploit Injection
  for (const rx of CODE_INJECTION_REGEXES) {
    if (rx.test(clean)) {
      return {
        isSafe: false,
        threatType: 'code_injection',
        matchedPattern: rx.source,
        safeDefusalReply: getDefusalMessage('code_injection', lang),
      };
    }
  }

  return { isSafe: true };
}

function getDefusalMessage(threat: ThreatType, lang: 'bn' | 'banglish' | 'en' | 'hi'): string {
  switch (threat) {
    case 'prompt_leak':
      if (lang === 'bn') {
        return 'আমি শুধুমাত্র আমাদের স্টোরের পণ্য, দাম, ওয়ারেন্টি এবং ডেলিভারি সংক্রান্ত তথ্যে সহায়তা করতে পারি। সিস্টেমের অভ্যন্তরীণ কনফিগারেশন শেয়ার করা সম্ভব নয়।';
      }
      if (lang === 'banglish') {
        return 'Ami shudhumatro amader store-er product, price, warranty ebong delivery related tothye shahajjo korte pari. System-er internal configuration share kora shombhov noy.';
      }
      return 'I am exclusively authorized to assist with product specifications, pricing, and orders. Internal system instructions cannot be disclosed.';

    case 'instruction_override':
    case 'jailbreak':
      if (lang === 'bn') {
        return 'দুঃখিত, কোনো অননুমোদিত নির্দেশ বা সিস্টেম ওভাররাইড কার্যকর করা সম্ভব নয়। আমি আপনাকে আমাদের অফিসিয়াল পণ্যের তথ্য বা অর্ডার করতে কীভাবে সাহায্য করতে পারি?';
      }
      if (lang === 'banglish') {
        return 'Dukkhito, kono ononumodito nirdesh ba system override execute kora shombhov noy. Ami apnake amader catalog theke kivabe help korte pari?';
      }
      return 'Unauthorized operational instructions or mode overrides cannot be executed. How may I assist you with our catalog products or orders today?';

    case 'price_tampering':
      if (lang === 'bn') {
        return 'আমাদের পণ্যের মূল্য এবং পলিসি সম্পূর্ণ নির্ধারিত। ক্যাটালগের বাইরের কোনো অননুমোদিত অফার বা মূল্য পরিবর্তন গ্রহণযোগ্য নয়।';
      }
      if (lang === 'banglish') {
        return 'Amader product-er price ebong policies nirdharito. Catalog-er baire kono ononumodito price change accept kora hoy na.';
      }
      return 'All product prices and store policies are strictly fixed from our verified catalog. Unauthorized price alterations cannot be accepted.';

    case 'code_injection':
    default:
      if (lang === 'bn') {
        return 'অননুমোদিত ইনপুট বা স্ক্রিপ্ট শনাক্ত হয়েছে। আপনার অনুরোধটি প্রক্রিয়া করা সম্ভব নয়।';
      }
      if (lang === 'banglish') {
        return 'Unsanitized input ba script detect hoyeche. Request execute kora shombhov noy.';
      }
      return 'Invalid input format or script pattern detected. The request cannot be processed.';
  }
}
