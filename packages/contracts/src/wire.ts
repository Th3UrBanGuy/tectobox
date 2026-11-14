/**
 * Wire schemas — validators for the messages as they ACTUALLY travel
 * between services today, used at the consumer boundaries.
 *
 * These are deliberately NOT the canonical schemas in events.ts. The
 * canonical schemas describe the contract producers SHOULD converge to
 * (e.g. InboundMessageEventSchema requires a UUID eventId and an ISO
 * timestamp; OutboundMessageEventSchema carries platformUserId and a
 * conversationId). The real wire differs:
 *
 *   - The WhatsApp worker publishes inbound as {clientId, slot, message}
 *     (no platform / platformUserId / text) — the api consumer drops it.
 *   - Outbound publishes carry `to` instead of platformUserId and no
 *     eventId / timestamp / conversationId.
 *   - AI requests carry history / products / knowledge the canonical
 *     AIGenerationRequestSchema does not describe.
 *   - Broadcast jobs carry recipientId and no jobId UUID.
 *
 * Wiring a canonical schema verbatim at those boundaries would DROP live
 * traffic. So each wire schema below reproduces, field by field, the
 * acceptance rule its consumer already applies — the same Number() /
 * String() coercions and the same truthiness gates — and nothing more:
 * a message the current code accepts still passes, a message it drops
 * still fails (now via safeParse instead of inline ifs). Non-gate fields
 * are preserved verbatim (.passthrough() + z.any()) so the consumer's
 * own fallback logic (slot || 'default', String(phoneCode), Array.isArray
 * checks) keeps working exactly as before.
 *
 * Documented narrowings (inputs no real producer sends):
 *   - `to` / `text` / `platform` / `sessionString` must be strings after
 *     the truthiness coercion. A numeric value would have passed the old
 *     truthiness check and failed later at the provider; it is now
 *     dropped at the consumer instead. End state is the same (not
 *     delivered, DLQ'd).
 *   - `eventId` / `timestamp` on inbound must be strings when present.
 *     The consumer never reads them; Go ingress always sends strings.
 */

import { z } from 'zod';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/**
 * Reproduces a consumer's truthiness gate for a string field: falsy
 * values become '' (which then fails min(1)), anything else becomes its
 * decimal string — exactly what `String(payload.x || '')` does.
 */
const truthyString = (v: unknown): string => (v ? String(v) : '');

/** A broker id that must survive Number() and be non-zero (z.number() already rejects NaN). */
const nonzeroId = z.number().refine((n) => n !== 0);

// ---------------------------------------------------------------------------
// Inbound — api startInboundConsumer (services/api/src/events/events.service.ts)
// ---------------------------------------------------------------------------

/**
 * Reproduces the consumer's coercion block verbatim:
 *   clientId = Number(payload.clientId)
 *   platform = String(payload.platform || 'whatsapp')
 *   platformUserId = String(payload.platformUserId || payload.from || '')
 *   text = String(payload.text || '').trim()
 *   customerName / customerPhone / externalId = payload.x || null
 * eventId / timestamp are never read by the consumer (Go ingress always
 * sends them); rawJson is stored as-is.
 */
const coerceInboundWireMessage = (raw: unknown) => {
  if (!isRecord(raw)) return raw;
  return {
    ...raw,
    clientId: Number(raw.clientId),
    platform: String(raw.platform || 'whatsapp'),
    platformUserId: String(raw.platformUserId || raw.from || ''),
    text: String(raw.text || '').trim(),
    customerName: raw.customerName ? String(raw.customerName) : null,
    customerPhone: raw.customerPhone ? String(raw.customerPhone) : null,
    externalId: raw.externalId ? String(raw.externalId) : null,
  };
};

export const InboundWireMessageSchema = z.preprocess(
  coerceInboundWireMessage,
  z
    .object({
      clientId: nonzeroId,
      platform: z.string(),
      platformUserId: z.string().min(1),
      text: z.string().min(1),
      customerName: z.string().nullable().optional(),
      customerPhone: z.string().nullable().optional(),
      externalId: z.string().nullable().optional(),
      eventId: z.string().optional(),
      timestamp: z.string().optional(),
      rawJson: z.any().optional(),
    })
    .passthrough(),
);
export type InboundWireMessage = z.infer<typeof InboundWireMessageSchema>;

// ---------------------------------------------------------------------------
// Channel status — api startChannelStatusConsumer
// ---------------------------------------------------------------------------

/**
 * Reproduces the consumer: clientId = Number(...), channel/slot/status
 * via String(x || default), drop unless status is one of the four.
 */
const coerceChannelStatus = (raw: unknown) => {
  if (!isRecord(raw)) return raw;
  return {
    ...raw,
    clientId: Number(raw.clientId),
    channel: String(raw.channel || 'whatsapp'),
    slot: String(raw.slot || 'default'),
    status: String(raw.status || ''),
  };
};

export const ChannelStatusEventSchema = z.preprocess(
  coerceChannelStatus,
  z
    .object({
      clientId: nonzeroId,
      channel: z.string(),
      slot: z.string(),
      status: z.enum(['connected', 'disconnected', 'connecting', 'error']),
    })
    .passthrough(),
);
export type ChannelStatusEvent = z.infer<typeof ChannelStatusEventSchema>;

// ---------------------------------------------------------------------------
// Outbound — whatsapp / telegram / meta channel workers
// ---------------------------------------------------------------------------

const coerceOutboundWireMessage = (raw: unknown) => {
  if (!isRecord(raw)) return raw;
  return {
    ...raw,
    clientId: Number(raw.clientId),
    to: truthyString(raw.to),
    text: truthyString(raw.text),
  };
};

/**
 * Gate fields only; everything the consumer reads but does not gate on
 * (slot, platform, attempt, idempotencyKey, conversationId) is declared
 * loosely so the consumer's own `|| 'default'` / Number(...) logic keeps
 * applying to the raw value.
 */
const OutboundWireMessageObjectSchema = z
  .object({
    clientId: nonzeroId,
    to: z.string().min(1),
    text: z.string().min(1),
    slot: z.any().optional(),
    platform: z.any().optional(),
    attempt: z.any().optional(),
    idempotencyKey: z.any().optional(),
    conversationId: z.any().optional(),
  })
  .passthrough();

export const OutboundWireMessageSchema = z.preprocess(
  coerceOutboundWireMessage,
  OutboundWireMessageObjectSchema,
);
export type OutboundWireMessage = z.infer<typeof OutboundWireMessageSchema>;

/**
 * Telegram additionally requires a session string (the api never sends
 * one — broadcast extracts it from channel_sessions.session_json; AI
 * replies to Telegram therefore DLQ today, unchanged by this schema).
 */
export const TelegramOutboundWireMessageSchema = z.preprocess(
  (raw: unknown) => {
    const coerced = coerceOutboundWireMessage(raw);
    if (!isRecord(coerced)) return coerced;
    return { ...coerced, sessionString: truthyString(coerced.sessionString) };
  },
  OutboundWireMessageObjectSchema.extend({
    sessionString: z.string().min(1),
  }),
);
export type TelegramOutboundWireMessage = z.infer<
  typeof TelegramOutboundWireMessageSchema
>;

// ---------------------------------------------------------------------------
// AI request — ai worker (services/workers/src/ai/worker.ts)
// ---------------------------------------------------------------------------

/**
 * Gate: platform / clientId / to / text must be present. The consumer
 * normalises unknown platforms to 'whatsapp' AFTER the gate, and coerces
 * history entries itself — so history / products / knowledge are passed
 * through unvalidated, exactly as today.
 */
export const AiRequestWireMessageSchema = z.preprocess(
  (raw: unknown) => {
    if (!isRecord(raw)) return raw;
    return {
      ...raw,
      clientId: Number(raw.clientId),
      platform: truthyString(raw.platform),
      to: truthyString(raw.to),
      text: truthyString(raw.text),
    };
  },
  z
    .object({
      platform: z.string().min(1),
      clientId: nonzeroId,
      to: z.string().min(1),
      text: z.string().min(1),
      slot: z.any().optional(),
      conversationId: z.any().optional(),
      systemPrompt: z.any().optional(),
      clientName: z.any().optional(),
      businessType: z.any().optional(),
      history: z.any().optional(),
      products: z.any().optional(),
      knowledge: z.any().optional(),
    })
    .passthrough(),
);
export type AiRequestWireMessage = z.infer<typeof AiRequestWireMessageSchema>;

// ---------------------------------------------------------------------------
// Broadcast job — broadcast worker (services/workers/src/broadcast/worker.ts)
// ---------------------------------------------------------------------------

/**
 * Gate: broadcastId / recipientId / clientId / platform / platformUserId /
 * text must be present. Matches the BroadcastJob the api publishes
 * (which has no jobId — the canonical BroadcastJobEventSchema does).
 */
export const BroadcastJobWireMessageSchema = z.preprocess(
  (raw: unknown) => {
    if (!isRecord(raw)) return raw;
    return {
      ...raw,
      broadcastId: Number(raw.broadcastId),
      recipientId: Number(raw.recipientId),
      clientId: Number(raw.clientId),
      platform: truthyString(raw.platform),
      platformUserId: truthyString(raw.platformUserId),
      text: truthyString(raw.text),
    };
  },
  z
    .object({
      broadcastId: nonzeroId,
      recipientId: nonzeroId,
      clientId: nonzeroId,
      platform: z.string().min(1),
      platformUserId: z.string().min(1),
      text: z.string().min(1),
      customerName: z.any().optional(),
    })
    .passthrough(),
);
export type BroadcastJobWireMessage = z.infer<
  typeof BroadcastJobWireMessageSchema
>;

// ---------------------------------------------------------------------------
// Channel commands — connect / disconnect consumers (all workers)
// ---------------------------------------------------------------------------

/**
 * Connect (whatsapp/telegram) and disconnect (whatsapp/telegram) commands
 * gate on clientId only. Everything else (slot, method, phoneNumber,
 * channelRowId, id, label, channel) is carried through for the consumer.
 */
export const ChannelCommandWireMessageSchema = z.preprocess(
  (raw: unknown) => {
    if (!isRecord(raw)) return raw;
    return { ...raw, clientId: Number(raw.clientId) };
  },
  z
    .object({
      clientId: nonzeroId,
      slot: z.any().optional(),
      method: z.any().optional(),
      phoneNumber: z.any().optional(),
      channelRowId: z.any().optional(),
      id: z.any().optional(),
      label: z.any().optional(),
      channel: z.any().optional(),
    })
    .passthrough(),
);
export type ChannelCommandWireMessage = z.infer<
  typeof ChannelCommandWireMessageSchema
>;

/**
 * Telegram sign-in (channel.signin.telegram) gates on clientId AND
 * phoneCode. The consumer does String(phoneCode) itself at signInUser,
 * so the coercion here is faithful, not a narrowing.
 */
export const TelegramSigninWireMessageSchema = z.preprocess(
  (raw: unknown) => {
    if (!isRecord(raw)) return raw;
    return {
      ...raw,
      clientId: Number(raw.clientId),
      phoneCode: truthyString(raw.phoneCode),
    };
  },
  z
    .object({
      clientId: nonzeroId,
      phoneCode: z.string().min(1),
      slot: z.any().optional(),
      password: z.any().optional(),
    })
    .passthrough(),
);
export type TelegramSigninWireMessage = z.infer<
  typeof TelegramSigninWireMessageSchema
>;
