/**
 * Tectobox topology — the single source of truth for every name the
 * services agree on over the wire: RabbitMQ exchanges / routing keys /
 * queues, Redis keys, and SSE event types.
 *
 * Phase 1 of the modular restructure. The TypeScript services import
 * these builders instead of repeating string literals; the values are
 * unchanged, so nothing on the wire moves.
 *
 * Mapping table — where each name also lives today (do NOT change those
 * in this phase; they are listed here so a rename can be audited):
 *
 *   Exchange 'tectobox.events' (topic)
 *     - infra/rabbitmq/definitions.json (exchanges[0])
 *     - services/ingress/internal/publisher/rabbitmq.go (assert + publish)
 *     - services/api + services/workers RabbitMQClient configs
 *   Exchange 'tectobox.dlx' / 'tectobox.retry' (direct)
 *     - infra/rabbitmq/definitions.json (exchanges[1..2])
 *     - packages/messaging setupRetryTopology defaults (Phase 6 owns that file)
 *   Routing key 'message.incoming.<platform>' (meta, telegram, whatsapp)
 *     - services/ingress/internal/handler/meta.go, telegram.go (publish)
 *     - services/workers/src/whatsapp/worker.ts (publish)
 *     - bound to queue 'incoming.messages' in definitions.json (legacy
 *       generic queue; no code consumes it — the api consumes
 *       'tectobox.inbound.messages' bound to 'message.incoming.#')
 *   Routing key 'message.outgoing.<platform>'
 *     - services/api enqueueOutboundMessage + outbox polling (publish)
 *     - services/workers ai/broadcast (publish); whatsapp/telegram/meta
 *       workers (consume their own queue of the same name)
 *     - definitions.json: queues message.outgoing.whatsapp / .telegram
 *       (+ .dlq / .retry) and the legacy 'outgoing.messages' queue bound
 *       to 'message.outgoing.#'
 *   Routing keys 'channel.connect.<channel>', 'channel.disconnect.<channel>',
 *   'channel.signin.telegram'
 *     - api publishChannelConnect* / publishTelegramSignIn /
 *       publishChannelDisconnect; workers consume. Queue name == routing
 *       key by design. NOT in definitions.json (runtime-asserted).
 *   Routing key 'channel.status.<channel>' / pattern 'channel.status.#'
 *     - workers publishChannelStatus; api startChannelStatusConsumer.
 *       Queue 'tectobox.channel.status' is runtime-asserted, NOT in
 *       definitions.json.
 *   Routing key 'ai.request.<platform>' / pattern 'ai.request.#'
 *     - api inbound consumer publishes; ai worker binds 'ai.requests'.
 *     - definitions.json: queue 'ai.requests' bound to 'ai.request.#'.
 *   Routing key 'broadcast.job.send' / pattern 'broadcast.job.#'
 *     - api publishBroadcastJob; broadcast worker setupRetryTopology.
 *     - definitions.json: queue 'broadcast.jobs' bound to 'broadcast.job.#'.
 *   DLQ routing keys are '<queue>.dlq' (see dlqRoutingKey): the one place
 *     that rule bites is broadcast — packages/messaging's
 *     setupRetryTopology defaults to '<routingKey>.dlq'
 *     ('broadcast.job.send.dlq'), which the broker rejects with 406
 *     because definitions.json declares 'broadcast.jobs.dlq'. The
 *     broadcast worker already passes the override; keep it.
 *   Redis 'wa:qr:' / 'wa:pairing:' / 'tg:qr:' / 'tg:session:' /
 *   'tg:codehash:' / 'tg:phone:' / 'tg:codesent:'
 *     - written by the whatsapp/telegram workers, read by the api
 *       (getQrCode / getPairingCode / getPhoneCodeSent).
 *   Redis 'meta:token:<clientId>:<channel>'
 *     - written by the api (connectors.controller), read by the meta worker.
 *   Redis 'meta:page:<pageId>'
 *     - written by the api (connectors.controller), read by Go ingress
 *       (services/ingress/cmd/ingress/main.go) to resolve a page to a tenant.
 *   Redis 'telegram:bot:<token>'
 *     - read by Go ingress (services/ingress/cmd/ingress/main.go) to
 *       resolve a bot token to a tenant. Written by the api alongside the
 *       bot's session (see telegramBotKey); no TS caller uses the builder
 *       yet — it exists so the Go generator has one source for the key.
 *   Redis 'lease:<sessionKey>'
 *     - fencing leases, owned by @tectonic/coordination (acquire/renew/
 *       validate). The session-key part differs per channel (see
 *       whatsappSessionKey / telegramSessionKey) — the asymmetry is
 *       reproduced exactly, including the telegram send path validating
 *       the DEFAULT-slot lease for every slot (known latent bug, Phase 2).
 *   Redis 'send_attempt:' / 'send_attempt_error:'
 *     - owned by @tectonic/coordination (claim/record/getSendState) and
 *       the meta worker (error text). TTL 86400.
 *   Redis pub/sub 'tenant:<id>:events'
 *     - api broadcastTenantEvent publishes; sse.controller subscribes.
 *       (NOT the audit-log target 'tenant:<id>' in writeAudit — a
 *       different, unrelated string; do not unify them.)
 */

// ---------------------------------------------------------------------------
// Exchanges
// ---------------------------------------------------------------------------

/** Main topic exchange: every routing key below is published here. */
export const EVENTS_EXCHANGE = 'tectobox.events';
/** Direct exchange for dead-lettered messages. */
export const DLX_EXCHANGE = 'tectobox.dlx';
/** Direct exchange for TTL-delayed retries. */
export const RETRY_EXCHANGE = 'tectobox.retry';

// ---------------------------------------------------------------------------
// Routing keys
// ---------------------------------------------------------------------------

/** Outbound message for a channel worker, e.g. 'message.outgoing.whatsapp'. */
export const outgoingRoutingKey = (platform: string): string =>
  `message.outgoing.${platform}`;

/** Inbound message from ingress / a channel worker, e.g. 'message.incoming.meta'. */
export const incomingRoutingKey = (platform: string): string =>
  `message.incoming.${platform}`;

/** Binding pattern the api inbound consumer uses: 'message.incoming.#'. */
export const INCOMING_ROUTING_KEY_PATTERN = 'message.incoming.#';

/** Connect command for a channel worker, e.g. 'channel.connect.whatsapp'. */
export const connectRoutingKey = (channel: string): string =>
  `channel.connect.${channel}`;

/** Disconnect command for a channel worker, e.g. 'channel.disconnect.telegram'. */
export const disconnectRoutingKey = (channel: string): string =>
  `channel.disconnect.${channel}`;

/** Telegram phone-code sign-in command: 'channel.signin.telegram'. */
export const signinRoutingKey = (channel: string): string =>
  `channel.signin.${channel}`;

/** Channel status event, e.g. 'channel.status.whatsapp'. */
export const channelStatusRoutingKey = (channel: string): string =>
  `channel.status.${channel}`;

/** Binding pattern the api channel-status consumer uses: 'channel.status.#'. */
export const CHANNEL_STATUS_ROUTING_KEY_PATTERN = 'channel.status.#';

/** AI request for a platform, e.g. 'ai.request.telegram'. */
export const aiRequestRoutingKey = (platform: string): string =>
  `ai.request.${platform}`;

/** Binding pattern the ai worker uses: 'ai.request.#'. */
export const AI_REQUEST_ROUTING_KEY_PATTERN = 'ai.request.#';

/** The single routing key the api publishes broadcast jobs with. */
export const BROADCAST_JOB_ROUTING_KEY = 'broadcast.job.send';

/** Binding pattern the broadcast.jobs queue uses: 'broadcast.job.#'. */
export const BROADCAST_JOB_BINDING_PATTERN = 'broadcast.job.#';

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/** Api inbound consumer queue (runtime-asserted; not in definitions.json). */
export const INBOUND_QUEUE = 'tectobox.inbound.messages';
/** Api channel-status consumer queue (runtime-asserted; not in definitions.json). */
export const CHANNEL_STATUS_QUEUE = 'tectobox.channel.status';
/** AI worker queue (definitions.json + runtime-asserted). */
export const AI_REQUESTS_QUEUE = 'ai.requests';
/** Broadcast worker queue (definitions.json + runtime-asserted). */
export const BROADCAST_JOBS_QUEUE = 'broadcast.jobs';

/**
 * Outbound queue for a channel worker. Queue name == routing key by design
 * (message.outgoing.whatsapp / .telegram / .meta).
 */
export const outgoingQueue = (channel: string): string =>
  `message.outgoing.${channel}`;

/** Connect-command queue. Queue name == routing key by design. */
export const connectQueue = (channel: string): string =>
  `channel.connect.${channel}`;

/** Disconnect-command queue. Queue name == routing key by design. */
export const disconnectQueue = (channel: string): string =>
  `channel.disconnect.${channel}`;

/** Telegram sign-in queue. Queue name == routing key by design. */
export const signinQueue = (channel: string): string =>
  `channel.signin.${channel}`;

/** Dead-letter queue for a main queue: '<queue>.dlq'. */
export const dlqQueue = (queue: string): string => `${queue}.dlq`;

/** Retry queue for a main queue: '<queue>.retry'. */
export const retryQueue = (queue: string): string => `${queue}.retry`;

/**
 * Dead-letter ROUTING key for a main queue: '<queue>.dlq'.
 * This is the rule definitions.json follows for every queue; it is NOT
 * '<routingKey>.dlq' (see the header note — that default is what the
 * messaging helper would produce for broadcast, and the broker 406s it).
 */
export const dlqRoutingKey = (queue: string): string => `${queue}.dlq`;

/** DLQ routing key the ai.requests queue is declared with. */
export const AI_REQUESTS_DLQ_ROUTING_KEY = 'ai.requests.dlq';
/** DLQ routing key the broadcast.jobs queue is declared with. */
export const BROADCAST_JOBS_DLQ_ROUTING_KEY = 'broadcast.jobs.dlq';

// ---------------------------------------------------------------------------
// Redis keys
// ---------------------------------------------------------------------------

/** The slot every message / session falls back to when none is given. */
export const DEFAULT_SLOT = 'default';

/** WhatsApp QR data URL, polled by the QR modal. TTL {@link QR_TTL_SECONDS}. */
export const waQrKey = (clientId: string | number, slot: string): string =>
  `wa:qr:${clientId}:${slot}`;

/** WhatsApp pairing code (phone login). TTL {@link PAIRING_TTL_SECONDS}. */
export const waPairingKey = (clientId: string | number, slot: string): string =>
  `wa:pairing:${clientId}:${slot}`;

/** Telegram QR data URL. TTL {@link QR_TTL_SECONDS}. */
export const tgQrKey = (clientId: string | number, slot: string): string =>
  `tg:qr:${clientId}:${slot}`;

/** Telegram StringSession (no TTL — lives until disconnect). */
export const tgSessionKey = (clientId: string | number, slot: string): string =>
  `tg:session:${clientId}:${slot}`;

/** Telegram login-code hash. TTL {@link TELEGRAM_CODE_TTL_SECONDS}. */
export const tgCodeHashKey = (clientId: string | number, slot: string): string =>
  `tg:codehash:${clientId}:${slot}`;

/** Telegram login phone number (digits only). TTL {@link TELEGRAM_CODE_TTL_SECONDS}. */
export const tgPhoneKey = (clientId: string | number, slot: string): string =>
  `tg:phone:${clientId}:${slot}`;

/** '1' while a Telegram login code is waiting to be typed. TTL {@link TELEGRAM_CODE_TTL_SECONDS}. */
export const tgCodeSentKey = (clientId: string | number, slot: string): string =>
  `tg:codesent:${clientId}:${slot}`;

/** Meta page access token for a client+channel (messenger/instagram). */
export const metaTokenKey = (clientId: string | number, channel: string): string =>
  `meta:token:${clientId}:${channel}`;

/** Meta page id -> client id (read by Go ingress to resolve a tenant). */
export const metaPageKey = (pageId: string | number): string =>
  `meta:page:${pageId}`;

/** Telegram bot token -> client id (read by Go ingress to resolve a tenant). */
export const telegramBotKey = (token: string): string =>
  `telegram:bot:${token}`;

/**
 * WhatsApp session-map key AND session directory name. Always carries the
 * slot: 'wa:<clientId>:<slot>'.
 */
export const whatsappSessionKey = (clientId: string | number, slot: string): string =>
  `wa:${clientId}:${slot}`;

/**
 * Telegram session-map key. Asymmetric by design: the DEFAULT slot omits
 * the slot suffix ('tg:<clientId>'), non-default slots carry it
 * ('tg:<clientId>:<slot>'). Reproduced exactly — do not "fix" here.
 */
export const telegramSessionKey = (
  clientId: string | number,
  slot?: string,
): string =>
  slot && slot !== DEFAULT_SLOT ? `tg:${clientId}:${slot}` : `tg:${clientId}`;

/** Fencing lease key for a session key: 'lease:<sessionKey>'. */
export const leaseKey = (sessionKey: string): string => `lease:${sessionKey}`;

/** Send-state key, owned by @tectonic/coordination. TTL {@link SEND_ATTEMPT_TTL_SECONDS}. */
export const sendAttemptKey = (idempotencyKey: string): string =>
  `send_attempt:${idempotencyKey}`;

/** Human-readable send failure text (meta worker). TTL {@link SEND_ATTEMPT_TTL_SECONDS}. */
export const sendAttemptErrorKey = (idempotencyKey: string): string =>
  `send_attempt_error:${idempotencyKey}`;

/** Redis pub/sub channel the api publishes SSE events on (not a key). */
export const tenantEventsChannel = (clientId: string | number): string =>
  `tenant:${clientId}:events`;

// ---------------------------------------------------------------------------
// TTLs
// ---------------------------------------------------------------------------

/** QR codes (WhatsApp + Telegram) live 120s. */
export const QR_TTL_SECONDS = 120;
/** WhatsApp pairing codes live 120s. */
export const PAIRING_TTL_SECONDS = 120;
/** Telegram code hash / phone / code-sent flag live 300s. */
export const TELEGRAM_CODE_TTL_SECONDS = 300;
/** Send-attempt state and error text live 24h. */
export const SEND_ATTEMPT_TTL_SECONDS = 86400;
/** Fencing lease TTL (acquire + renew). */
export const LEASE_TTL_SECONDS = 60;
/** Broker-managed retry delay (setupRetryTopology retryTtlMs). */
export const RETRY_TTL_MS = 5000;

// ---------------------------------------------------------------------------
// SSE event types (the `type` field of every tenant:<id>:events payload)
// ---------------------------------------------------------------------------

export const SSE_EVENT_TYPES = {
  /** A message landed in a conversation (inbound, outbound, webchat). */
  MESSAGE: 'message',
  /** Conversation flags changed (needsHuman / read). */
  CONVERSATION_FLAG: 'conversation:flag',
  /** A conversation was marked read. */
  CONVERSATION_READ: 'conversation:read',
  /** Channel list changed — frontend re-reads /connectors. */
  CONNECTORS: 'connectors',
  /** A payment was recorded. */
  PAYMENT_RECEIVED: 'payment:received',
  /** A payment was updated. */
  PAYMENT_UPDATED: 'payment:updated',
  /** QR data URL for WhatsApp / Telegram connect. */
  QR: 'qr',
  /** WhatsApp pairing code issued. */
  PAIRING_CODE: 'pairing_code',
  /** WhatsApp pairing code failed. */
  PAIRING_ERROR: 'pairing_error',
  /** Channel connected / disconnected. */
  CHANNEL_STATUS: 'channel_status',
  /** Telegram login code sent to the phone. */
  TG_CODE_SENT: 'tg_code_sent',
  /** Telegram login code failed / sign-in error. */
  TG_CODE_ERROR: 'tg_code_error',
  /** Telegram account needs its 2FA password. */
  TG_PASSWORD_NEEDED: 'tg_password_needed',
} as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[keyof typeof SSE_EVENT_TYPES];
