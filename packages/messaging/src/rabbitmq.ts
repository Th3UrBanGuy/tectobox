import * as amqplib from 'amqplib';

export interface RabbitMQConfig {
  url: string;
  exchange: string;
}

export class RabbitMQClient {
  private conn: any = null;
  private channel: amqplib.ConfirmChannel | null = null;
  private config: RabbitMQConfig;
  
  constructor(config: RabbitMQConfig) {
    this.config = config;
  }

  async connect() {
    this.conn = await amqplib.connect(this.config.url);
    this.conn.on('error', (err: any) => {
      console.warn('[rabbitmq] Connection error:', err?.message || err);
    });
    this.conn.on('close', () => {
      console.warn('[rabbitmq] Connection closed');
    });
    this.channel = await this.conn.createConfirmChannel();
    this.channel?.on('error', (err: any) => {
      console.warn('[rabbitmq] Channel error:', err?.message || err);
    });
    this.channel?.on('close', () => {
      console.warn('[rabbitmq] Channel closed');
    });
  }

  /**
   * Set up durable dead-letter and retry exchange/queue topologies for broker-managed retries.
   * Messages routed to retryExchange with a TTL will automatically dead-letter back to main exchange
   * after ttlMs expires, surviving process restarts.
   */
  async setupRetryTopology(
    mainQueue: string,
    routingKey: string,
    options?: {
      dlxExchange?: string;
      dlqQueue?: string;
      dlqRoutingKey?: string;
      retryExchange?: string;
      retryQueue?: string;
      retryTtlMs?: number;
    }
  ): Promise<void> {
    if (!this.channel) throw new Error("Not connected");
    const dlx = options?.dlxExchange || 'tectobox.dlx';
    const dlq = options?.dlqQueue || `${mainQueue}.dlq`;
    const dlqRoutingKey = options?.dlqRoutingKey || `${routingKey}.dlq`;
    const retryExchange = options?.retryExchange || 'tectobox.retry';
    const retryQueue = options?.retryQueue || `${mainQueue}.retry`;
    const retryTtl = options?.retryTtlMs ?? 5000;

    // 1. Assert DLX and DLQ
    await this.channel.assertExchange(dlx, 'direct', { durable: true });
    await this.channel.assertQueue(dlq, { durable: true });
    await this.channel.bindQueue(dlq, dlx, dlqRoutingKey);

    // 2. Assert retry exchange and retry queue with DLX pointing back to main exchange
    await this.channel.assertExchange(retryExchange, 'direct', { durable: true });
    await this.channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': retryTtl,
        'x-dead-letter-exchange': this.config.exchange,
        'x-dead-letter-routing-key': routingKey,
      }
    });
    await this.channel.bindQueue(retryQueue, retryExchange, routingKey);

    // 3. Assert main queue with dead-letter pointing to DLX with .dlq routing key
    await this.channel.assertQueue(mainQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': dlx,
        'x-dead-letter-routing-key': dlqRoutingKey,
      }
    });
    await this.channel.bindQueue(mainQueue, this.config.exchange, routingKey);
  }

  async publish(
    routingKey: string,
    payload: any,
    options?: {
      mandatory?: boolean;
      headers?: Record<string, any>;
      expiration?: string | number;
      exchange?: string;
    }
  ): Promise<void> {
    if (!this.channel) throw new Error("Not connected");
    const targetExchange = options?.exchange || this.config.exchange;
    const isMandatory = options?.mandatory ?? true;
    
    return new Promise((resolve, reject) => {
      const content = Buffer.from(JSON.stringify(payload));

      let returned = false;
      const onReturn = (returnMsg: amqplib.ConsumeMessage) => {
        // Check if this return pertains to our message
        returned = true;
      };

      if (isMandatory) {
        this.channel!.once('return', onReturn);
      }

      this.channel!.publish(
        targetExchange,
        routingKey,
        content,
        {
          persistent: true,
          mandatory: isMandatory,
          headers: options?.headers,
          expiration: options?.expiration ? String(options.expiration) : undefined,
        },
        (err) => {
          if (isMandatory) {
            this.channel!.removeListener('return', onReturn);
          }
          if (err) return reject(err);
          if (returned) {
            return reject(new Error(`Message was unroutable (returned by broker) for routingKey: ${routingKey}`));
          }
          resolve();
        }
      );
    });
  }

  async close() {
    if (this.channel) await this.channel.close();
    if (this.conn) await this.conn.close();
  }

  getChannel(): amqplib.ConfirmChannel | null {
    return this.channel;
  }
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((res) => setTimeout(res, Math.min(delay, 30000)));
    }
  }
}
