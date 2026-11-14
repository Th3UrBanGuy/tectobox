/**
 * Prompt building — split from ai/router.ts in Phase 2 of the modular
 * restructure. Code moved verbatim; no behaviour change.
 */

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

