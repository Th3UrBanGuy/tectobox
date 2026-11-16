/**
 * AI router — now a re-export shim over @tectonic/ai-router (Phase 4 of
 * the modular restructure). The implementation lives in the shared
 * package; this file keeps the import path stable for the api's
 * existing importers (ai-reply.service, payment-claim.service,
 * guardrails, router.spec, widget.controller.spec). No behaviour change.
 *
 * demoResponder is a local const binding (not a re-export) on purpose:
 * the widget controller spec spies on it through this module
 * (vi.spyOn(aiRouter, 'demoResponder')), and a re-exported binding
 * would not be spied the same way.
 */
/**
 * Only demoResponder is imported (as a local const binding, not a
 * re-export, on purpose: the widget controller spec spies on it
 * through this module, and a re-exported binding would not be spied
 * the same way). Everything else is re-exported directly below.
 */
import { demoResponder as demoResponderImpl } from '@tectonic/ai-router';
import type {
  AIRequestMessage,
  KnowledgeItem,
  PaymentClaim,
  PaymentConfig,
  ProductItem,
  PromptContext,
} from '@tectonic/ai-router';

export {
  buildSystemPrompt,
  buildOutOfStockReply,
  CF_MODEL_POOL,
  DEFAULT_DELIVERY_CHARGE_BDT,
  detectCustomerLanguage,
  extractCustomerDetails,
  findInStockAlternative,
  findProduct,
  getAIResponse,
  GO_AI_TIMEOUT_MS,
  languageDirective,
  parsePaymentClaim,
  parsePaymentConfig,
  paymentLineForConfirmation,
  isActualPaymentStatement,
  queryGoAIEngine,
  resetGoAiCircuitBreaker,
  toBengaliDigits,
} from '@tectonic/ai-router';

export const demoResponder = demoResponderImpl;

export type {
  AIRequestMessage,
  KnowledgeItem,
  PaymentClaim,
  PaymentConfig,
  ProductItem,
  PromptContext,
} from '@tectonic/ai-router';
