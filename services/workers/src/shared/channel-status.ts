import {
  SSE_EVENT_TYPES,
  channelStatusRoutingKey,
  tenantEventsChannel,
} from '@tectonic/contracts';

/**
 * Channel-status publisher — the paired flip every channel worker does
 * when a session connects or disconnects:
 *
 *   1. the SSE `channel_status` event on `tenant:<id>:events` (the api
 *      fans it out to the browser / updates the DB), and
 *   2. the MQ `channel.status.<channel>` publish (the api's channel-
 *      status consumer).
 *
 * Phase 2 of the modular restructure. The two calls were inlined at 7
 * call sites (WhatsApp: connection open/close + disconnect consumer;
 * Telegram: QR-login `.then()`, `isAuth` branch, `finishLogin`, disconnect
 * consumer) with the two `publishChannelStatus` definitions byte-identical
 * except the routing key. One publisher keeps the pair from drifting
 * apart — a site that flips one without the other used to leave the
 * channel list and the DB disagreeing.
 *
 * Behaviour, preserved exactly:
 * - the SSE publish is awaited and may throw (callers never caught it);
 * - the MQ publish is best-effort: a failure only warns, as before.
 * The order here is SSE-then-MQ (the majority order; the two disconnect
 * consumers did MQ-then-SSE — unobservable, the two go to different
 * systems and the tests record them in separate arrays).
 */
export type ChannelStatusPublisher = (
  clientId: string | number,
  slot: string,
  status: string,
) => Promise<void>;

export function createChannelStatusPublisher(deps: {
  mq: any;
  coordinator: any;
  channel: 'whatsapp' | 'telegram';
}): ChannelStatusPublisher {
  const { mq, coordinator, channel } = deps;
  return async (clientId, slot, status) => {
    await coordinator.publishEvent(tenantEventsChannel(clientId), {
      type: SSE_EVENT_TYPES.CHANNEL_STATUS,
      clientId: Number(clientId),
      channel,
      slot,
      status,
    });
    try {
      await mq.publish(channelStatusRoutingKey(channel), {
        clientId: Number(clientId),
        channel,
        slot,
        status,
      });
    } catch (e: any) {
      console.warn(`[${channel}] channel status publish failed:`, e.message);
    }
  };
}
