/**
 * AI router — now a re-export shim over @tectonic/ai-router (Phase 4 of
 * the modular restructure). The implementation moved into the shared
 * package; the workers' local split files (language.ts, prompts.ts,
 * providers.ts, demo-responder.ts) are deleted. `ai/worker.ts`,
 * `ai/router.spec.ts`, and `ai/worker.spec.ts` keep importing from
 * './router.ts' unchanged. No behaviour change.
 */
export {
  buildSystemPrompt,
  CF_MODEL_POOL,
  GO_AI_TIMEOUT_MS,
  queryGoAIEngine,
  getAIResponse,
  demoResponder,
  detectCustomerLanguage,
  languageDirective,
} from '@tectonic/ai-router';
export type {
  AIRequestMessage,
  ProductItem,
  KnowledgeItem,
  PromptContext,
} from '@tectonic/ai-router';
