import { Injectable, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { RabbitMQClient } from '@tectonic/messaging';
import { LicensingService } from '../licensing/licensing.service.js';
import { BrokerState } from './broker-state.js';
import { BrokerConnectionService } from './broker-connection.service.js';
import { SsePublisherService } from './sse-publisher.service.js';
import { AuditService } from './audit.service.js';
import { ChannelCacheService } from './channel-cache.service.js';
import { ChannelCommandsService } from './channel-commands.service.js';
import { OutboxService } from './outbox.service.js';
import { InboundIntakeService } from './inbound-intake.service.js';
import { ChannelStatusConsumer } from './channel-status.consumer.js';

export type { OutboundPayload } from './outbox.service.js';
export type { BroadcastJobPayload } from './channel-commands.service.js';
import type { OutboundPayload } from './outbox.service.js';
import type { BroadcastJobPayload } from './channel-commands.service.js';

/**
 * Events facade (Phase 3 of the modular restructure).
 *
 * `EventsService` used to be a 791-line god-object: SSE fan-out, audit
 * log, Redis QR/pairing cache, RabbitMQ publish/consume, reconnect
 * logic, outbox polling, inbound-message intake, and AI-gate logic in
 * one class, injected by 9 controllers/services. It is now a thin
 * facade: every method delegates to one focused service under
 * `events/` (broker-connection, sse-publisher, audit, channel-cache,
 * channel-commands, outbox, inbound-intake, channel-status). The
 * constructor signature `(pool, licensing)` and the full public method
 * surface are unchanged, so every existing consumer — and every spec
 * that constructs `EventsService` directly — keeps working untouched.
 *
 * The collaborators are composed internally (not Nest-injected) on
 * purpose: `AdminController` / `AuthController` / `LicensingController`
 * / `BackupController` all build a fallback `new EventsService(pool,
 * licensing)` when DI has no instance, and the specs construct it
 * directly too. Changing the constructor would break all of those.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly state = new BrokerState();
  private readonly broker: BrokerConnectionService;
  private readonly ssePublisher: SsePublisherService;
  private readonly audit: AuditService;
  private readonly channelCache: ChannelCacheService;
  private readonly channelCommands: ChannelCommandsService;
  private readonly outbox: OutboxService;
  private readonly intake: InboundIntakeService;
  private readonly channelStatus: ChannelStatusConsumer;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(LicensingService) private readonly licensing: LicensingService
  ) {
    this.broker = new BrokerConnectionService(this.state, {
      onReconnected: async () => {
        await this.intake.startInboundConsumer();
        await this.channelStatus.startChannelStatusConsumer();
      },
    });
    this.ssePublisher = new SsePublisherService(this.state);
    this.audit = new AuditService(pool);
    this.channelCache = new ChannelCacheService(this.state);
    this.channelCommands = new ChannelCommandsService(this.state);
    this.outbox = new OutboxService(pool, this.state);
    const broadcast = (tenantId: number, event: any) =>
      this.ssePublisher.broadcastTenantEvent(tenantId, event);
    this.intake = new InboundIntakeService(pool, licensing, this.state, broadcast);
    this.channelStatus = new ChannelStatusConsumer(pool, this.state, broadcast);
  }

  getMqClient(): RabbitMQClient | null {
    return this.broker.getMqClient();
  }

  setMqClient(mq: any) {
    this.broker.setMqClient(mq);
  }

  getIsConnected(): boolean {
    return this.broker.getIsConnected();
  }

  setIsConnected(connected: boolean) {
    this.broker.setIsConnected(connected);
  }

  attachConnectionLifecycle() {
    this.broker.attachConnectionLifecycle();
  }

  async triggerReconnect(): Promise<void> {
    return this.broker.triggerReconnect();
  }

  async onModuleInit() {
    this.broker.initializeRedis();
    await this.broker.connectWithRetry(async () => {
      await this.intake.startInboundConsumer();
      await this.channelStatus.startChannelStatusConsumer();
      this.outbox.startOutboxPolling();
    });
  }

  async onModuleDestroy() {
    this.state.isClosing = true;
    this.outbox.stopOutboxPolling();
    if (this.state.reconnectTimer) {
      clearTimeout(this.state.reconnectTimer);
      this.state.reconnectTimer = null;
    }
    await this.broker.close();
  }

  /**
   * Broadcast real-time SSE event to a tenant workspace via Redis Pub/Sub
   */
  async broadcastTenantEvent(tenantId: number, event: any): Promise<void> {
    return this.ssePublisher.broadcastTenantEvent(tenantId, event);
  }

  /**
   * M2: Fail-open audit log write helper.
   * Inserts an event into `audit_log` without throwing on error or crashing the caller.
   */
  async writeAudit(
    actorId: string | number | null,
    clientId: number | null,
    action: string,
    details?: any
  ): Promise<void> {
    return this.audit.writeAudit(actorId, clientId, action, details);
  }

  async getQrCode(clientId: number, slot: string, channel: string = 'whatsapp'): Promise<string | null> {
    return this.channelCache.getQrCode(clientId, slot, channel);
  }

  /** WhatsApp pairing code issued by requestPairingCode (phone login). */
  async getPairingCode(clientId: number, slot: string): Promise<string | null> {
    return this.channelCache.getPairingCode(clientId, slot);
  }

  /** True while a Telegram phone-code login is waiting for the user to type the code. */
  async getPhoneCodeSent(clientId: number, slot: string): Promise<boolean> {
    return this.channelCache.getPhoneCodeSent(clientId, slot);
  }

  async setRedisKey(key: string, val: string, ttlSec?: number): Promise<void> {
    return this.channelCache.setRedisKey(key, val, ttlSec);
  }

  async getRedisKey(key: string): Promise<string | null> {
    return this.channelCache.getRedisKey(key);
  }

  /**
   * Publish one broadcast job to the broadcast.jobs queue.
   * Routing key {@link BROADCAST_JOB_ROUTING_KEY} matches the pre-declared binding
   * 'broadcast.job.#' in infra/rabbitmq/definitions.json.
   * Returns false when the broker is not connected (caller records the
   * failure on the recipient instead of silently dropping the job).
   */
  async publishBroadcastJob(job: BroadcastJobPayload): Promise<boolean> {
    return this.channelCommands.publishBroadcastJob(job);
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
    return this.channelCommands.publishChannelConnect(clientId, slot, opts);
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
    return this.channelCommands.publishChannelConnectTelegram(clientId, slot, channelRowId, label, opts);
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
    return this.channelCommands.publishTelegramSignIn(clientId, slot, code, password);
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
    return this.channelCommands.publishChannelDisconnect(channelName, clientId, slot);
  }

  /**
   * Publish an outbound message directly to RabbitMQ & outbox
   */
  async enqueueOutboundMessage(payload: OutboundPayload): Promise<void> {
    return this.outbox.enqueueOutboundMessage(payload);
  }
}
