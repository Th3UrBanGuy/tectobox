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

// Circuit breaker for the Go AI engine (Seg-D reliability, W1/S1/T1/SC1).
// Profiling (2026-11-15) proved the Go engine itself is fast — direct
// probes from inside the api container answer in 10-90ms even at 10
// concurrent — but when the ai service is unreachable a hung/blackholed
// connection burns the full 25s fetch timeout on EVERY widget request
// before the deterministic fallback runs. After
// GO_AI_BREAKER_TRIP_FAILURES consecutive failures the breaker opens for
// GO_AI_BREAKER_COOLDOWN_MS and queryGoAIEngine answers from the
// deterministic responder immediately (no fetch at all). Any success
// closes it again. State is module-level on purpose: the api process is
// long-lived and the breaker must survive across requests.
const GO_AI_BREAKER_TRIP_FAILURES = 3;
const GO_AI_BREAKER_COOLDOWN_MS = 30_000;
let goAiConsecutiveFailures = 0;
let goAiBreakerOpenedAt = 0;

/** Test hook: reset the Go-engine circuit breaker to closed. */
export function resetGoAiCircuitBreaker(): void {
  goAiConsecutiveFailures = 0;
  goAiBreakerOpenedAt = 0;
}

function goAiBreakerOpen(): boolean {
  if (goAiBreakerOpenedAt === 0) return false;
  if (Date.now() - goAiBreakerOpenedAt >= GO_AI_BREAKER_COOLDOWN_MS) {
    goAiBreakerOpenedAt = 0;
    goAiConsecutiveFailures = 0;
    return false;
  }
  return true;
}

function recordGoAiSuccess(): void {
  goAiConsecutiveFailures = 0;
  goAiBreakerOpenedAt = 0;
}

function recordGoAiFailure(): void {
  goAiConsecutiveFailures += 1;
  if (goAiConsecutiveFailures >= GO_AI_BREAKER_TRIP_FAILURES) {
    goAiBreakerOpenedAt = Date.now();
    console.warn(
      `[ai-router] Go AI engine circuit breaker OPEN after ${goAiConsecutiveFailures} consecutive failures; ` +
        `answering from the deterministic responder for ${GO_AI_BREAKER_COOLDOWN_MS / 1000}s.`,
    );
  }
}

/** Knowledge-grounded deterministic reply (the Tier-4 fallback). */
function deterministicGoFallback(params: {
  clientId?: string | number;
  text: string;
  history?: Array<{ role: string; content: string }>;
  products?: ProductItem[];
  knowledge?: KnowledgeItem[];
}, model: string): { reply: string; language: string; model: string; cached: boolean } {
  const templateReply = demoResponder(
    params.clientId || 'default',
    params.text,
    params.products || [],
    params.history || [],
    params.knowledge || [],
  );
  const lang = detectCustomerLanguage(params.text);
  return {
    reply: templateReply,
    language: lang,
    model,
    cached: false,
  };
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
  // A missing backend URL must NEVER throw out of the widget path
  // (Seg-D): the old requireEnv throw escaped generateReply and dropped
  // the customer's reply entirely (NestJS 500, no reply). Return null so
  // the caller falls through to the deterministic responder instead.
  let goUrl: string;
  try {
    goUrl = requireEnv('GO_AI_URL');
  } catch {
    console.warn('[ai-router] GO_AI_URL is not set: answering from the deterministic responder.');
    return null;
  }

  // Circuit breaker open: the engine is down — answer immediately from
  // the deterministic responder instead of burning the 25s timeout.
  if (goAiBreakerOpen()) {
    return deterministicGoFallback(params, 'circuit-open:deterministic');
  }

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
        recordGoAiSuccess();
        return data;
      }
      // 200 without a reply: the engine is misbehaving — count it.
      recordGoAiFailure();
    } else if (res.status === 504) {
      recordGoAiFailure();
      return deterministicGoFallback(params, 'timeout-fallback:deterministic');
    } else {
      recordGoAiFailure();
    }
  } catch (err: any) {
    recordGoAiFailure();
    if (
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      (err && String(err).toLowerCase().includes('timeout'))
    ) {
      return deterministicGoFallback(params, 'timeout-fallback:deterministic');
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
  // 1. Try Gemini Web2API (fast, high quality, free) — PRIMARY for every
  // context, including widget:<clientId> (user order 2026-11-15).
  // NOTE — env-var name (renamed in Phase 6): GEMINI_WEB2API_URL means
  // this service's /v1 base URL here (the Go ai service,
  // http://ai:8081/v1). Inside the ai container the same backend is
  // read from GEMINI_WEB2API_PROXY_URL (the external web2api proxy
  // URL). Setting one name in the wrong place silently re-routes a tier.
  // NOTE (was: F1 Knowledge Leak Fix): the old gate skipped web2api for
  // workspace traffic, fearing cross-workspace leakage through the
  // shared session. Live probe 2026-11-15 proved the endpoint stateless
  // per request (marker "ZEBRA-9911" planted in one call was unknown to
  // the next), so a request only ever sees the messages it carries —
  // and those are built per workspace. contextKey stays in the signature
  // (callers pass it for logging / future tier routing); it no longer
  // gates Tier 1.
  {
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

