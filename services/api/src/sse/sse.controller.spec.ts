import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SseController } from './sse.controller.js';
import { EventEmitter } from 'events';

// Mock RedisSubscriber from @tectonic/coordination
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockClose = vi.fn();

vi.mock('@tectonic/coordination', () => {
  return {
    RedisSubscriber: class {
      subscribe = mockSubscribe;
      unsubscribe = mockUnsubscribe;
      close = mockClose;
    },
  };
});

describe('SseController', () => {
  let controller: SseController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new SseController();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets SSE headers, connects initial handshake, and subscribes to tenant channel', async () => {
    const writtenData: string[] = [];
    const setHeaders: Record<string, string> = {};

    const req = new EventEmitter() as any;
    const res: any = {
      setHeader: (name: string, value: string) => {
        setHeaders[name] = value;
      },
      flushHeaders: vi.fn(),
      write: (data: string) => {
        writtenData.push(data);
      },
    };

    mockSubscribe.mockImplementation(async (channel: string, callback: Function) => {
      expect(channel).toBe('tenant:123:events');
      callback({ type: 'message_created', text: 'hello' });
    });

    await controller.sseStream(req, res, 123);

    expect(setHeaders['Content-Type']).toBe('text/event-stream');
    expect(setHeaders['Cache-Control']).toBe('no-cache');
    expect(setHeaders['Connection']).toBe('keep-alive');
    expect(writtenData[0]).toBe(': connected\n\n');
    expect(writtenData[1]).toBe('data: {"type":"message_created","text":"hello"}\n\n');

    // Simulate client disconnect
    req.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockUnsubscribe).toHaveBeenCalledWith('tenant:123:events');
    expect(mockClose).toHaveBeenCalled();
  });
});
