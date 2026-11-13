import { describe, it } from 'node:test';
import assert from 'node:assert';
import { handleMetaOutgoingMessage } from './worker.ts';

describe('Meta Worker Fake Send Prevention (H6)', () => {
  it('never marks a simulated/unconfigured send as sent; records failed with meta_send_not_configured', async () => {
    const recordedStates: Array<{ key: string; state: string }> = [];
    const redisStore = new Map<string, string>();
    let nacked = false;
    let acked = false;

    const mockChannel = {
      ack: () => {
        acked = true;
      },
      nack: (_msg: any, _allUpTo: boolean, _requeue: boolean) => {
        nacked = true;
      },
    };

    const mockCoordinator = {
      claimSendAttempt: async (key: string) => ({ claimed: true, state: 'sending' }),
      recordSendState: async (key: string, state: string) => {
        recordedStates.push({ key, state });
      },
      getSendState: async (key: string) => null,
    };

    const mockRedis = {
      get: async (key: string) => null, // No token configured in Redis
      set: async (key: string, val: string) => {
        redisStore.set(key, val);
      },
    };

    const mockMq = {
      publish: async () => true,
    };

    // Ensure no fallback env var is set
    delete process.env.META_PAGE_ACCESS_TOKEN;

    const payload = {
      clientId: 123,
      to: 'recipient-fb-123',
      text: 'Order confirmation message',
      platform: 'messenger',
      attempt: 1,
    };

    const msg = {
      content: Buffer.from(JSON.stringify(payload)),
      properties: { headers: {} },
    };

    const result = await handleMetaOutgoingMessage(msg, mockChannel, mockCoordinator, mockRedis, mockMq);

    // 1. Result must be failed with meta_send_not_configured
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'meta_send_not_configured');

    // 2. Worker must NEVER record 'sent' state
    const sentRecord = recordedStates.find((r) => r.state === 'sent');
    assert.strictEqual(sentRecord, undefined, 'Worker must NEVER record "sent" for simulated/unconfigured send');

    // 3. Worker must record 'failed'
    const failedRecord = recordedStates.find((r) => r.state === 'failed');
    assert.ok(failedRecord, 'Worker must record "failed" state');

    // 4. Redis error tracking
    const errorKey = Array.from(redisStore.keys()).find((k) => k.startsWith('send_attempt_error:'));
    assert.ok(errorKey, 'Error must be tracked in Redis');
    assert.strictEqual(redisStore.get(errorKey!), 'meta_send_not_configured');

    // 5. Message must be nacked to DLQ, never acked
    assert.strictEqual(acked, false, 'Simulated send must not be acknowledged');
    assert.strictEqual(nacked, true, 'Simulated send must be nacked to DLQ');
  });
});
