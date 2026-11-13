import { RabbitMQClient } from '@tectonic/messaging';
import {
  getAIResponse,
  demoResponder,
  detectCustomerLanguage,
  languageDirective,
  buildSystemPrompt,
  queryGoAIEngine,
} from './router.ts';

export function getPrefetchLimit(): number {
  const envVal = process.env.AI_PREFETCH;
  if (envVal !== undefined && envVal.trim() !== '') {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 10;
}

export async function startAIWorker() {
  const mq = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/',
    exchange: 'tectobox.events'
  });
  await mq.connect();

  const channel = mq.getChannel();
  if (channel) {
    const prefetch = getPrefetchLimit();
    await channel.prefetch(prefetch);
    await channel.assertQueue('ai.requests', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'tectobox.dlx',
        'x-dead-letter-routing-key': 'ai.requests.dlq'
      }
    });
    await channel.bindQueue('ai.requests', 'tectobox.events', 'ai.request.#');
    
    channel.consume('ai.requests', async (msg) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[ai-worker] malformed JSON payload, sending to DLQ:', err);
        channel.nack(msg, false, false);
        return;
      }

      const { platform, clientId, slot, to, text, systemPrompt } = payload || {};
      if (!platform || !clientId || !to || !text) {
        console.warn('[ai-worker] missing required fields, sending to DLQ:', payload);
        channel.nack(msg, false, false);
        return;
      }

      try {
        let replyText: string | null = null;
        const goRes = await queryGoAIEngine({
          clientId,
          clientName: payload.clientName,
          businessType: payload.businessType,
          text,
          history: payload.history,
          products: payload.products,
          knowledge: payload.knowledge,
        });

        if (goRes && goRes.reply) {
          replyText = goRes.reply;
        } else {
          const lang = detectCustomerLanguage(text);
          const langDir = languageDirective(lang);
          const sysPrompt = systemPrompt || buildSystemPrompt({
            clientName: payload.clientName,
            businessType: payload.businessType,
            products: payload.products,
            knowledge: payload.knowledge,
          }, langDir);

          const historyMessages: any[] = Array.isArray(payload.history)
            ? payload.history.map((h: any) => ({
                role: h.role === 'assistant' ? 'assistant' : 'user',
                content: String(h.content || ''),
              }))
            : [];

          replyText = await getAIResponse([
            { role: 'system', content: sysPrompt },
            ...historyMessages,
            { role: 'user', content: text }
          ], `ai:${clientId}`);

          if (!replyText || replyText.trim().length === 0) {
            replyText = demoResponder(clientId, text, payload.products || [], payload.history || [], payload.knowledge || []);
          }
        }

        const validPlatforms = ['whatsapp', 'telegram', 'meta', 'webchat'];
        const normalizedPlatform = validPlatforms.includes(platform) ? platform : 'whatsapp';

        await mq.publish(`message.outgoing.${normalizedPlatform}`, {
          clientId,
          slot,
          to,
          conversationId: payload.conversationId,
          text: replyText
        });

        channel.ack(msg);
      } catch (err) {
        console.error('[ai-worker] processing error:', err);
        channel.nack(msg, false, false); // DLQ on unrecoverable processing error
      }
    });
  }

  console.log('[ai-worker] started with Gemini Web2API and Cloudflare model support');
}
