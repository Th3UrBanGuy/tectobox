import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { EventsService } from './events.service.js';
import { RabbitMQClient } from '@tectonic/messaging';

describe('EventsService Broker Reconnect & Startup Bounded Retry', () => {
  let mockPool: any;
  let mockLicensing: any;
  let service: EventsService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    mockLicensing = {
      resolveAccess: vi.fn().mockResolvedValue({ aiAllowed: true }),
      consumeAiCredit: vi.fn().mockResolvedValue(true),
    };
    service = new EventsService(mockPool, mockLicensing);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('reconnects with backoff, re-creates channel, and re-registers consumers on broker disconnect', async () => {
    process.env.RABBITMQ_RECONNECT_INITIAL_MS = '10';
    process.env.RABBITMQ_RECONNECT_MAX_MS = '50';

    const assertedQueues: string[] = [];
    const boundQueues: string[] = [];
    const consumedQueues: string[] = [];

    const createMockChannel = () => ({
      assertQueue: vi.fn().mockImplementation(async (q: string) => {
        assertedQueues.push(q);
        return { queue: q };
      }),
      bindQueue: vi.fn().mockImplementation(async (q: string, ex: string, rk: string) => {
        boundQueues.push(`${q}->${ex}:${rk}`);
      }),
      consume: vi.fn().mockImplementation(async (q: string) => {
        consumedQueues.push(q);
        return { consumerTag: `tag-${q}` };
      }),
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const conn1 = new EventEmitter();
    const chan1 = createMockChannel();
    const mockMq1: any = {
      conn: conn1,
      channel: chan1,
      getChannel: () => chan1,
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    service.setMqClient(mockMq1);
    service.setIsConnected(true);
    service.attachConnectionLifecycle();

    // Reconnect will instantiate RabbitMQClient and call connect()
    const conn2 = new EventEmitter();
    const chan2 = createMockChannel();
    let connectCallCount = 0;

    vi.spyOn(RabbitMQClient.prototype, 'connect').mockImplementation(async function (this: any) {
      connectCallCount++;
      this.conn = conn2;
      this.channel = chan2;
      this.getChannel = () => chan2;
    });

    // Simulate broker drop (close event on connection)
    conn1.emit('close');

    // Wait for the reconnect loop to complete (delay is 10ms)
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(connectCallCount).toBeGreaterThanOrEqual(1);
    expect(service.getIsConnected()).toBe(true);

    // Verify channel re-created and topology re-asserted / consumers re-registered
    expect(assertedQueues).toContain('tectobox.inbound.messages');
    expect(assertedQueues).toContain('tectobox.channel.status');
    expect(consumedQueues).toContain('tectobox.inbound.messages');
    expect(consumedQueues).toContain('tectobox.channel.status');
  });

  it('retries on boot for bounded timeout, then exits non-zero with clear log line', async () => {
    process.env.RABBITMQ_STARTUP_TIMEOUT_MS = '60';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(RabbitMQClient.prototype, 'connect').mockRejectedValue(
      new Error('ECONNREFUSED 127.0.0.1:5672')
    );

    await service.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorLogs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorLogs).toMatch(/Fatal: RabbitMQ broker unreachable after/i);
    expect(errorLogs).toMatch(/Exiting non-zero/i);
  });
});
