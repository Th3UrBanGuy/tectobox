import {
  DEFAULT_SLOT,
  SSE_EVENT_TYPES,
  TELEGRAM_CODE_TTL_SECONDS,
  tenantEventsChannel,
  tgCodeHashKey,
  tgCodeSentKey,
  tgPhoneKey,
  tgQrKey,
  tgSessionKey,
  telegramSessionKey,
} from '@tectonic/contracts';
import type { ChannelStatusPublisher } from '../shared/channel-status.ts';

/**
 * Telegram phone login — step 1 (`sendCode`, from the
 * `channel.connect.telegram` consumer) and step 2 (sign-in + 2FA, from
 * the `channel.signin.telegram` consumer), extracted verbatim.
 *
 * Phase 2 of the modular restructure. The code itself is typed by the
 * user in the app; the worker only sends it (`sendCode` → `tg:codehash` /
 * `tg:phone` / `tg:codesent`, EX 300, + SSE `tg_code_sent`) and finishes
 * the login (`signInUser` → save session → clear the code keys → publish
 * `connected`). 2FA is handled inline: `SESSION_PASSWORD_NEEDED` with a
 * password signs in with the password; without one the frontend is asked
 * for it via SSE `tg_password_needed`.
 *
 * Behaviour, preserved exactly:
 * - the phone branch connects with `{ autoLogin: 'none' }` — starting
 *   the QR flow there would fight the code flow;
 * - an already-authorized saved session publishes `connected` via the
 *   `isAuth` branch of `getClientWithFencing` (this module does not
 *   publish it again);
 * - error mapping: `FLOOD_WAIT_n` → "Too many tries — wait Ns and try
 *   again.", `PHONE_NUMBER_INVALID` → "That phone number is not a
 *   Telegram number.", otherwise the raw error text;
 * - sign-in errors: `PHONE_CODE_INVALID` → "Wrong code — check the code
 *   Telegram sent and try again.", `PHONE_CODE_EXPIRED` → "That code
 *   expired — request a new one from Connect.", a wrong 2FA password →
 *   "Wrong 2FA password — try again.", anything else → the raw text;
 * - a missing live session or missing code hash / phone number reports
 *   "This login session expired — start again from Connect." /
 *   "The code expired — request a new one from Connect.";
 * - `finishLogin` saves the session string, deletes `tg:qr` /
 *   `tg:codehash` / `tg:phone` / `tg:codesent`, and publishes
 *   `connected` (SSE + MQ) — via the shared channel-status publisher.
 *
 * The `getClient` callback is the worker's `getClientWithFencing`
 * (passed in — the session lifecycle stays in the worker, built on the
 * shared `FencedSessionRegistry`); the `sessions` map is the registry's
 * underlying map (same instance the worker was built with).
 */

export interface TelegramPhoneLoginDeps {
  /** The worker's `getClientWithFencing`. */
  getClient: (
    clientId: string,
    sessionStringOrSlot?: string,
    explicitSlot?: string,
    opts?: { autoLogin?: 'qr' | 'none' },
  ) => Promise<{ client: any; token: number } | null>;
  redis: any;
  coordinator: any;
  publishChannelStatus: ChannelStatusPublisher;
}

/** Step 1: connect without the QR flow, ask Telegram to text the code. */
export async function requestTelegramLoginCode(
  deps: TelegramPhoneLoginDeps & {
    clientId: string | number;
    slot: string;
    phoneNumber: string;
  },
): Promise<void> {
  const { getClient, redis, coordinator, publishChannelStatus } = deps;
  const { clientId, phoneNumber } = deps;
  const effectiveSlot = deps.slot || DEFAULT_SLOT;

  // Phone login: connect the client WITHOUT starting the QR flow, then
  // ask Telegram to text the login code to this number. The code itself
  // is typed by the user in the app (signin consumer).
  const entry = await getClient(String(clientId), effectiveSlot, undefined, {
    autoLogin: 'none',
  });
  if (!entry) {
    console.warn(
      `[telegram] phone connect ${clientId}:${effectiveSlot} could not acquire lease`,
    );
    return;
  }
  const alreadyAuth =
    typeof (entry.client as any).checkAuthorization === 'function'
      ? await (entry.client as any).checkAuthorization().catch(() => false)
      : false;
  if (alreadyAuth) {
    // Saved session is alive — getClientWithFencing already published
    // 'connected' via its isAuth branch.
    console.log(
      `[telegram] phone connect ${clientId}:${effectiveSlot} already authorized`,
    );
    return;
  }
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  try {
    const sent: any = await (entry.client as any).sendCode(
      { apiId, apiHash },
      String(phoneNumber).replace(/[^0-9]/g, ''),
    );
    const phoneCodeHash = sent?.phoneCodeHash || sent?.phone_code_hash || '';
    if (!phoneCodeHash) throw new Error('Telegram did not return a code hash');
    await redis.set(
      tgCodeHashKey(clientId, effectiveSlot),
      phoneCodeHash,
      'EX',
      TELEGRAM_CODE_TTL_SECONDS,
    );
    await redis.set(
      tgPhoneKey(clientId, effectiveSlot),
      String(phoneNumber).replace(/[^0-9]/g, ''),
      'EX',
      TELEGRAM_CODE_TTL_SECONDS,
    );
    await redis.set(
      tgCodeSentKey(clientId, effectiveSlot),
      '1',
      'EX',
      TELEGRAM_CODE_TTL_SECONDS,
    );
    await coordinator.publishEvent(tenantEventsChannel(clientId), {
      type: SSE_EVENT_TYPES.TG_CODE_SENT,
      clientId: Number(clientId),
      channel: 'telegram',
      slot: effectiveSlot,
    });
    console.log(`[telegram] login code sent to ${clientId}:${effectiveSlot}`);
  } catch (e: any) {
    const raw = String(e?.errorMessage || e?.message || 'Could not send the code');
    const flood = raw.match(/FLOOD_WAIT_(\d+)/);
    const friendly = flood
      ? `Too many tries — wait ${flood[1]}s and try again.`
      : /PHONE_NUMBER_INVALID/.test(raw)
        ? 'That phone number is not a Telegram number.'
        : raw;
    console.warn(`[telegram] sendCode failed for ${clientId}:${effectiveSlot}:`, raw);
    await coordinator.publishEvent(tenantEventsChannel(clientId), {
      type: SSE_EVENT_TYPES.TG_CODE_ERROR,
      clientId: Number(clientId),
      channel: 'telegram',
      slot: effectiveSlot,
      error: friendly,
    });
  }
}

/** Step 2: finish the login with the typed code (+ 2FA password if needed). */
export async function handleTelegramSignin(
  deps: TelegramPhoneLoginDeps & {
    /** The worker's live-sessions map (the registry's underlying map). */
    sessions: Map<string, { client: any; token: number }>;
    clientId: string | number;
    slot: string;
    phoneCode: string | number;
    password?: string;
  },
): Promise<void> {
  const { sessions, redis, coordinator, publishChannelStatus } = deps;
  const { clientId, phoneCode, password } = deps;
  const effectiveSlot = deps.slot || DEFAULT_SLOT;

  const sendError = async (error: string) => {
    await coordinator.publishEvent(tenantEventsChannel(clientId), {
      type: SSE_EVENT_TYPES.TG_CODE_ERROR,
      clientId: Number(clientId),
      channel: 'telegram',
      slot: effectiveSlot,
      error,
    });
  };

  const entry = sessions.get(telegramSessionKey(clientId, effectiveSlot));
  if (!entry) {
    await sendError('This login session expired — start again from Connect.');
    return;
  }
  const phoneCodeHash = await redis.get(tgCodeHashKey(clientId, effectiveSlot));
  const phoneNumber = await redis.get(tgPhoneKey(clientId, effectiveSlot));
  if (!phoneCodeHash || !phoneNumber) {
    await sendError('The code expired — request a new one from Connect.');
    return;
  }

  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const finishLogin = async () => {
    const savedStr =
      typeof (entry.client.session as any)?.save === 'function'
        ? (entry.client.session as any).save()
        : '';
    if (savedStr) {
      await redis.set(tgSessionKey(clientId, effectiveSlot), savedStr);
    }
    await redis.del(tgQrKey(clientId, effectiveSlot)).catch(() => {});
    await redis.del(tgCodeHashKey(clientId, effectiveSlot)).catch(() => {});
    await redis.del(tgPhoneKey(clientId, effectiveSlot)).catch(() => {});
    await redis.del(tgCodeSentKey(clientId, effectiveSlot)).catch(() => {});
    await publishChannelStatus(String(clientId), effectiveSlot, 'connected');
    console.log(`[telegram] phone login succeeded for ${clientId}:${effectiveSlot}`);
  };

  try {
    await (entry.client as any).signInUser(
      { apiId, apiHash },
      { phoneNumber, phoneCodeHash, phoneCode: String(phoneCode) },
    );
    await finishLogin();
  } catch (e: any) {
    const raw = String(e?.errorMessage || e?.message || '');
    if (/SESSION_PASSWORD_NEEDED|PASSWORD_REQUIRED|2FA/i.test(raw)) {
      if (password) {
        try {
          await (entry.client as any).signInUserWithPassword(
            { apiId, apiHash },
            { password: String(password) },
          );
          await finishLogin();
        } catch (e2: any) {
          await sendError('Wrong 2FA password — try again.');
        }
      } else {
        await coordinator.publishEvent(tenantEventsChannel(clientId), {
          type: SSE_EVENT_TYPES.TG_PASSWORD_NEEDED,
          clientId: Number(clientId),
          channel: 'telegram',
          slot: effectiveSlot,
        });
      }
    } else if (/PHONE_CODE_INVALID/.test(raw)) {
      await sendError('Wrong code — check the code Telegram sent and try again.');
    } else if (/PHONE_CODE_EXPIRED/.test(raw)) {
      await sendError('That code expired — request a new one from Connect.');
    } else {
      await sendError(raw || 'Sign-in failed — try again.');
    }
  }
}
