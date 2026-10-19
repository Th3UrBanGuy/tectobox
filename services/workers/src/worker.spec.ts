import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Worker Delivery & Fencing Safety Invariants', () => {
  it('monotonic fencing token increments across successive leases', () => {
    let atomicCounter = 100;
    const nextFencingToken = () => ++atomicCounter;

    const token1 = nextFencingToken();
    const token2 = nextFencingToken();
    const token3 = nextFencingToken();

    assert.ok(token2 > token1, 'token2 must be strictly greater than token1');
    assert.ok(token3 > token2, 'token3 must be strictly greater than token2');
  });

  it('rejects stale fencing token when current lease has advanced', () => {
    let currentLeaseToken = 105;
    const validateToken = (candidate: number) => candidate === currentLeaseToken;

    assert.strictEqual(validateToken(104), false, 'stale token 104 must be rejected');
    assert.strictEqual(validateToken(105), true, 'current token 105 must be accepted');
    assert.strictEqual(validateToken(106), false, 'future invalid token 106 must be rejected');
  });

  it('detects previously sent messages and prevents duplicate send', () => {
    const sendAttempts = new Map<string, string>();
    sendAttempts.set('idempotency-key-abc', 'sent');

    const shouldSend = (key: string) => {
      const state = sendAttempts.get(key);
      if (state === 'sent' || state === 'outcome-unknown') return false;
      return true;
    };

    assert.strictEqual(shouldSend('idempotency-key-abc'), false, 'already sent message must not be resent');
    assert.strictEqual(shouldSend('idempotency-key-new'), true, 'new message must be allowed');
  });

  it('routes to DLQ when max retries exceeded', () => {
    const MAX_RETRIES = 3;
    const decideAction = (attempt: number) => {
      if (attempt < MAX_RETRIES) return 'retry-backoff';
      return 'dlq';
    };

    assert.strictEqual(decideAction(1), 'retry-backoff');
    assert.strictEqual(decideAction(2), 'retry-backoff');
    assert.strictEqual(decideAction(3), 'dlq');
    assert.strictEqual(decideAction(4), 'dlq');
  });

  it('atomic validateAndTouchLease rejects stale tokens and allows current token', () => {
    // Simulated atomic Redis lease storage
    let currentStore: { [key: string]: { token: string; ttl: number } } = {
      'lease:tg:client-1': { token: '42', ttl: 60 }
    };

    const validateAndTouchLeaseSim = (key: string, fencingToken: number, ttlSec: number = 60): boolean => {
      const entry = currentStore[key];
      if (entry && entry.token === fencingToken.toString()) {
        entry.ttl = ttlSec;
        return true;
      }
      return false;
    };

    // Stale worker with token 41 tries to validate
    assert.strictEqual(
      validateAndTouchLeaseSim('lease:tg:client-1', 41, 60),
      false,
      'stale worker with token 41 must be atomically rejected'
    );

    // Active worker with token 42 validates and touches lease
    assert.strictEqual(
      validateAndTouchLeaseSim('lease:tg:client-1', 42, 60),
      true,
      'active worker with token 42 must be accepted and touch lease'
    );

    // Lease expires / key removed
    delete currentStore['lease:tg:client-1'];
    assert.strictEqual(
      validateAndTouchLeaseSim('lease:tg:client-1', 42, 60),
      false,
      'expired lease must be rejected'
    );
  });

  it('durable send state tracking prevents duplicate sends on ambiguous outcome', () => {
    type SendState = 'pending' | 'sending' | 'sent' | 'failed' | 'outcome-unknown';
    const store = new Map<string, SendState>();

    const recordSendState = (key: string, state: SendState) => store.set(key, state);
    const getSendState = (key: string) => store.get(key) || null;

    const idempotencyKey = 'msg-uuid-999';
    recordSendState(idempotencyKey, 'pending');
    assert.strictEqual(getSendState(idempotencyKey), 'pending');

    recordSendState(idempotencyKey, 'sending');
    assert.strictEqual(getSendState(idempotencyKey), 'sending');

    // Network timeout during dispatch -> provider outcome unknown
    recordSendState(idempotencyKey, 'outcome-unknown');
    assert.strictEqual(getSendState(idempotencyKey), 'outcome-unknown');

    // Delivery pipeline check on redelivery / retry
    const handleOutgoing = (key: string) => {
      const state = getSendState(key);
      if (state === 'sent') return { action: 'ack-duplicate' };
      if (state === 'outcome-unknown') return { action: 'dlq-hold-for-reconciliation' };
      return { action: 'dispatch' };
    };

    const result = handleOutgoing(idempotencyKey);
    assert.strictEqual(
      result.action,
      'dlq-hold-for-reconciliation',
      'ambiguous outcome must route to DLQ/hold and never silently resend'
    );

    // Check confirmed sent state
    recordSendState(idempotencyKey, 'sent');
    assert.strictEqual(handleOutgoing(idempotencyKey).action, 'ack-duplicate');
  });

  it('retries do not ack original message before confirmed re-publish', async () => {
    const queueEvents: string[] = [];
    const mockChannel = {
      ack: () => queueEvents.push('ack'),
      nack: () => queueEvents.push('nack')
    };

    // Scenario 1: Republish succeeds -> ack original
    const handleRetrySuccess = async (republishFn: () => Promise<void>) => {
      try {
        await republishFn();
        mockChannel.ack();
      } catch {
        mockChannel.nack();
      }
    };

    await handleRetrySuccess(async () => {
      queueEvents.push('published');
    });

    assert.deepStrictEqual(queueEvents, ['published', 'ack'], 'ack must occur strictly after successful re-publish');

    // Scenario 2: Republish fails -> nack to DLQ instead of ack
    queueEvents.length = 0;
    await handleRetrySuccess(async () => {
      throw new Error('RabbitMQ connection dropped');
    });

    assert.deepStrictEqual(queueEvents, ['nack'], 'must nack when re-publish fails rather than blindly acking');
  });

  it('session lease renewal failure immediately cancels consumer to prevent split-brain', async () => {
    let consumerCancelled = false;
    let socketClosed = false;

    const mockChannel = {
      cancel: async (_tag: string) => {
        consumerCancelled = true;
      }
    };

    const mockSocket = {
      end: () => {
        socketClosed = true;
      }
    };

    // Simulate renewal heartbeat tick
    const onRenewalFailure = async (consumerTag: string) => {
      const renewOk = false; // lease expired or acquired by another instance
      if (!renewOk) {
        mockSocket.end();
        await mockChannel.cancel(consumerTag);
      }
    };

    await onRenewalFailure('ctag-whatsapp-1');

    assert.strictEqual(consumerCancelled, true, 'consumer must be cancelled immediately on lease loss');
    assert.strictEqual(socketClosed, true, 'socket connection must be terminated on lease loss');
  });

  it('atomic claimSendAttempt prevents concurrent duplicate delivery attempts', () => {
    // Simulated atomic Lua claimSendAttempt behavior
    const store = new Map<string, string>();
    const claimSendAttemptSim = (idempotencyKey: string): { claimed: boolean; state: string } => {
      const current = store.get(idempotencyKey);
      if (current === 'sent' || current === 'sending' || current === 'outcome-unknown') {
        return { claimed: false, state: current };
      }
      store.set(idempotencyKey, 'sending');
      return { claimed: true, state: 'sending' };
    };

    const idempotencyKey = 'tg:client-1:user-99:hash-text';

    // Worker 1 claims attempt
    const worker1Claim = claimSendAttemptSim(idempotencyKey);
    assert.strictEqual(worker1Claim.claimed, true, 'Worker 1 must successfully claim unstarted send');
    assert.strictEqual(worker1Claim.state, 'sending');

    // Worker 2 tries to claim concurrently while Worker 1 is still sending
    const worker2Claim = claimSendAttemptSim(idempotencyKey);
    assert.strictEqual(worker2Claim.claimed, false, 'Worker 2 claim must fail due to active sending state');
    assert.strictEqual(worker2Claim.state, 'sending');

    // Once finished and marked sent, any late arrival is rejected
    store.set(idempotencyKey, 'sent');
    const worker3Claim = claimSendAttemptSim(idempotencyKey);
    assert.strictEqual(worker3Claim.claimed, false, 'Worker 3 claim must fail because send is already sent');
    assert.strictEqual(worker3Claim.state, 'sent');
  });

  it('crash after provider acceptance marks outcome-unknown and rejects re-dispatch', async () => {
    const states = new Map<string, string>();
    const channelActions: string[] = [];
    const mockChannel = {
      ack: () => channelActions.push('ack'),
      nack: (_msg: any, _all: boolean, requeue: boolean) => channelActions.push(`nack-requeue:${requeue}`)
    };

    const idempotencyKey = 'wa:client-1:default:+12345:hash-payload';
    states.set(idempotencyKey, 'sending');

    // Simulated provider call: external provider accepts message, but local worker experiences network drop / timeout before ack
    const providerDispatch = async () => {
      // External side-effect happened at WhatsApp/Telegram gateway...
      // but timeout occurred reading socket response!
      throw new Error('Socket timed out reading provider response');
    };

    try {
      await providerDispatch();
      states.set(idempotencyKey, 'sent');
    } catch {
      // Mark outcome-unknown
      states.set(idempotencyKey, 'outcome-unknown');
    }

    assert.strictEqual(states.get(idempotencyKey), 'outcome-unknown');

    // Redelivery arrives (e.g. from broker retry or redelivery)
    const handleRedelivery = (key: string, msg: any) => {
      const currentState = states.get(key);
      if (currentState === 'sent') {
        mockChannel.ack();
        return;
      }
      if (currentState === 'outcome-unknown') {
        // Must route to DLQ without requeueing or resending
        mockChannel.nack(msg, false, false);
        return;
      }
    };

    handleRedelivery(idempotencyKey, {});
    assert.deepStrictEqual(
      channelActions,
      ['nack-requeue:false'],
      'ambiguous outcome after provider dispatch must be nacked without requeue (routed to DLQ for reconciliation)'
    );
  });

  it('retry attempt persists across redeliveries and broker-managed retry queues', () => {
    // Durable broker-managed retry simulation:
    // Message payload carries attempt counter or header survives in RabbitMQ message properties
    interface RabbitMessage {
      properties: {
        headers?: Record<string, any>;
      };
      content: string;
    }

    const processMessage = (msg: RabbitMessage, maxRetries = 3) => {
      const payload = JSON.parse(msg.content);
      const headerAttempt = msg.properties.headers?.['x-retry-count'];
      const currentAttempt = Number(headerAttempt ?? payload.attempt) || 1;

      if (currentAttempt < maxRetries) {
        // Produce to durable retry queue with incremented header and stable idempotency key
        const nextAttempt = currentAttempt + 1;
        const retryMessage: RabbitMessage = {
          properties: {
            headers: { 'x-retry-count': nextAttempt }
          },
          content: JSON.stringify({
            ...payload,
            attempt: nextAttempt,
            idempotencyKey: payload.idempotencyKey || 'fallback-key'
          })
        };
        return { action: 'retry-exchange', nextMessage: retryMessage };
      } else {
        return { action: 'dlq' };
      }
    };

    const initialMessage: RabbitMessage = {
      properties: {},
      content: JSON.stringify({ clientId: 'c1', to: 'u1', text: 'hi', idempotencyKey: 'id-100' })
    };

    // Attempt 1 -> 2
    const step1 = processMessage(initialMessage);
    assert.strictEqual(step1.action, 'retry-exchange');
    const msg2 = step1.nextMessage!;
    assert.strictEqual(msg2.properties.headers?.['x-retry-count'], 2);
    assert.strictEqual(JSON.parse(msg2.content).idempotencyKey, 'id-100', 'idempotency key must remain strictly preserved');

    // Simulate process restart: new worker process picks up msg2 from RabbitMQ durable retry queue
    const step2 = processMessage(msg2);
    assert.strictEqual(step2.action, 'retry-exchange');
    const msg3 = step2.nextMessage!;
    assert.strictEqual(msg3.properties.headers?.['x-retry-count'], 3);
    assert.strictEqual(JSON.parse(msg3.content).idempotencyKey, 'id-100');

    // Attempt 3 reaches maxRetries -> routed to DLQ
    const step3 = processMessage(msg3);
    assert.strictEqual(step3.action, 'dlq', 'attempt 3 must exhaust retries and route directly to DLQ');
  });

  it('lease renewal loss cancels consumer, aborts pacer queue, and rejects in-flight work', async () => {
    let consumerCancelled = false;
    let disconnected = false;

    // Simulate pacer queue
    const pacerQueue: Array<{ id: string; reject: (err: any) => void }> = [];
    const pacerErrors: any[] = [];

    pacerQueue.push({
      id: 'job-1',
      reject: (err) => pacerErrors.push({ id: 'job-1', err: err.message })
    });
    pacerQueue.push({
      id: 'job-2',
      reject: (err) => pacerErrors.push({ id: 'job-2', err: err.message })
    });

    const mockChannel = {
      cancel: async (_tag: string) => {
        consumerCancelled = true;
      }
    };

    const mockClient = {
      disconnect: async () => {
        disconnected = true;
      }
    };

    // Trigger lease failure handler
    const onLeaseLoss = async (tag: string) => {
      // 1. Drain & abort pacer queue
      while (pacerQueue.length) {
        const item = pacerQueue.shift()!;
        item.reject(new Error('Lease lost'));
      }
      // 2. Disconnect provider
      await mockClient.disconnect();
      // 3. Cancel consumer
      await mockChannel.cancel(tag);
    };

    await onLeaseLoss('consumer-wa-42');

    assert.strictEqual(consumerCancelled, true, 'consumer must be cancelled on lease loss');
    assert.strictEqual(disconnected, true, 'provider client must be disconnected on lease loss');
    assert.strictEqual(pacerQueue.length, 0, 'pacer queue must be emptied');
    assert.strictEqual(pacerErrors.length, 2, 'all in-flight pacer jobs must be aborted');
    assert.strictEqual(pacerErrors[0].err, 'Lease lost');
  });

  it('aligns RabbitMQ worker runtime topology with infra/rabbitmq/definitions.json', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const candidatePaths = [
      path.join(process.cwd(), 'infra/rabbitmq/definitions.json'),
      path.join(process.cwd(), '../../infra/rabbitmq/definitions.json'),
      path.join(process.cwd(), '../infra/rabbitmq/definitions.json'),
    ];
    const defsPath = candidatePaths.find(p => fs.existsSync(p)) || candidatePaths[0];
    const defsRaw = fs.readFileSync(defsPath, 'utf8');
    const defs = JSON.parse(defsRaw);

    // 1. Verify Exchanges
    const exchangeNames = defs.exchanges.map((e: any) => e.name);
    assert.ok(exchangeNames.includes('tectobox.events'), 'tectobox.events exchange must be provisioned');
    assert.ok(exchangeNames.includes('tectobox.dlx'), 'tectobox.dlx exchange must be provisioned');
    assert.ok(exchangeNames.includes('tectobox.retry'), 'tectobox.retry exchange must be provisioned');

    // 2. Verify WhatsApp Queues and Arguments
    const waQueue = defs.queues.find((q: any) => q.name === 'message.outgoing.whatsapp');
    assert.ok(waQueue, 'message.outgoing.whatsapp must be declared');
    assert.strictEqual(waQueue.arguments['x-dead-letter-exchange'], 'tectobox.dlx');
    assert.strictEqual(waQueue.arguments['x-dead-letter-routing-key'], 'message.outgoing.whatsapp.dlq');

    const waRetryQueue = defs.queues.find((q: any) => q.name === 'message.outgoing.whatsapp.retry');
    assert.ok(waRetryQueue, 'message.outgoing.whatsapp.retry must be declared');
    assert.strictEqual(waRetryQueue.arguments['x-dead-letter-exchange'], 'tectobox.events');
    assert.strictEqual(waRetryQueue.arguments['x-dead-letter-routing-key'], 'message.outgoing.whatsapp');
    assert.strictEqual(waRetryQueue.arguments['x-message-ttl'], 5000);

    const waDlqQueue = defs.queues.find((q: any) => q.name === 'message.outgoing.whatsapp.dlq');
    assert.ok(waDlqQueue, 'message.outgoing.whatsapp.dlq must be declared');

    // 3. Verify Telegram Queues and Arguments
    const tgQueue = defs.queues.find((q: any) => q.name === 'message.outgoing.telegram');
    assert.ok(tgQueue, 'message.outgoing.telegram must be declared');
    assert.strictEqual(tgQueue.arguments['x-dead-letter-exchange'], 'tectobox.dlx');
    assert.strictEqual(tgQueue.arguments['x-dead-letter-routing-key'], 'message.outgoing.telegram.dlq');

    const tgRetryQueue = defs.queues.find((q: any) => q.name === 'message.outgoing.telegram.retry');
    assert.ok(tgRetryQueue, 'message.outgoing.telegram.retry must be declared');
    assert.strictEqual(tgRetryQueue.arguments['x-dead-letter-exchange'], 'tectobox.events');
    assert.strictEqual(tgRetryQueue.arguments['x-dead-letter-routing-key'], 'message.outgoing.telegram');
    assert.strictEqual(tgRetryQueue.arguments['x-message-ttl'], 5000);

    const tgDlqQueue = defs.queues.find((q: any) => q.name === 'message.outgoing.telegram.dlq');
    assert.ok(tgDlqQueue, 'message.outgoing.telegram.dlq must be declared');

    // 4. Verify Retry and DLQ Bindings
    const retryWaBinding = defs.bindings.find((b: any) =>
      b.source === 'tectobox.retry' &&
      b.destination === 'message.outgoing.whatsapp.retry' &&
      b.routing_key === 'message.outgoing.whatsapp'
    );
    assert.ok(retryWaBinding, 'tectobox.retry binding for WhatsApp retry queue must exist');

    const retryTgBinding = defs.bindings.find((b: any) =>
      b.source === 'tectobox.retry' &&
      b.destination === 'message.outgoing.telegram.retry' &&
      b.routing_key === 'message.outgoing.telegram'
    );
    assert.ok(retryTgBinding, 'tectobox.retry binding for Telegram retry queue must exist');

    const dlqWaBinding = defs.bindings.find((b: any) =>
      b.source === 'tectobox.dlx' &&
      b.destination === 'message.outgoing.whatsapp.dlq' &&
      b.routing_key === 'message.outgoing.whatsapp.dlq'
    );
    assert.ok(dlqWaBinding, 'tectobox.dlx binding for WhatsApp DLQ must exist');

    const dlqTgBinding = defs.bindings.find((b: any) =>
      b.source === 'tectobox.dlx' &&
      b.destination === 'message.outgoing.telegram.dlq' &&
      b.routing_key === 'message.outgoing.telegram.dlq'
    );
    assert.ok(dlqTgBinding, 'tectobox.dlx binding for Telegram DLQ must exist');

    // 5. Test runtime setupRetryTopology execution against definitions.json
    const { RabbitMQClient } = await import('@tectonic/messaging');

    const recordedExchanges: Array<{ name: string; type: string; options?: any }> = [];
    const recordedQueues: Array<{ name: string; options?: any }> = [];
    const recordedBindings: Array<{ queue: string; exchange: string; routingKey: string }> = [];

    const mockChannel = {
      assertExchange: async (name: string, type: string, options?: any) => {
        recordedExchanges.push({ name, type, options });
      },
      assertQueue: async (name: string, options?: any) => {
        recordedQueues.push({ name, options });
      },
      bindQueue: async (queue: string, exchange: string, routingKey: string) => {
        recordedBindings.push({ queue, exchange, routingKey });
      }
    };

    const client = new RabbitMQClient({ url: 'amqp://localhost', exchange: 'tectobox.events' });
    (client as any).channel = mockChannel;

    // Execute runtime setup helper for WhatsApp
    await client.setupRetryTopology('message.outgoing.whatsapp', 'message.outgoing.whatsapp');

    // Assert runtime calls match definitions.json for WhatsApp
    const runtimeWaQueue = recordedQueues.find(q => q.name === 'message.outgoing.whatsapp');
    assert.ok(runtimeWaQueue, 'runtime setup must assert message.outgoing.whatsapp');
    assert.deepStrictEqual(
      runtimeWaQueue.options?.arguments,
      waQueue.arguments,
      'runtime main queue arguments must match definitions.json'
    );

    const runtimeWaRetryQueue = recordedQueues.find(q => q.name === 'message.outgoing.whatsapp.retry');
    assert.ok(runtimeWaRetryQueue, 'runtime setup must assert message.outgoing.whatsapp.retry');
    assert.deepStrictEqual(
      runtimeWaRetryQueue.options?.arguments,
      waRetryQueue.arguments,
      'runtime retry queue arguments must match definitions.json'
    );

    const runtimeWaDlqBinding = recordedBindings.find(b => b.queue === 'message.outgoing.whatsapp.dlq');
    assert.ok(runtimeWaDlqBinding, 'runtime DLQ binding must be recorded');
    assert.strictEqual(runtimeWaDlqBinding.exchange, 'tectobox.dlx');
    assert.strictEqual(runtimeWaDlqBinding.routingKey, 'message.outgoing.whatsapp.dlq');

    // Clear and execute runtime setup helper for Telegram
    recordedExchanges.length = 0;
    recordedQueues.length = 0;
    recordedBindings.length = 0;

    await client.setupRetryTopology('message.outgoing.telegram', 'message.outgoing.telegram');

    const runtimeTgQueue = recordedQueues.find(q => q.name === 'message.outgoing.telegram');
    assert.ok(runtimeTgQueue, 'runtime setup must assert message.outgoing.telegram');
    assert.deepStrictEqual(
      runtimeTgQueue.options?.arguments,
      tgQueue.arguments,
      'runtime main queue arguments must match definitions.json'
    );

    const runtimeTgRetryQueue = recordedQueues.find(q => q.name === 'message.outgoing.telegram.retry');
    assert.ok(runtimeTgRetryQueue, 'runtime setup must assert message.outgoing.telegram.retry');
    assert.deepStrictEqual(
      runtimeTgRetryQueue.options?.arguments,
      tgRetryQueue.arguments,
      'runtime retry queue arguments must match definitions.json'
    );

    const runtimeTgDlqBinding = recordedBindings.find(b => b.queue === 'message.outgoing.telegram.dlq');
    assert.ok(runtimeTgDlqBinding, 'runtime DLQ binding must be recorded');
    assert.strictEqual(runtimeTgDlqBinding.exchange, 'tectobox.dlx');
    assert.strictEqual(runtimeTgDlqBinding.routingKey, 'message.outgoing.telegram.dlq');
  });
});
