import { describe, it } from 'node:test';
import assert from 'node:assert';
// @ts-ignore
import { startTelegramWorker } from './worker.ts';

describe('Telegram Worker Connect and Disconnect Handling', () => {
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
    let leaseCounter = 100;
    const leases = new Map<string, number>();

    return {
      acquireLease: async (key: string, ttl: number) => {
        const token = ++leaseCounter;
        leases.set(key, token);
        return token;
      },
      validateLease: async (key: string, token: number) => {
        return leases.get(key) === token;
      },
      renewLease: async (key: string, token: number, ttl: number) => {
        return leases.get(key) === token;
      },
      releaseLease: async (key: string, token: number) => {
        leases.delete(key);
      },
      publishEvent: async (channel: string, event: any) => {},
      claimSendAttempt: async () => ({ claimed: true }),
      recordSendState: async () => {},
      validateAndTouchLease: async () => true,
    };
  }

  function createMockRedis() {
    const store = new Map<string, string>();
    return {
      del: async (key: string) => {
        store.delete(key);
        return 1;
      },
      set: async (key: string, val: string) => {
        store.set(key, val);
        return 'OK';
      },
      get: async (key: string) => store.get(key) || null,
    };
  }

  it('consumes channel.connect.telegram, starts session and publishes channel.status.telegram connected', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();
    let clientConnected = false;

    const mockClient = {
      connect: async () => {
        clientConnected = true;
      },
      destroy: async () => {},
      disconnect: async () => {},
    };

    await startTelegramWorker({
      mq: broker.mq,
      coordinator,
      redis,
      createClient: () => mockClient,
    });

    const connectConsumer = broker.consumers.get('channel.connect.telegram');
    assert.ok(connectConsumer, 'channel.connect.telegram consumer must be registered');

    // Simulate connect message
    const msg = {
      content: Buffer.from(
        JSON.stringify({
          clientId: 69,
          slot: 'hh',
          channelRowId: 101,
          label: 'Support Telegram',
        })
      ),
    };

    await connectConsumer(msg);

    assert.strictEqual(clientConnected, true, 'TelegramClient.connect() must be invoked');
    assert.strictEqual((msg as any).acked, true, 'Connect message must be acked');

    const statusPub = broker.published.find((p) => p.routingKey === 'channel.status.telegram');
    assert.ok(statusPub, 'must publish to channel.status.telegram');
    assert.strictEqual(statusPub.payload.clientId, 69);
    assert.strictEqual(statusPub.payload.slot, 'hh');
    assert.strictEqual(statusPub.payload.status, 'connected');
  });

  it('consumes channel.disconnect.telegram, calls session.destroy and publishes status disconnected', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();
    let destroyCalled = false;

    const mockClient = {
      connect: async () => {},
      destroy: async () => {
        destroyCalled = true;
      },
      disconnect: async () => {},
    };

    await startTelegramWorker({
      mq: broker.mq,
      coordinator,
      redis,
      createClient: () => mockClient,
    });

    const connectConsumer = broker.consumers.get('channel.connect.telegram');
    const disconnectConsumer = broker.consumers.get('channel.disconnect.telegram');
    assert.ok(disconnectConsumer, 'channel.disconnect.telegram consumer must be registered');

    // First connect to populate session
    await connectConsumer!({
      content: Buffer.from(JSON.stringify({ clientId: 69, slot: 'hh' })),
    });

    // Now disconnect
    const disconnectMsg = {
      content: Buffer.from(JSON.stringify({ clientId: 69, slot: 'hh' })),
    };

    await disconnectConsumer!(disconnectMsg);

    assert.strictEqual(destroyCalled, true, 'mocked session.destroy() must be called');
    assert.strictEqual((disconnectMsg as any).acked, true, 'Disconnect message must be acked');

    const statusPub = broker.published.filter((p) => p.routingKey === 'channel.status.telegram');
    const disconnectedEvent = statusPub.find((p) => p.payload.status === 'disconnected');
    assert.ok(disconnectedEvent, 'must publish channel.status.telegram with status disconnected');
    assert.strictEqual(disconnectedEvent.payload.clientId, 69);
    assert.strictEqual(disconnectedEvent.payload.slot, 'hh');
  });
});
