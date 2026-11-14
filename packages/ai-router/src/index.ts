/**
 * @tectonic/ai-router — the one AI router implementation for Tectobox.
 *
 * Phase 4 of the modular restructure: the api (services/api/src/ai/)
 * and the workers (services/workers/src/ai/) each carried their own
 * copy of the ai router and the two had already drifted (the api's
 * buildSystemPrompt appended a SECURITY DIRECTIVE the workers' copy
 * lacked). Both services now import from here; their local router.ts
 * files are thin shims that keep the old import paths working.
 *
 * Kept exactly: the 60/120 BDT delivery-charge defaults (in
 * demo-responder.ts and prompts.ts) and the 127.0.0.1:8081 / 18080
 * provider fallbacks (in providers.ts). The env-var rename for
 * GEMINI_WEB2API_URL is Phase 6 — see the note in providers.ts.
 */
export * from './language.js';
export * from './prompts.js';
export * from './providers.js';
export * from './demo-responder.js';
export * from './payment-claim.js';
