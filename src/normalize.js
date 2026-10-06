// Normalizer: converts raw platform payloads into one common shape:
//   { platform, platformUserId, customerName, text, externalId }  (or null when not a text message)
// externalId is the platform's native message id — used for webhook idempotency
// (Meta/Telegram redeliver webhooks on retry; we must never process twice).
function normalizeMessage(platform, raw) {
  switch (platform) {
    case 'messenger':
    case 'instagram': {
      // raw is a single Meta "messaging" event:
      // { sender:{id}, recipient:{id}, timestamp, message:{mid, text} }
      // Instagram events arrive in the same shape via the Instagram webhook topic.
      if (!raw || !raw.message || typeof raw.message.text !== 'string') return null;
      if (raw.message.is_echo) return null; // our own outgoing echo — ignore
      return {
        platform,
        platformUserId: String(raw.sender && raw.sender.id),
        customerName: null, // PSID/IGSID only; name resolved via Graph API when a token is set
        text: raw.message.text,
        externalId: raw.message.mid ? String(raw.message.mid) : null,
      };
    }
    case 'telegram': {
      // raw is a Telegram Bot API update.message object, or the gramjs shape
      // built in src/connectors.js (which may carry group fields).
      if (!raw || typeof raw.text !== 'string') return null;
      const from = raw.from || {};
      const chat = raw.chat || {};
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ')
        || (from.username ? '@' + from.username : 'Telegram user');
      const isGroup = chat.type === 'group';
      return {
        platform: 'telegram',
        platformUserId: String(chat.id != null ? chat.id : from.id),
        customerName: isGroup ? (chat.title || 'Telegram group') : name,
        senderName: name,
        text: raw.text,
        externalId: raw.message_id != null ? String(raw.message_id) : null,
        // Group-engagement fields (gramjs path only; undefined for Bot API DMs).
        isGroup,
        groupTitle: chat.title || null,
        mentioned: !!raw.mentioned,
        replyToMsgId: raw.replyToMsgId != null ? raw.replyToMsgId : null,
        groupHistory: Array.isArray(raw.groupHistory) ? raw.groupHistory : null,
      };
    }
    case 'whatsapp': {
      // WhatsApp message object: Cloud API shape OR OpenWA shape
      // { type:'text', from, text:{body}, senderName? }
      if (!raw || raw.type !== 'text' || !raw.text || typeof raw.text.body !== 'string') return null;
      return {
        platform: 'whatsapp',
        platformUserId: String(raw.from),
        customerName: raw.senderName || null,
        text: raw.text.body,
        externalId: raw.id ? String(raw.id) : null,
      };
    }
    case 'webchat': {
      // Website widget: { visitor_id, name?, text, message_id?, page_url?, page_title? }
      if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return null;
      if (!raw.visitor_id) return null;
      return {
        platform: 'webchat',
        platformUserId: String(raw.visitor_id),
        customerName: raw.name || null,
        text: raw.text,
        externalId: raw.message_id ? String(raw.message_id) : null,
      };
    }
    default:
      return null;
  }
}

module.exports = { normalizeMessage };
