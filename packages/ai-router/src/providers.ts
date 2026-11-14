/**
 * LLM provider tiers — @tectonic/ai-router (Phase 4 of the modular
 * restructure). The api and the workers each had their own copy of the
 * ai router (api/src/ai/router.ts vs workers/src/ai/); this package is
 * the one implementation both import. Code moved verbatim from the
 * workers split; no behaviour change.
 */

import type { AIRequestMessage, ProductItem, KnowledgeItem } from './prompts.js';
import { detectCustomerLanguage } from './language.js';
import { demoResponder } from './demo-responder.js';

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
 * Fail fast on a missing backend URL (Phase 6). The old code silently
 * fell back to a localhost address that points at the caller's own
 * container in production (the workers container has no AI backend on
 * :8081), so a misconfigured deploy answered with deterministic
 * templates instead of erroring. Now the missing var throws a clear
 * error naming it, so the misconfiguration is visible at once.
 * NOTE: this is a failure-mode change only — when the backend IS
 * configured but unreachable, the deterministic-template fallback below
 * is unchanged.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: the AI backend URL must be configured explicitly ` +
        `(no localhost fallback). Set ${name} to the Go ai service URL.`,
    );
  }
  return value;
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
  const goUrl = requireEnv('GO_AI_URL');
  try {
    const res = await fetch(goUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // NOTE (F1): the Go bridge expects snake_case keys (client_id,
      // client_name, business_type). Go takes client_id as a typed
      // router.ClientID and rejects the request with 400 when it is
      // missing — a camelCase `clientId` no longer decodes, so sending
      // camelCase would fail the request instead of serving it under
      // a shared tenant id.
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
 * Tier 1: Gemini Web2API (zero auth, the Go ai service /v1 base)
 * Tier 2: Cloudflare playground models on AI_BASE_URL (optional tier)
 * Tier 3: Direct APIs (Gemini API, OpenRouter, OpenAI) if configured
 * Tier 4: Fallback demo responder
 */

export async function getAIResponse(messages: AIRequestMessage[], contextKey = 'default'): Promise<string | null> {
  // 1. Try Gemini Web2API (fast, high quality, free)
  // NOTE — env-var name (renamed in Phase 6): GEMINI_WEB2API_URL means
  // this service's /v1 base URL here (the Go ai service,
  // http://ai:8081/v1). Inside the ai container the same backend is
  // read from GEMINI_WEB2API_PROXY_URL (the external web2api proxy
  // URL). Setting one name in the wrong place silently re-routes a tier.
  // NOTE (F1 Knowledge Leak Fix):
  // The gemini-web2api proxy uses a single shared browser session for all requests without
  // per-workspace session isolation. In multi-tenant environments (widget / worker / workspace traffic),
  // skip web2api to prevent cross-workspace prompt and policy leakage.
  if (contextKey === 'default' || !contextKey) {
    const geminiWeb2ApiUrl = requireEnv('GEMINI_WEB2API_URL');
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

  // 2. Try Cloudflare Playground / Workers AI models.
  // NOTE (Phase 6): AI_BASE_URL is an OPTIONAL tier — there is no
  // Cloudflare backend in compose, so when it is unset the tier is
  // skipped entirely (never pointed at localhost:18080, which is the
  // caller's own container in production). Tiers 3-5 still run, and the
  // deterministic-template fallback is unchanged.
  const cfBaseUrl = process.env.AI_BASE_URL;
  if (cfBaseUrl) {
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

