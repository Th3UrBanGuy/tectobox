import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { connectBroker } from './reconnect.ts';

describe('Worker Broker Reconnect & Fail-Fast Safety Invariants', () => {
  it('close the connection -> helper reconnects with backoff -> channel re-created -> consumers re-registered', async () => {
    const assertedQueues: string[] = [];
    const boundQueues: string[] = [];
    const consumedQueues: string[] = [];
    let prefetchCount: number | null = null;
    let connectCalls = 0;

    const createMockChannel = () => {
      const emitter = new EventEmitter();
      return Object.assign(emitter, {
        prefetch: async (count: number) => {
          prefetchCount = count;
        },
        assertQueue: async (queue: string, opts: any) => {
          assertedQueues.push(queue);
          return { queue };
        },
        bindQueue: async (queue: string, exchange: string, routingKey: string) => {
          boundQueues.push(`${queue}->${exchange}:${routingKey}`);
        },
        consume: async (queue: string, cb: Function) => {
          consumedQueues.push(queue);
          return { consumerTag: `tag-${queue}` };
        },
        ack: () => {},
        nack: () => {},
      });
    };

    let currentConn = new EventEmitter();
    let currentChannel = createMockChannel();

    const mockMq = {
      conn: currentConn,
      channel: currentChannel,
      getChannel: () => currentChannel,
      connect: async () => {
        connectCalls++;
        currentConn = new EventEmitter();
        currentChannel = createMockChannel();
        mockMq.conn = currentConn;
        mockMq.channel = currentChannel;
      },
    };

    // Connect via shared helper with fast backoff
    await connectBroker(mockMq, {
      initialReconnectMs: 10,
      maxReconnectMs: 50,
      startupTimeoutMs: 1000,
    });

    const ch = mockMq.getChannel();
    assert.ok(ch, 'channel proxy must be available');

    // Worker registers topology and consumers
    await ch.prefetch(1);
    await ch.assertQueue('worker.test.queue', { durable: true });
    await ch.bindQueue('worker.test.queue', 'tectobox.events', 'worker.test.#');
    await ch.consume('worker.test.queue', async (_msg: any) => {});

    assert.strictEqual(assertedQueues.filter((q) => q === 'worker.test.queue').length, 1);
    assert.strictEqual(consumedQueues.filter((q) => q === 'worker.test.queue').length, 1);

    // Simulate broker drop (connection closed)
    mockMq.conn.emit('close');

    // Wait for the reconnect loop to complete (delay is 10ms)
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify reconnect happened and topology re-asserted / consumer re-registered
    assert.ok(connectCalls >= 2, `expected at least 2 connect calls, got ${connectCalls}`);
    assert.strictEqual(assertedQueues.filter((q) => q === 'worker.test.queue').length, 2);
    assert.strictEqual(consumedQueues.filter((q) => q === 'worker.test.queue').length, 2);
    assert.strictEqual(boundQueues.filter((b) => b.includes('worker.test.queue')).length, 2);
    assert.strictEqual(prefetchCount, 1);
  });

  it('bounded startup retry exits non-zero with clear log line when broker unreachable', async () => {
    let exitCode: number | null = null;
    const origExit = process.exit;
    const errorLogs: string[] = [];
    const origConsoleError = console.error;

    // @ts-ignore
    process.exit = (code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code}) called`);
    };

    console.error = (...args: any[]) => {
      errorLogs.push(args.join(' '));
    };

    const failingMq = {
      connect: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5672');
      },
      getChannel: () => null,
    };

    try {
      await connectBroker(failingMq, {
        startupTimeoutMs: 50,
      });
      assert.fail('connectBroker should have failed and called process.exit');
    } catch (err: any) {
      assert.strictEqual(exitCode, 1, 'expected process.exit(1)');
      const combined = errorLogs.join('\n');
      assert.match(combined, /Fatal: RabbitMQ broker unreachable after/i);
      assert.match(combined, /Exiting non-zero/i);
    } finally {
      process.exit = origExit;
      console.error = origConsoleError;
    }
  });
});
