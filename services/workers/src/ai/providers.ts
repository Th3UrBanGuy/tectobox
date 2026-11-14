/**
 * LLM provider tiers — split from ai/router.ts in Phase 2 of the modular
 * restructure. Code moved verbatim; no behaviour change.
 */

import type { AIRequestMessage, ProductItem, KnowledgeItem } from './prompts.ts';
import { detectCustomerLanguage } from './language.ts';
import { demoResponder } from './demo-responder.ts';

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

export const GO_AI_TIMEOUT_MS = 25000;

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
      // NOTE (F1): the Go bridge expects snake_case keys (client_id,
      // client_name, business_type). Sending camelCase leaves Go's
      // ClientID nil, so every workspace shared one "<nil>" cache key
      // and rate-limit bucket — cross-workspace reply leakage.
      body: JSON.stringify({
        ...params,
        client_id: params.clientId,
        client_name: params.clientName,
        business_type: params.businessType,
        clientId: undefined,
        clientName: undefined,
        businessType: undefined,
      }),
      // 25s: explicit timeout below the widget's 30s abort.
      signal: AbortSignal.timeout(GO_AI_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = await res.json() as any;
      if (data && data.reply) {
        return data;
      }
    } else if (res.status === 504) {
      const templateReply = demoResponder(
        params.clientId || 'default',
        params.text,
        params.products || [],
        params.history || [],
        params.knowledge || []
      );
      const lang = detectCustomerLanguage(params.text);
      return {
        reply: templateReply,
        language: lang,
        model: 'timeout-fallback:deterministic',
        cached: false,
      };
    }
  } catch (err: any) {
    if (
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      (err && String(err).toLowerCase().includes('timeout'))
    ) {
      const templateReply = demoResponder(
        params.clientId || 'default',
        params.text,
        params.products || [],
        params.history || [],
        params.knowledge || []
      );
      const lang = detectCustomerLanguage(params.text);
      return {
        reply: templateReply,
        language: lang,
        model: 'timeout-fallback:deterministic',
        cached: false,
      };
    }
  }
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

