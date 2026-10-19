// Speech-to-text for inbound voice notes (WhatsApp PTT, Telegram voice).
//
// Pipeline: audio bytes -> STT provider -> text. The transcription is then fed
// into the normal text pipeline, so ANY AI model (Claude via OmniRoute, Gemini,
// etc.) can "understand" voice without the model itself needing audio input.
//
// Two providers, with automatic fallback:
//   1. cloudflare — Workers AI @cf/openai/whisper (CLOUDFLARE_AI_API_KEY +
//      CLOUDFLARE_ACCOUNT_ID in tectonic-inbox/.env). Free tier.
//   2. groq — whisper-large-v3-turbo via the user-connected custom.groq vault
//      credential (surrogate auth through bin/groq-stt; key never on disk).
//      Free tier: 2,000 req/day.
//
// Config (tectonic-inbox/.env):
//   STT_PRIMARY=cloudflare|groq   provider tried first (default cloudflare)
//   VOICE_STT_ENABLED=0           kill switch (default: enabled when a provider is usable)
//   CF_STT_MODEL                 override model (default @cf/openai/whisper)
//   VOICE_MAX_BYTES              max audio accepted (default 20MB)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_MODEL = '@cf/openai/whisper';
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 90000;
const GROQ_CLI = path.join(os.homedir(), 'workspace', 'skills', 'groq', 'bin', 'groq-stt');
// Default prompt biases whisper toward Bengali (see bin/groq-stt). Override
// with STT_PROMPT=... or clear with STT_PROMPT= (empty = no prompt).
const DEFAULT_PROMPT = 'এটি একটি বাংলা ভয়েস মেসেজ। বাংলায় ট্রান্সক্রাইব করো।';

function cloudflareConfig() {
  const token = process.env.CLOUDFLARE_AI_API_KEY || '';
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  return {
    available: Boolean(token && account),
    token,
    account,
    model: process.env.CF_STT_MODEL || DEFAULT_MODEL,
  };
}

function sttConfig() {
  const maxBytes = parseInt(process.env.VOICE_MAX_BYTES || String(DEFAULT_MAX_BYTES), 10) || DEFAULT_MAX_BYTES;
  const primary = (process.env.STT_PRIMARY || 'cloudflare').toLowerCase() === 'groq' ? 'groq' : 'cloudflare';
  const enabled = process.env.VOICE_STT_ENABLED !== '0';
  return { enabled, primary, maxBytes };
}

function proxyDispatcher() {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!proxyUrl) return undefined;
  try {
    // undici's own ProxyAgent implements the Dispatcher interface that the
    // global fetch() expects. (https-proxy-agent is NOT a valid dispatcher.)
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

// Transcribe raw audio bytes -> text, trying providers in order with automatic
// fallback (primary first, then the other). Returns null when transcription
// yields nothing usable. Throws only when every provider fails, so callers can
// log + skip the voice note.
async function transcribeVoice(buffer, { source = 'unknown' } = {}) {
  const cfg = sttConfig();
  if (!cfg.enabled) throw new Error('voice STT disabled (VOICE_STT_ENABLED=0)');
  if (!buffer || !buffer.length) throw new Error('empty audio buffer');
  if (buffer.length > cfg.maxBytes) {
    throw new Error(`audio too large (${(buffer.length / 1048576).toFixed(1)}MB > ${(cfg.maxBytes / 1048576).toFixed(0)}MB)`);
  }
  const order = cfg.primary === 'groq' ? ['groq', 'cloudflare'] : ['cloudflare', 'groq'];
  const errors = [];
  for (const provider of order) {
    try {
      const text = provider === 'groq'
        ? await transcribeGroq(buffer, source)
        : await transcribeCloudflare(buffer, source);
      if (text) return text;
      errors.push(`${provider}: empty transcription`);
    } catch (e) {
      errors.push(`${provider}: ${e.message}`);
      console.error(`[stt] ${provider} failed (${source}), trying fallback: ${e.message}`);
    }
  }
  throw new Error(`all STT providers failed (${source}): ${errors.join(' | ')}`);
}

async function transcribeCloudflare(buffer, source) {
  const cf = cloudflareConfig();
  if (!cf.available) throw new Error('cloudflare STT not configured (missing key/account)');
  // NOTE: the model id (@cf/openai/whisper) must NOT be URL-encoded — the
  // slashes and @ are literal path segments of the Workers AI route.
  const url = `https://api.cloudflare.com/client/v4/accounts/${cf.account}/ai/run/${cf.model}`;
  const dispatcher = proxyDispatcher();
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cf.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`STT request failed: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`STT HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => null);
  const text = data && data.result && typeof data.result.text === 'string'
    ? data.result.text.trim()
    : (typeof data?.result === 'string' ? data.result.trim() : '');
  console.log(`[stt] cloudflare ${source}: transcribed ${(buffer.length / 1024).toFixed(0)}KB in ${Date.now() - started}ms -> ${text ? text.slice(0, 60) : '(empty)'}`);
  return text || null;
}

// Groq path goes through the vault-backed CLI (surrogate auth — the key never
// touches disk or env). Throws when the custom.groq credential isn't connected.
function transcribeGroq(buffer, source) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(GROQ_CLI)) return reject(new Error('groq-stt CLI not installed'));
    const tmp = path.join(os.tmpdir(), `voice-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`);
    fs.writeFileSync(tmp, buffer);
    const started = Date.now();
    const args = [tmp];
    const prompt = process.env.STT_PROMPT !== undefined ? process.env.STT_PROMPT : DEFAULT_PROMPT;
    if (prompt) args.push('--prompt', prompt);
    execFile(GROQ_CLI, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      fs.rm(tmp, { force: true }, () => {});
      if (err) {
        const msg = String(stderr || err.message).trim().split('\n').pop();
        return reject(new Error(`groq-stt failed: ${msg || err.message}`.slice(0, 300)));
      }
      const text = String(stdout || '').trim();
      console.log(`[stt] groq ${source}: transcribed ${(buffer.length / 1024).toFixed(0)}KB in ${Date.now() - started}ms -> ${text ? text.slice(0, 60) : '(empty)'}`);
      resolve(text || null);
    });
  });
}

module.exports = { transcribeVoice, sttConfig, transcribeCloudflare, transcribeGroq };
