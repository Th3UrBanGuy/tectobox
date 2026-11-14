import { Redis } from 'ioredis';
import { RedisCoordinator } from '@tectonic/coordination';
import { RabbitMQClient } from '@tectonic/messaging';

/**
 * Shared mutable connection state for the events subsystem.
 *
 * Phase 3 of the modular restructure: `EventsService` was a god-object
 * holding 9 private fields (Redis client, coordinator, RabbitMQ client,
 * timers, connection flags) that every one of its methods reached into.
 * The focused services under `events/` now share one `BrokerState`
 * instance, owned by `EventsService`, instead of each keeping its own
 * copy of the connection. No behaviour change — the fields are exactly
 * the ones `EventsService` used to hold.
 */
export class BrokerState {
  redis: Redis | null = null;
  coordinator: RedisCoordinator | null = null;
  mq: RabbitMQClient | null = null;
  outboxTimer: NodeJS.Timeout | null = null;
  isProcessingOutbox = false;
  isConnected = false;
  isClosing = false;
  isReconnecting = false;
  reconnectTimer: NodeJS.Timeout | null = null;
}
