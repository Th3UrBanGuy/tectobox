import { z } from 'zod';

// Shared
export const PlatformSchema = z.enum(['meta', 'telegram', 'whatsapp', 'webchat']);

// Inbound Message Event
export const InboundMessageEventSchema = z.object({
  eventId: z.string().uuid(),
  clientId: z.number(),
  platform: PlatformSchema,
  platformUserId: z.string(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  text: z.string(),
  externalId: z.string().optional(),
  timestamp: z.string().datetime(),
  rawJson: z.any().optional(),
});
export type InboundMessageEvent = z.infer<typeof InboundMessageEventSchema>;

// Outbound Message Event
export const OutboundMessageEventSchema = z.object({
  eventId: z.string().uuid(),
  clientId: z.number(),
  conversationId: z.number(),
  platform: PlatformSchema,
  platformUserId: z.string(),
  text: z.string(),
  timestamp: z.string().datetime(),
  idempotencyKey: z.string().optional(),
});
export type OutboundMessageEvent = z.infer<typeof OutboundMessageEventSchema>;

// AI Generation Request
export const AIGenerationRequestSchema = z.object({
  requestId: z.string().uuid(),
  clientId: z.number(),
  conversationId: z.number(),
  context: z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    })),
    knowledge: z.array(z.string()),
    leadInfo: z.any().optional(),
  }),
});
export type AIGenerationRequest = z.infer<typeof AIGenerationRequestSchema>;

// AI Generation Response
export const AIGenerationResponseSchema = z.object({
  requestId: z.string().uuid(),
  clientId: z.number(),
  conversationId: z.number(),
  replyText: z.string(),
  needsHuman: z.boolean().default(false),
  intentSummary: z.string().optional(),
  generatedAt: z.string().datetime(),
});
export type AIGenerationResponse = z.infer<typeof AIGenerationResponseSchema>;

// Broadcast Job & Status Events
export const BroadcastJobEventSchema = z.object({
  jobId: z.string().uuid(),
  clientId: z.number(),
  broadcastId: z.number(),
  platform: PlatformSchema,
  platformUserId: z.string(),
  text: z.string(),
});
export type BroadcastJobEvent = z.infer<typeof BroadcastJobEventSchema>;

export const BroadcastStatusEventSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(['sent', 'failed']),
  error: z.string().optional(),
  timestamp: z.string().datetime(),
});
export type BroadcastStatusEvent = z.infer<typeof BroadcastStatusEventSchema>;
