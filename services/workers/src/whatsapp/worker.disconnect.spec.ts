import { describe, it } from 'node:test';
import assert from 'node:assert';
// @ts-ignore
import { startWhatsappWorker } from './worker.ts';

describe('WhatsApp Worker Disconnect Command Handling', () => {
  function createMockBroker() {
    const consumers = new Map<string, (msg: any) => Promise<void>>();
    const published: { routingKey: string; payload: any }[] = [];
    const assertedQueues: { queue: string; options: any }[] = [];
    const boundQueues: { queue: string; exchange: string; routingKey: string }[] = [];

    const channel = {
      prefetch: async () => {},
      assertQueue: async (queue: string, options: any) => {
        assertedQueues.push({ queue, options });
        return { queue };
      },
      bindQueue: async (queue: string, exchange: string, routingKey: string) => {
        boundQueues.push({ queue, exchange, routingKey });
      },
      consume: async (queue: string, callback: (msg: any) => Promise<void>) => {
        consumers.set(queue, callback);
        return { consumerTag: `tag-${queue}` };
      },
      ack: (msg: any) => {
        msg.acked = true;
      },
      nack: (msg: any, requeue: boolean) => {
        msg.nacked = true;
      },
    };

    const mq = {
      connect: async () => {},
      getChannel: () => channel,
      publish: async (routingKey: string, payload: any) => {
        published.push({ routingKey, payload });
      },
      setupRetryTopology: async () => {},
    };

    return {
      mq,
      channel,
      consumers,
      published,
      assertedQueues,
      boundQueues,
    };
  }

  function createMockCoordinator() {
    return {
      acquireLease: async () => 1,
      validateLease: async () => true,
      renewLease: async () => true,
      releaseLease: async () => {},
      publishEvent: async () => {},
      claimSendAttempt: async () => ({ claimed: true }),
      recordSendState: async () => {},
      validateAndTouchLease: async () => true,
    };
  }

  it('consumes channel.disconnect.whatsapp, calls sock.destroy, and publishes status disconnected', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    let destroyCalled = false;

    const mockSock = {
      destroy: async () => {
        destroyCalled = true;
      },
      end: () => {},
    };

    const initialSockets = new Map<string, { sock: any; token: number }>();
    initialSockets.set('wa:69:default', { sock: mockSock, token: 42 });

    const mockRedis = {
      del: async () => 1,
      set: async () => 'OK',
      get: async () => null,
    };

    await startWhatsappWorker({
      mq: broker.mq,
      redis: mockRedis,
      coordinator,
      initialSockets,
    });

    const disconnectConsumer = broker.consumers.get('channel.disconnect.whatsapp');
    assert.ok(disconnectConsumer, 'channel.disconnect.whatsapp consumer must be registered');

    const disconnectMsg = {
      content: Buffer.from(JSON.stringify({ clientId: 69, slot: 'default' })),
    };

    await disconnectConsumer(disconnectMsg);

    assert.strictEqual(destroyCalled, true, 'mocked session destroy must be called');
    assert.strictEqual((disconnectMsg as any).acked, true, 'Disconnect message must be acked');
    assert.strictEqual(initialSockets.has('wa:69:default'), false, 'Session must be removed from live sockets map');

    const statusPub = broker.published.find((p) => p.routingKey === 'channel.status.whatsapp');
    assert.ok(statusPub, 'must publish to channel.status.whatsapp');
    assert.strictEqual(statusPub.payload.clientId, 69);
    assert.strictEqual(statusPub.payload.slot, 'default');
    assert.strictEqual(statusPub.payload.status, 'disconnected');
  });
});
