import { EventEmitter } from 'events';

export interface BrokerReconnectOptions {
  startupTimeoutMs?: number;
  initialReconnectMs?: number;
  maxReconnectMs?: number;
}

export interface ReconnectState {
  isClosed: boolean;
  isConnected: boolean;
  isReconnecting: boolean;
  reconnectAttempts: number;
}

/**
 * Shared Broker Reconnect & Topology Restoration Helper for workers.
 *
 * Provides:
 * 1. Bounded startup retry with fail-fast exit on boot.
 * 2. Exponential backoff on disconnect (~1s start, ~30s cap).
 * 3. Automatic re-creation of channel, re-assertion of topologies/exchanges/queues,
 *    and re-registration of consumer callbacks.
 */
export async function connectBroker(mq: any, options: BrokerReconnectOptions = {}): Promise<void> {
  const startupTimeoutMs =
    options.startupTimeoutMs !== undefined
      ? options.startupTimeoutMs
      : Number(process.env.BROKER_STARTUP_TIMEOUT_MS || process.env.RABBITMQ_STARTUP_TIMEOUT_MS) || 60000;

  const initialReconnectMs =
    options.initialReconnectMs !== undefined
      ? options.initialReconnectMs
      : Number(process.env.BROKER_RECONNECT_INITIAL_MS || process.env.RABBITMQ_RECONNECT_INITIAL_MS) || 1000;

  const maxReconnectMs =
    options.maxReconnectMs !== undefined
      ? options.maxReconnectMs
      : Number(process.env.BROKER_RECONNECT_MAX_MS || process.env.RABBITMQ_RECONNECT_MAX_MS) || 30000;

  let isClosed = false;
  let isConnected = false;
  let isReconnecting = false;
  let reconnectAttempts = 0;

  // Stored declarations to replay on reconnect
  let savedPrefetch: number | null = null;
  const savedExchanges = new Map<string, { type: string; options?: any }>();
  const savedQueues = new Map<string, any>();
  const savedBindings = new Map<string, { queue: string; exchange: string; routingKey: string; args?: any }>();
  const savedConsumers = new Map<string, { queue: string; callback: Function; options?: any }>();
  const savedRetryTopologies = new Map<string, { mainQueue: string; routingKey: string; options?: any }>();

  // 1. Initial bounded connection attempt
  const startTime = Date.now();
  let attempt = 0;

  while (!isConnected && !isClosed) {
    attempt++;
    try {
      await mq.connect();
      isConnected = true;
      break;
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= startupTimeoutMs) {
        console.error(
          `[broker] Fatal: RabbitMQ broker unreachable after ${elapsed}ms (${attempt} attempts, limit ${startupTimeoutMs}ms): ${err?.message || err}. Exiting non-zero.`
        );
        process.exit(1);
        return;
      }
      const backoff = Math.min(500 * Math.pow(1.5, attempt - 1), 3000);
      const remaining = startupTimeoutMs - elapsed;
      const waitTime = Math.min(backoff, remaining);
      console.warn(
        `[broker] Connection attempt ${attempt} failed (${err?.message || err}), retrying in ${waitTime}ms (elapsed: ${elapsed}ms, limit: ${startupTimeoutMs}ms)...`
      );
      await new Promise((r) => setTimeout(r, waitTime));
    }
  }

  // 2. Reconnect loop
  async function triggerReconnect(): Promise<void> {
    if (isClosed || isReconnecting) return;
    isReconnecting = true;
    isConnected = false;

    let delay = initialReconnectMs;

    while (!isConnected && !isClosed) {
      reconnectAttempts++;
      console.log(`[broker] Attempting reconnect (attempt ${reconnectAttempts}) in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      if (isClosed) break;

      try {
        await mq.connect();
        isConnected = true;
        isReconnecting = false;
        console.log(`[broker] Reconnected to broker successfully after ${reconnectAttempts} attempts`);

        // Re-apply topologies on the new channel
        const ch = mq.getChannel();
        if (ch) {
          // Re-apply prefetch
          if (savedPrefetch !== null && typeof ch.prefetch === 'function') {
            await ch.prefetch(savedPrefetch);
          }

          // Re-apply exchanges
          for (const [name, ex] of savedExchanges.entries()) {
            if (typeof ch.assertExchange === 'function') {
              await ch.assertExchange(name, ex.type, ex.options);
            }
          }

          // Re-apply queues
          for (const [qName, qOpts] of savedQueues.entries()) {
            if (typeof ch.assertQueue === 'function') {
              await ch.assertQueue(qName, qOpts);
            }
          }

          // Re-apply bindings
          for (const binding of savedBindings.values()) {
            if (typeof ch.bindQueue === 'function') {
              await ch.bindQueue(binding.queue, binding.exchange, binding.routingKey, binding.args);
            }
          }

          // Re-apply retry topologies
          for (const top of savedRetryTopologies.values()) {
            if (typeof mq.setupRetryTopology === 'function') {
              await mq.setupRetryTopology(top.mainQueue, top.routingKey, top.options);
            }
          }

          // Re-apply consumers
          for (const consumer of savedConsumers.values()) {
            if (typeof ch.consume === 'function') {
              await ch.consume(consumer.queue, consumer.callback, consumer.options);
            }
          }
        }

        attachListeners();
        return;
      } catch (err: any) {
        console.warn(`[broker] Reconnect attempt ${reconnectAttempts} failed: ${err?.message || err}`);
        delay = Math.min(delay * 2, maxReconnectMs);
      }
    }
    isReconnecting = false;
  }

  // 3. Attach listeners to current connection & channel
  function attachListeners() {
    const conn = mq.conn;
    const ch = mq.channel || (mq.getChannel && mq.getChannel());

    const handleDisconnect = (reason: string) => {
      if (isClosed) return;
      if (!isConnected && isReconnecting) return;
      console.warn(`[broker] Disconnect detected (${reason}), triggering reconnect...`);
      isConnected = false;
      triggerReconnect().catch((err) => {
        console.error('[broker] Error in reconnect loop:', err);
      });
    };

    if (conn && typeof conn.on === 'function') {
      conn.on('close', () => handleDisconnect('connection closed'));
      conn.on('error', (err: any) => handleDisconnect(`connection error: ${err?.message || err}`));
    }
    if (ch && typeof ch.on === 'function') {
      ch.on('close', () => handleDisconnect('channel closed'));
      ch.on('error', (err: any) => handleDisconnect(`channel error: ${err?.message || err}`));
    }
  }

  // 4. Wrap mq.setupRetryTopology to record calls
  const originalSetupRetry = typeof mq.setupRetryTopology === 'function' ? mq.setupRetryTopology.bind(mq) : null;
  if (originalSetupRetry) {
    mq.setupRetryTopology = async function (mainQueue: string, routingKey: string, opts?: any) {
      savedRetryTopologies.set(`${mainQueue}:${routingKey}`, { mainQueue, routingKey, options: opts });
      return originalSetupRetry(mainQueue, routingKey, opts);
    };
  }

  // 5. Wrap mq.close to cleanly shut down
  const originalClose = typeof mq.close === 'function' ? mq.close.bind(mq) : null;
  if (originalClose) {
    mq.close = async function () {
      isClosed = true;
      return originalClose();
    };
  }

  // 6. Proxy channel to record declarations and forward to live channel
  const originalGetChannel = mq.getChannel.bind(mq);
  let channelProxy: any = null;

  function createChannelProxy() {
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          const currentCh = originalGetChannel();

          if (prop === 'prefetch') {
            return async (count: number) => {
              savedPrefetch = count;
              if (currentCh && typeof currentCh.prefetch === 'function') {
                return currentCh.prefetch(count);
              }
            };
          }

          if (prop === 'assertQueue') {
            return async (name: string, opts?: any) => {
              savedQueues.set(name, opts);
              if (currentCh && typeof currentCh.assertQueue === 'function') {
                return currentCh.assertQueue(name, opts);
              }
              return { queue: name };
            };
          }

          if (prop === 'assertExchange') {
            return async (name: string, type: string, opts?: any) => {
              savedExchanges.set(name, { type, options: opts });
              if (currentCh && typeof currentCh.assertExchange === 'function') {
                return currentCh.assertExchange(name, type, opts);
              }
            };
          }

          if (prop === 'bindQueue') {
            return async (queue: string, exchange: string, routingKey: string, args?: any) => {
              savedBindings.set(`${queue}:${exchange}:${routingKey}`, {
                queue,
                exchange,
                routingKey,
                args,
              });
              if (currentCh && typeof currentCh.bindQueue === 'function') {
                return currentCh.bindQueue(queue, exchange, routingKey, args);
              }
            };
          }

          if (prop === 'consume') {
            return async (queue: string, callback: Function, opts?: any) => {
              savedConsumers.set(queue, { queue, callback, options: opts });
              if (currentCh && typeof currentCh.consume === 'function') {
                return currentCh.consume(queue, callback, opts);
              }
              return { consumerTag: `tag-${queue}` };
            };
          }

          if (currentCh && prop in currentCh) {
            const val = currentCh[prop];
            return typeof val === 'function' ? val.bind(currentCh) : val;
          }

          return undefined;
        },
      }
    );
  }

  mq.getChannel = () => {
    const raw = originalGetChannel();
    if (!raw && !isReconnecting) return null;
    if (!channelProxy) {
      channelProxy = createChannelProxy();
    }
    return channelProxy;
  };

  attachListeners();
}
