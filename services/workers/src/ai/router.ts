export interface AIRequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProductItem {
  name: string;
  sku?: string;
  price_bdt: number | string;
  stock?: number;
  category?: string;
}

export interface KnowledgeItem {
  title: string;
  content: string;
  category?: string;
}

export interface PromptContext {
  clientName?: string;
  businessType?: 'physical' | 'digital';
  products?: ProductItem[];
  knowledge?: KnowledgeItem[];
}

const BN_WORDS = new Set(
  ('dam damta damadami koto kotokhon kotogulo ki keno kivabe kibhabe kemne ' +
   'chai chay chaichi lagbe lagbo diben dibo debo nibo nebo pathan pathabo pathate pathiye ' +
   'apni apnar apnake apnader tumi tomar tomake tomader ami amar amake amader ' +
   'kore koren korbo korben korle korchi hobe hoben hobena hoyni ache achen achhen nei nai ' +
   'kothay kothai kotha kothata bolen bolun bolbo bolte bolben janen jante janan ' +
   'dekhte nite kinte kinbo nite asbe ashte ashbo jabe jaben jabo ' +
   'thakbe thakben thakbo cholbe cholte rokom moto moton shathe sathe jonno jonne theke ' +
   'diye niye bhabe bhai bhaiya apu dada didi salam assalamu alaikum walaikum ' +
   'dhonnobad bhalo kharap sundor shundor notun purono puran komano komate kombe kom ' +
   'beshi onek ektu ekta duita tinta koyta koyekta prothom shesh ajke kalke porshu ' +
   'ekhon ekhono tokhon agey porey pore age shob shobai shobgulo kichu kichui kono konota ' +
   'keu kake kader kar karo jara jader she shey tara tader ora oder eta ota egulo ogulo ' +
   'ekhane okhane shekhane bashay dokan dokane bazar bazare dhaka dhakar dhakay dhakate ' +
   'taka takay takar poisha poishay cash bikash bkash nagad rocket ' +
   'order orderta orderti deliveryta productta productgulo jinish jinishta mal maal dam ' +
   'khabar item items price pricegulo discount offerta offer cholche ' +
   'ache achen nei nai hobe hoben hobena korchi korchen korlam dilam nilam pelam ' +
   'bujhi bujhlam bujhte parchi parbo parben pari paren korte kortei hote ' +
   'holo hoyeche hoyechhe holo hoy hoy na hyna na naa haa haan ha ji accha achha ' +
   'thik thik ache thikache okhay okey shomossha somossha somossa mushkil jhamela ' +
   'dorkar proyojon lagbe chai chay kori koro koren ' +
   'dekhun dekhbo ashun ashbo boshun bolun bolen shunun koren janun nin nen din den ' +
   'kothay kobe kokhon kikore ki kore kisher keno kisher jonno kar jonno').split(/\s+/)
);

export function detectCustomerLanguage(rawText: string): 'bn' | 'banglish' | 'en' | 'hi' {
  const t = String(rawText || '');
  if (/[\u0980-\u09FF]/.test(t)) return 'bn'; // Bangla script
  if (/[\u0900-\u097F]/.test(t)) return 'hi'; // Devanagari script
  const words = t.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!words.length) return 'en';
  let hits = 0;
  for (const w of words) if (BN_WORDS.has(w)) hits++;
  if (hits >= 2 || (words.length <= 6 && hits >= 1)) return 'banglish';
  return 'en';
}

export function languageDirective(lang: 'bn' | 'banglish' | 'en' | 'hi'): string {
  const base = `LANGUAGE (NON-NEGOTIABLE): the customer is writing in ${
    lang === 'bn' ? 'Bangla (বাংলা হরফে লিখুন)' :
    lang === 'banglish' ? 'Banglish (Bengali in English/Latin letters, e.g. "dam koto", "kivabe nibo")' :
    lang === 'hi' ? 'Hindi' : 'English'
  }. Your reply MUST be written in exactly that language.`;
  if (lang === 'banglish') {
    return base + ' Banglish is Bengali written in Latin letters — it is NOT Hindi. NEVER reply in Hindi. NEVER use Devanagari script (अ-হ) under any circumstances. If you feel tempted to write Hindi, write Banglish instead.';
  }
  if (lang === 'bn') {
    return base + ' Write ONLY in Bangla script (বাংলা হরফ). NEVER use Devanagari script (अ-হ) or Hindi.';
  }
  return base;
}

export function buildSystemPrompt(context: PromptContext, langDirectiveText?: string): string {
  const products = context.products || [];
  const knowledge = context.knowledge || [];
  const clientName = context.clientName || 'Aurora Store';
  const bizKind = context.businessType === 'digital'
    ? 'a DIGITAL business (no physical delivery; delivery location not required)'
    : 'a PHYSICAL business (delivery address & phone required for orders)';

  const prodLines = products.length
    ? products.map(p => `- ${p.name} (SKU: ${p.sku || 'N/A'}, Price: ${p.price_bdt} BDT, Stock: ${p.stock ?? 'in stock'})`).join('\n')
    : '(no products catalog yet)';

  const kbLines = knowledge.length
    ? knowledge.map(k => `### ${k.title} [${k.category || 'general'}]\n${k.content}`).join('\n\n')
    : '(no knowledge base entries yet)';

  return `You are the sales assistant for "${clientName}", ${bizKind}, in Bangladesh.
Reply in the same language the customer uses.
${langDirectiveText ? langDirectiveText + '\n' : ''}
PRODUCT CATALOG — quote ONLY from this list. NEVER invent prices, SKUs or products:
${prodLines}

SHOP KNOWLEDGE & POLICIES:
${kbLines}

RULES:
1. Always be polite, helpful, and concise (1-3 sentences).
2. Prices and product specs must be exact from the catalog.
3. If delivery charge is asked and not specified in knowledge, default to 60 BDT inside Dhaka and 120 BDT outside Dhaka.
4. If a customer wants to buy or order, ask for their name, phone number, and delivery address.`;
}

// Default Cloudflare playground model pool
export const CF_MODEL_POOL = [
  '@cf/zai-org/glm-4.7-flash',
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
];

async function callOpenAICompatible(url: string, apiKey: string, model: string, messages: AIRequestMessage[], timeoutMs = 12000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }

    const data: any = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

/**
 * High-performance Go AI Engine client
 */
export async function queryGoAIEngine(params: {
  clientId?: string | number;
  clientName?: string;
  businessType?: string;
  text: string;
  history?: Array<{ role: string; content: string }>;
  products?: ProductItem[];
  knowledge?: KnowledgeItem[];
  model?: string;
}): Promise<{ reply: string; language: string; model: string; cached: boolean } | null> {
  const goUrl = process.env.GO_AI_URL || 'http://127.0.0.1:8081/api/ai/chat';
  try {
    const res = await fetch(goUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(5500),
    });
    if (res.ok) {
      const data = await res.json() as any;
      if (data && data.reply) {
        return data;
      }
    }
  } catch {}
  return null;
}

/**
 * Multi-tier AI Response:
 * Tier 1: Gemini Web2API (zero auth, http://127.0.0.1:8081/v1)
 * Tier 2: Cloudflare playground models on AI_BASE_URL (http://127.0.0.1:18080/v1)
 * Tier 3: Direct APIs (Gemini API, OpenRouter, OpenAI) if configured
 * Tier 4: Fallback demo responder
 */
export async function getAIResponse(messages: AIRequestMessage[], contextKey = 'default'): Promise<string | null> {
  // 1. Try Gemini Web2API (fast, high quality, free)
  // NOTE (F1 Knowledge Leak Fix):
  // The gemini-web2api proxy uses a single shared browser session for all requests without
  // per-workspace session isolation. In multi-tenant environments (worker / workspace traffic),
  // skip web2api to prevent cross-workspace prompt and policy leakage.
  if (contextKey === 'default' || !contextKey) {
    const geminiWeb2ApiUrl = process.env.GEMINI_WEB2API_URL || 'http://127.0.0.1:8081/v1';
    const geminiModels = ['gemini-3.6-flash', 'gemini-flash-lite'];
    for (const m of geminiModels) {
      try {
        const resp = await callOpenAICompatible(geminiWeb2ApiUrl, '', m, messages, 2500);
        if (resp && resp.trim().length > 0) {
          return cleanModelOutput(resp);
        }
      } catch {}
    }
  }

  // 2. Try Cloudflare Playground / Workers AI models
  const cfBaseUrl = process.env.AI_BASE_URL || 'http://127.0.0.1:18080/v1';
  const cfPool = (process.env.AI_MODEL_POOL ? process.env.AI_MODEL_POOL.split(',') : CF_MODEL_POOL)
    .map(s => s.trim())
    .filter(Boolean);

  for (const m of cfPool) {
    try {
      const resp = await callOpenAICompatible(cfBaseUrl, process.env.AI_API_KEY || 'dummy', m, messages, 2500);
      if (resp && resp.trim().length > 0) {
        return cleanModelOutput(resp);
      }
    } catch {}
  }

  // 3. Try official Gemini API if key is present
  if (process.env.GEMINI_API_KEY) {
    try {
      const resp = await callOpenAICompatible(
        'https://generativelanguage.googleapis.com/v1beta/openai',
        process.env.GEMINI_API_KEY,
        process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash',
        messages,
        15000
      );
      if (resp && resp.trim().length > 0) return cleanModelOutput(resp);
    } catch {}
  }

  // 4. Try OpenRouter if key is present
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const resp = await callOpenAICompatible(
        'https://openrouter.ai/api/v1',
        process.env.OPENROUTER_API_KEY,
        process.env.AI_OPENROUTER_MODEL || 'openai/gpt-oss-20b:free',
        messages,
        15000
      );
      if (resp && resp.trim().length > 0) return cleanModelOutput(resp);
    } catch {}
  }

  // 5. Try OpenAI if key is present
  if (process.env.OPENAI_API_KEY) {
    try {
      const resp = await callOpenAICompatible(
        'https://api.openai.com/v1',
        process.env.OPENAI_API_KEY,
        'gpt-4o-mini',
        messages,
        15000
      );
      if (resp && resp.trim().length > 0) return cleanModelOutput(resp);
    } catch {}
  }

  return null;
}

function cleanModelOutput(raw: string): string {
  let text = raw.replace(/<Section[^>]*>/gi, '')
    .replace(/<\/Section>/gi, '')
    .replace(/<TextBox text="([^"]*)"\s*\/>/gi, '$1')
    .replace(/<Elicitations[\s\S]*?<\/Elicitations>/gi, '')
    .trim();
  return text;
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
