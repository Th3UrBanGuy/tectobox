import {
  BROADCAST_JOB_ROUTING_KEY,
  EVENTS_EXCHANGE,
  connectQueue,
  connectRoutingKey,
  disconnectQueue,
  disconnectRoutingKey,
  signinQueue,
  signinRoutingKey,
} from '@tectonic/contracts';
import type { BrokerState } from './broker-state.js';

export interface BroadcastJobPayload {
  broadcastId: number;
  recipientId: number;
  clientId: number;
  platform: string;
  platformUserId: string;
  customerName?: string | null;
  text: string;
}

/**
 * RabbitMQ publish wrappers: broadcast jobs and channel connect /
 * sign-in / disconnect commands for the workers.
 *
 * Moved verbatim out of `EventsService` (`publishBroadcastJob`,
 * `publishChannelConnect`, `publishChannelConnectTelegram`,
 * `publishTelegramSignIn`, `publishChannelDisconnect`) — Phase 3 of the
 * modular restructure. No behaviour change: every method returns false
 * (never throws) when the broker is not connected or a publish fails,
 * so callers keep the 'connecting' row and re-tap to retry.
 */
export class ChannelCommandsService {
  constructor(private readonly state: BrokerState) {}

  /**
   * Publish one broadcast job to the broadcast.jobs queue.
   * Routing key {@link BROADCAST_JOB_ROUTING_KEY} matches the pre-declared binding
   * 'broadcast.job.#' in infra/rabbitmq/definitions.json.
   * Returns false when the broker is not connected (caller records the
   * failure on the recipient instead of silently dropping the job).
   */
  async publishBroadcastJob(job: BroadcastJobPayload): Promise<boolean> {
    if (!this.state.isConnected || !this.state.mq) {
      console.warn('[events] RabbitMQ not connected, cannot publish broadcast job');
      return false;
    }
    try {
      await this.state.mq.publish(BROADCAST_JOB_ROUTING_KEY, job);
      return true;
    } catch (err: any) {
      console.warn('[events] Failed to publish broadcast job:', err.message);
      return false;
    }
  }

  /**
   * RC5: ask the WhatsApp worker to start a Baileys session for this
   * client/slot. The worker emits the QR (or reconnects the saved pairing
   * silently). The queue is asserted here so a connect issued while the
   * worker is restarting is durably queued instead of unroutable.
   * Returns false when the broker is not connected (caller keeps the
   * 'connecting' row; re-tapping Connect retries).
   * opts.method 'phone' + opts.phoneNumber asks for a pairing code instead
   * of a QR: the worker calls requestPairingCode and publishes the code
   * back over SSE (type 'pairing_code') and Redis (wa:pairing:...).
   */
  async publishChannelConnect(
    clientId: number,
    slot: string,
    opts?: { method?: string; phoneNumber?: string }
  ): Promise<boolean> {
    if (!this.state.isConnected || !this.state.mq) {
      console.warn('[events] RabbitMQ not connected, cannot publish WhatsApp connect command');
      return false;
    }
    try {
      const channel = this.state.mq.getChannel();
      const queue = connectQueue('whatsapp');
      const routingKey = connectRoutingKey('whatsapp');
      if (channel) {
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
      }
      await this.state.mq.publish(routingKey, {
        clientId,
        slot,
        method: opts?.method || 'qr',
        phoneNumber: opts?.phoneNumber || undefined,
      });
      return true;
    } catch (err: any) {
      console.warn('[events] Failed to publish WhatsApp connect command:', err.message);
      return false;
    }
  }

  /**
   * Telegram connect trigger (channel.connect.telegram).
   * Durable routing key carrying clientId, slot, channel row id, and label.
   * opts.method 'phone' + opts.phoneNumber sends a Telegram login code to
   * that number instead of starting the QR flow (worker publishes
   * 'tg_code_sent' when the code is on its way).
   */
  async publishChannelConnectTelegram(
    clientId: number,
    slot: string,
    channelRowId?: number,
    label?: string,
    opts?: { method?: string; phoneNumber?: string }
  ): Promise<boolean> {
    if (!this.state.isConnected || !this.state.mq) {
      console.warn('[events] RabbitMQ not connected, cannot publish Telegram connect command');
      return false;
    }
    try {
      const channel = this.state.mq.getChannel();
      const queue = connectQueue('telegram');
      const routingKey = connectRoutingKey('telegram');
      if (channel) {
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
      }
      await this.state.mq.publish(routingKey, {
        clientId,
        slot,
        channelRowId,
        id: channelRowId,
        label,
        method: opts?.method || 'qr',
        phoneNumber: opts?.phoneNumber || undefined,
      });
      return true;
    } catch (err: any) {
      console.warn('[events] Failed to publish Telegram connect command:', err.message);
      return false;
    }
  }

  /**
   * Telegram phone-code sign-in (channel.signin.telegram). The user typed
   * the code Telegram sent to their phone; the worker finishes signInUser
   * (and signInUserWithPassword when the account has 2FA) and publishes
   * 'connected' only on real success. A wrong/expired code comes back as
   * an SSE 'tg_code_error' so the modal can offer a retry.
   */
  async publishTelegramSignIn(
    clientId: number,
    slot: string,
    code: string,
    password?: string
  ): Promise<boolean> {
    if (!this.state.isConnected || !this.state.mq) {
      console.warn('[events] RabbitMQ not connected, cannot publish Telegram sign-in');
      return false;
    }
    try {
      const channel = this.state.mq.getChannel();
      const queue = signinQueue('telegram');
      const routingKey = signinRoutingKey('telegram');
      if (channel) {
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
      }
      await this.state.mq.publish(routingKey, {
        clientId,
        slot,
        phoneCode: code,
        password: password || undefined,
      });
      return true;
    } catch (err: any) {
      console.warn('[events] Failed to publish Telegram sign-in:', err.message);
      return false;
    }
  }

  /**
   * Disconnect command (channel.disconnect.<channel>).
   * Tells worker to destroy live session/socket and wipe auth credentials.
   */
  async publishChannelDisconnect(
    channelName: string,
    clientId: number,
    slot: string
  ): Promise<boolean> {
    if (!this.state.isConnected || !this.state.mq) {
      console.warn(`[events] RabbitMQ not connected, cannot publish disconnect for ${channelName}`);
      return false;
    }
    try {
      const routingKey = disconnectRoutingKey(channelName);
      const channel = this.state.mq.getChannel();
      if (channel) {
        await channel.assertQueue(disconnectQueue(channelName), { durable: true });
        await channel.bindQueue(disconnectQueue(channelName), EVENTS_EXCHANGE, routingKey);
      }
      await this.state.mq.publish(routingKey, {
        clientId,
        channel: channelName,
        slot,
      });
      return true;
    } catch (err: any) {
      console.warn(`[events] Failed to publish disconnect for ${channelName}:`, err.message);
      return false;
    }
  }
}
