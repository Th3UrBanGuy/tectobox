import { describe, it } from 'node:test';
import assert from 'node:assert';
// @ts-ignore
import { startWhatsappWorker } from './worker.ts';

describe('WhatsApp Worker Phone Login (pairing code)', () => {
  function createMockBroker() {
    const consumers = new Map<string, (msg: any) => Promise<void>>();
    const published: { routingKey: string; payload: any }[] = [];
    const channel = {
      prefetch: async () => {},
      assertQueue: async (queue: string, options: any) => ({ queue }),
      bindQueue: async () => {},
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
    return { mq, channel, consumers, published };
  }

  function createMockCoordinator() {
    const events: { channel: string; event: any }[] = [];
    return {
      acquireLease: async () => 1,
      validateLease: async () => true,
      renewLease: async () => true,
      releaseLease: async () => {},
      publishEvent: async (channel: string, event: any) => {
        events.push({ channel, event });
      },
      events,
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

  it('phone connect: requests a pairing code, stores it, publishes pairing_code', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();
    let pairingNumber: string | null = null;

    const mockSock = {
      requestPairingCode: async (num: string) => {
        pairingNumber = num;
        return 'AB12CD34';
      },
      ev: { on: () => {} },
      end: () => {},
      destroy: async () => {},
    };

    const initialSockets = new Map<string, { sock: any; token: number }>();
    initialSockets.set('wa:69:default', { sock: mockSock, token: 42 });

    await startWhatsappWorker({
      mq: broker.mq,
      redis,
      coordinator,
      initialSockets,
    });

    const connectConsumer = broker.consumers.get('channel.connect.whatsapp');
    assert.ok(connectConsumer, 'channel.connect.whatsapp consumer must be registered');
    const msg = {
      content: Buffer.from(
        JSON.stringify({ clientId: 69, slot: 'default', method: 'phone', phoneNumber: '8801712345678' })
      ),
    };
    await connectConsumer!(msg);

    assert.strictEqual((msg as any).acked, true, 'Connect message must be acked');
    assert.strictEqual(pairingNumber, '8801712345678', 'requestPairingCode gets the digits-only number');
    assert.strictEqual(await redis.get('wa:pairing:69:default'), 'AB12-CD34', 'code is stored grouped 4-4');
    const codeEvent = coordinator.events.find((e: any) => e.event.type === 'pairing_code');
    assert.ok(codeEvent, 'pairing_code must be published over SSE');
    assert.strictEqual(codeEvent.event.code, 'AB12-CD34');
    assert.strictEqual(codeEvent.event.channel, 'whatsapp');
  });

  it('qr connect: never requests a pairing code', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();
    let pairingCalled = false;

    const mockSock = {
      requestPairingCode: async () => {
        pairingCalled = true;
        return 'AB12CD34';
      },
      ev: { on: () => {} },
      end: () => {},
      destroy: async () => {},
    };

    const initialSockets = new Map<string, { sock: any; token: number }>();
    initialSockets.set('wa:69:default', { sock: mockSock, token: 42 });

    await startWhatsappWorker({
      mq: broker.mq,
      redis,
      coordinator,
      initialSockets,
    });

    const connectConsumer = broker.consumers.get('channel.connect.whatsapp');
    await connectConsumer!({
      content: Buffer.from(JSON.stringify({ clientId: 69, slot: 'default', method: 'qr' })),
    });

    assert.strictEqual(pairingCalled, false, 'QR flow must not call requestPairingCode');
    assert.strictEqual(await redis.get('wa:pairing:69:default'), null);
  });

  it('phone connect: a failed pairing request publishes pairing_error, stays connecting', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();

    const mockSock = {
      requestPairingCode: async () => {
        throw new Error('rate limited');
      },
      ev: { on: () => {} },
      end: () => {},
      destroy: async () => {},
    };

    const initialSockets = new Map<string, { sock: any; token: number }>();
    initialSockets.set('wa:69:default', { sock: mockSock, token: 42 });

    await startWhatsappWorker({
      mq: broker.mq,
      redis,
      coordinator,
      initialSockets,
    });

    const connectConsumer = broker.consumers.get('channel.connect.whatsapp');
    const msg = {
      content: Buffer.from(
        JSON.stringify({ clientId: 69, slot: 'default', method: 'phone', phoneNumber: '8801712345678' })
      ),
    };
    await connectConsumer!(msg);

    assert.strictEqual((msg as any).acked, true, 'Connect message must be acked even on pairing failure');
    const errEvent = coordinator.events.find((e: any) => e.event.type === 'pairing_error');
    assert.ok(errEvent, 'pairing_error must be published');
    assert.match(errEvent.event.error, /rate limited/);
    const statusPub = broker.published.find((p) => p.routingKey === 'channel.status.whatsapp');
    assert.strictEqual(statusPub, undefined, 'must NOT publish connected on pairing failure');
  });

  it('phone connect: a "Connection Closed" failure is translated to a helpful pairing_error', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();

    const mockSock = {
      requestPairingCode: async () => {
        throw new Error('Connection Closed');
      },
      ev: { on: () => {} },
      end: () => {},
      destroy: async () => {},
    };

    const initialSockets = new Map<string, { sock: any; token: number }>();
    initialSockets.set('wa:69:default', { sock: mockSock, token: 42 });

    await startWhatsappWorker({
      mq: broker.mq,
      redis,
      coordinator,
      initialSockets,
    });

    const connectConsumer = broker.consumers.get('channel.connect.whatsapp');
    const msg = {
      content: Buffer.from(
        JSON.stringify({ clientId: 69, slot: 'default', method: 'phone', phoneNumber: '01712345678' })
      ),
    };
    await connectConsumer!(msg);

    assert.strictEqual((msg as any).acked, true, 'Connect message must be acked even on pairing failure');
    const errEvent = coordinator.events.find((e: any) => e.event.type === 'pairing_error');
    assert.ok(errEvent, 'pairing_error must be published');
    assert.match(errEvent.event.error, /country code is wrong/);
    assert.doesNotMatch(errEvent.event.error, /Connection Closed/);
  });
});
