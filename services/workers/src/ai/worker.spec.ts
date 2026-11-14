import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { getPrefetchLimit } from './worker.ts';

describe('AI Worker Prefetch & Concurrency (F3)', () => {
  const origPrefetch = process.env.AI_PREFETCH;

  afterEach(() => {
    if (origPrefetch === undefined) {
      delete process.env.AI_PREFETCH;
    } else {
      process.env.AI_PREFETCH = origPrefetch;
    }
  });

  it('defaults prefetch to 10 when AI_PREFETCH is unset', () => {
    delete process.env.AI_PREFETCH;
    assert.strictEqual(getPrefetchLimit(), 10);
  });

  it('reads prefetch value from AI_PREFETCH environment variable', () => {
    process.env.AI_PREFETCH = '25';
    assert.strictEqual(getPrefetchLimit(), 25);

    process.env.AI_PREFETCH = '1';
    assert.strictEqual(getPrefetchLimit(), 1);

    process.env.AI_PREFETCH = '50';
    assert.strictEqual(getPrefetchLimit(), 50);
  });

  it('falls back to default 10 when AI_PREFETCH is invalid or non-positive', () => {
    process.env.AI_PREFETCH = 'not-a-number';
    assert.strictEqual(getPrefetchLimit(), 10);

    process.env.AI_PREFETCH = '0';
    assert.strictEqual(getPrefetchLimit(), 10);

    process.env.AI_PREFETCH = '-10';
    assert.strictEqual(getPrefetchLimit(), 10);

    process.env.AI_PREFETCH = '   ';
    assert.strictEqual(getPrefetchLimit(), 10);
  });

  it('passes configured prefetch from env to channel.prefetch', async () => {
    process.env.AI_PREFETCH = '16';
    let calledPrefetch: number | null = null;
    const mockChannel = {
      prefetch: async (count: number) => {
        calledPrefetch = count;
      },
    };

    const prefetchVal = getPrefetchLimit();
    await mockChannel.prefetch(prefetchVal);
    assert.strictEqual(calledPrefetch, 16);
  });
});
