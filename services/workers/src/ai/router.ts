/**
 * AI router — now a re-export barrel only (Phase 2 of the modular
 * restructure). The implementation moved verbatim into:
 *
 *   ./language.ts       — BN_WORDS + detectCustomerLanguage + languageDirective
 *   ./prompts.ts        — types + buildSystemPrompt
 *   ./providers.ts      — CF_MODEL_POOL + callOpenAICompatible +
 *                         queryGoAIEngine + getAIResponse + cleanModelOutput
 *   ./demo-responder.ts — demoResponder (deterministic template fallback)
 *
 * `ai/worker.ts` and `ai/router.spec.ts` keep importing from './router.ts'
 * unchanged. No behaviour change.
 */
export {
  buildSystemPrompt,
} from './prompts.ts';
export type {
  AIRequestMessage,
  ProductItem,
  KnowledgeItem,
  PromptContext,
} from './prompts.ts';
export { detectCustomerLanguage, languageDirective } from './language.ts';
export {
  CF_MODEL_POOL,
  GO_AI_TIMEOUT_MS,
  queryGoAIEngine,
  getAIResponse,
} from './providers.ts';
export { demoResponder } from './demo-responder.ts';
