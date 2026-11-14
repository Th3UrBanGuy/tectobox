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
    const events: { channel: string; event: any }[] = [];

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

  it('consumes channel.connect.telegram, starts session, does NOT claim connected before the QR is scanned', async () => {
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

    // The row must NOT flip to connected at Connect-tap time: nothing is
    // authorized yet. It flips only when the QR is scanned (or a saved
    // session is alive). Publishing here used to close the QR modal before
    // the user could scan.
    const statusPub = broker.published.find((p) => p.routingKey === 'channel.status.telegram');
    assert.strictEqual(statusPub, undefined, 'must NOT publish connected before login completes');
  });

  it('connect with a saved session: authorized client publishes connected', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();

    const mockClient = {
      connect: async () => {},
      checkAuthorization: async () => true,
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
    await connectConsumer!({
      content: Buffer.from(JSON.stringify({ clientId: 69, slot: 'hh' })),
    });

    const statusPub = broker.published.find((p) => p.routingKey === 'channel.status.telegram');
    assert.ok(statusPub, 'must publish to channel.status.telegram');
    assert.strictEqual(statusPub.payload.clientId, 69);
    assert.strictEqual(statusPub.payload.slot, 'hh');
    assert.strictEqual(statusPub.payload.status, 'connected');
  });

  it('phone connect: sendCode is called, code hash is stored, tg_code_sent is published', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();
    let sendCodeArgs: any = null;

    const mockClient = {
      connect: async () => {},
      checkAuthorization: async () => false,
      sendCode: async (...args: any[]) => {
        sendCodeArgs = args;
        return { phoneCodeHash: 'hash1' };
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
    const msg = {
      content: Buffer.from(
        JSON.stringify({ clientId: 69, slot: 'hh', method: 'phone', phoneNumber: '8801712345678' })
      ),
    };
    await connectConsumer!(msg);

    assert.strictEqual((msg as any).acked, true, 'Connect message must be acked');
    assert.ok(sendCodeArgs, 'sendCode must be called');
    assert.strictEqual(sendCodeArgs[1], '8801712345678', 'sendCode gets the digits-only number');
    assert.strictEqual(await redis.get('tg:codehash:69:hh'), 'hash1');
    assert.strictEqual(await redis.get('tg:phone:69:hh'), '8801712345678');
    assert.strictEqual(await redis.get('tg:codesent:69:hh'), '1');
    const sent = coordinator.events.find((e: any) => e.event.type === 'tg_code_sent');
    assert.ok(sent, 'tg_code_sent must be published over SSE');
    const statusPub = broker.published.find((p) => p.routingKey === 'channel.status.telegram');
    assert.strictEqual(statusPub, undefined, 'must NOT publish connected before the code is typed');
  });

  it('phone signin: correct code saves the session and publishes connected', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();
    let signedIn: any = null;

    const mockClient = {
      connect: async () => {},
      checkAuthorization: async () => false,
      sendCode: async () => ({ phoneCodeHash: 'hash1' }),
      signInUser: async (...args: any[]) => {
        signedIn = args;
      },
      session: { save: () => 'sess-abc' },
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
    await connectConsumer!({
      content: Buffer.from(
        JSON.stringify({ clientId: 69, slot: 'hh', method: 'phone', phoneNumber: '8801712345678' })
      ),
    });

    const signinConsumer = broker.consumers.get('channel.signin.telegram');
    assert.ok(signinConsumer, 'channel.signin.telegram consumer must be registered');
    const signinMsg = {
      content: Buffer.from(JSON.stringify({ clientId: 69, slot: 'hh', phoneCode: '12345' })),
    };
    await signinConsumer!(signinMsg);

    assert.strictEqual((signinMsg as any).acked, true, 'Signin message must be acked');
    assert.ok(signedIn, 'signInUser must be called');
    assert.strictEqual(signedIn[1].phoneNumber, '8801712345678');
    assert.strictEqual(signedIn[1].phoneCodeHash, 'hash1');
    assert.strictEqual(signedIn[1].phoneCode, '12345');
    assert.strictEqual(await redis.get('tg:session:69:hh'), 'sess-abc', 'session string must be saved');
    assert.strictEqual(await redis.get('tg:codehash:69:hh'), null, 'code hash must be cleared after login');
    const statusPub = broker.published.find(
      (p) => p.routingKey === 'channel.status.telegram' && p.payload.status === 'connected'
    );
    assert.ok(statusPub, 'must publish connected after successful sign-in');
  });

  it('phone signin: wrong code publishes tg_code_error and stays disconnected', async () => {
    const broker = createMockBroker();
    const coordinator = createMockCoordinator();
    const redis = createMockRedis();

    const mockClient = {
      connect: async () => {},
      checkAuthorization: async () => false,
      sendCode: async () => ({ phoneCodeHash: 'hash1' }),
      signInUser: async () => {
        throw new Error('PHONE_CODE_INVALID');
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
    await connectConsumer!({
      content: Buffer.from(
        JSON.stringify({ clientId: 69, slot: 'hh', method: 'phone', phoneNumber: '8801712345678' })
      ),
    });

    const signinConsumer = broker.consumers.get('channel.signin.telegram');
    await signinConsumer!({
      content: Buffer.from(JSON.stringify({ clientId: 69, slot: 'hh', phoneCode: '99999' })),
    });

    const errEvent = coordinator.events.find((e: any) => e.event.type === 'tg_code_error');
    assert.ok(errEvent, 'tg_code_error must be published');
    assert.match(errEvent.event.error, /Wrong code/);
    const statusPub = broker.published.find((p) => p.routingKey === 'channel.status.telegram');
    assert.strictEqual(statusPub, undefined, 'must NOT publish connected on a wrong code');
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
