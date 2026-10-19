import { z } from 'zod';
import { PlatformSchema } from './events.js';

// Common responses
export const SuccessResponseSchema = z.object({ success: z.boolean() });
export const ErrorResponseSchema = z.object({ error: z.string() });

// Conversations
export const ConversationSchema = z.object({
  id: z.number(),
  clientId: z.number(),
  platform: PlatformSchema,
  platformUserId: z.string(),
  customerName: z.string().nullable().optional(),
  customerPhone: z.string().nullable().optional(),
  lastMessageAt: z.string(),
  unreadCount: z.number(),
  status: z.string(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

// Messages
export const MessageSchema = z.object({
  id: z.number(),
  conversationId: z.number(),
  direction: z.enum(['in', 'out']),
  text: z.string(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

// Catalog (Products)
export const ProductSchema = z.object({
  id: z.number(),
  clientId: z.number(),
  sku: z.string(),
  name: z.string(),
  category: z.string().nullable().optional(),
  priceBdt: z.number(),
  stock: z.number(),
  imageUrl: z.string().nullable().optional(),
});
export type Product = z.infer<typeof ProductSchema>;

// Leads
export const LeadSchema = z.object({
  id: z.number(),
  clientId: z.number(),
  platform: PlatformSchema,
  platformUserId: z.string(),
  name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  status: z.string(),
  stage: z.string().optional(),
  score: z.number().optional(),
  createdAt: z.string(),
});
export type Lead = z.infer<typeof LeadSchema>;

// Licensing / Plans
export const LicenseSchema = z.object({
  id: z.number(),
  clientId: z.number(),
  code: z.string(),
  planId: z.number().nullable(),
  status: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable().optional(),
  creditsTotal: z.number(),
  creditsUsed: z.number(),
});
export type License = z.infer<typeof LicenseSchema>;
