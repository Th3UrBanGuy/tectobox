import { tenantEventsChannel } from '@tectonic/contracts';
import type { BrokerState } from './broker-state.js';

/**
 * SSE fan-out: publishes one real-time event to a tenant workspace via
 * Redis Pub/Sub (the channel `sse.controller.ts` subscribes to).
 *
 * Moved verbatim out of `EventsService.broadcastTenantEvent`
 * (Phase 3 of the modular restructure). No behaviour change.
 */
export class SsePublisherService {
  constructor(private readonly state: BrokerState) {}

  /**
   * Broadcast real-time SSE event to a tenant workspace via Redis Pub/Sub
   */
  async broadcastTenantEvent(tenantId: number, event: any): Promise<void> {
    const channel = tenantEventsChannel(tenantId);
    if (this.state.coordinator) {
      try {
        await this.state.coordinator.publishEvent(channel, event);
      } catch (err: any) {
        console.warn(`[events] Failed to publish SSE event to ${channel}:`, err.message);
      }
    }
  }
}
