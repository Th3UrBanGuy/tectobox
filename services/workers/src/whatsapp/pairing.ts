import {
  DEFAULT_SLOT,
  PAIRING_TTL_SECONDS,
  SSE_EVENT_TYPES,
  tenantEventsChannel,
  waPairingKey,
  waQrKey,
  whatsappSessionKey,
} from '@tectonic/contracts';
import * as path from 'path';
import * as fs from 'fs';

/**
 * WhatsApp phone-login (pairing code) flow — the phone branch of the
 * `channel.connect.whatsapp` consumer, extracted verbatim.
 *
 * Phase 2 of the modular restructure. The flow: wait for the Noise
 * handshake (the server emits the QR, stored at `wa:qr:`) before asking
 * Baileys for a code, format it `XXXX-XXXX`, store it at `wa:pairing:`
 * (EX 120) and publish the `pairing_code` SSE event. On failure, map the
 * raw error to a friendly `pairing_error` event and wipe the poisoned
 * session dir so the next tap starts clean.
 *
 * Behaviour, preserved exactly:
 * - handshake-wait polls the `wa:qr:` key every 500 ms up to
 *   `pairingWaitMs` (default 20000), aborting at once if the socket
 *   dies (the socket disappears from the `sockets` map);
 * - `requestPairingCode` gets the digits-only number;
 * - `/connection closed/i` maps to the friendly "number may not be on
 *   WhatsApp, or the country code is wrong" text (the raw text is still
 *   logged);
 * - on ANY worker-side pairing failure the socket is ended and the
 *   slot's session dir is wiped (a failed request saves `creds.me` +
 *   `pairingCode`, poisoning the next socket load);
 * - a PHONE-side rejection is NOT wiped here (known gap — the worker
 *   close path does not cover it either; separate fix).
 *
 * `whatsappSessionDir` is the single builder for the session-directory
 * layout (`SESSION_DIR/wa:<clientId>:<slot>`), previously constructed
 * in 3 places (socket creation, pairing wipe, disconnect wipe). It reads
 * `SESSION_DIR` at call time, as the originals did.
 */

/** Session directory for a WhatsApp slot (reads SESSION_DIR at call time). */
export function whatsappSessionDir(
  clientId: string | number,
  slot: string,
): string {
  const baseSessionDir =
    process.env.SESSION_DIR || path.join(process.cwd(), 'wa-auth');
  return path.join(baseSessionDir, whatsappSessionKey(clientId, slot));
}

export interface WhatsappPairingDeps {
  /** Live socket entry from `getSocketWithFencing`. */
  entry: { sock: any; token: number };
  /** The worker's live-sockets map (same instance — the wait loop watches it). */
  sockets: Map<string, { sock: any; token: number }>;
  redis: any;
  coordinator: any;
  clientId: string | number;
  slot: string;
  phoneNumber: string;
  /** Max ms to wait for the Noise handshake before requesting a code (default 20000). */
  pairingWaitMs?: number;
}

export async function requestWhatsappPairingCode(
  deps: WhatsappPairingDeps,
): Promise<void> {
  const {
    entry,
    sockets,
    redis,
    coordinator,
    clientId,
    slot,
    phoneNumber,
  } = deps;
  const effSlot = slot || DEFAULT_SLOT;

  try {
    if (typeof entry.sock.requestPairingCode !== 'function') {
      throw new Error('This WhatsApp version does not support pairing codes');
    }
    // Baileys requestPairingCode sends the pairing stanza immediately —
    // it does NOT wait for the Noise handshake. Called right after
    // makeWASocket, it corrupts the handshake and the server drops the
    // connection ("Connection Failure" at noise-handler decodeFrame).
    // The handshake is done once the server emits the QR, so wait for
    // the wa:qr key (the same key the QR modal polls) before asking for
    // the code. If the socket dies mid-wait, stop at once instead of
    // burning the whole window on a dead connection.
    const waitMs = deps.pairingWaitMs ?? 20000;
    const startedAt = Date.now();
    const sockKey = whatsappSessionKey(clientId, effSlot);
    let qrSeen = !!(await redis.get(waQrKey(clientId, effSlot)).catch(() => null));
    let sockDead = false;
    while (!qrSeen && Date.now() - startedAt < waitMs) {
      await new Promise((r) => setTimeout(r, 500));
      if (!sockets.has(sockKey)) {
        sockDead = true;
        break;
      }
      qrSeen = !!(await redis.get(waQrKey(clientId, effSlot)).catch(() => null));
    }
    if (sockDead) {
      throw new Error(
        'WhatsApp closed the connection — tap "Request a new code" to try again.',
      );
    }
    if (!qrSeen) {
      throw new Error(
        'WhatsApp did not answer in time — tap "Request a new code" to try again.',
      );
    }
    const raw = String(
      await entry.sock.requestPairingCode(
        String(phoneNumber).replace(/[^0-9]/g, ''),
      ),
    );
    const code = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const shown = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    await redis.set(waPairingKey(clientId, effSlot), shown, 'EX', PAIRING_TTL_SECONDS);
    await coordinator.publishEvent(tenantEventsChannel(clientId), {
      type: SSE_EVENT_TYPES.PAIRING_CODE,
      clientId: Number(clientId),
      channel: 'whatsapp',
      slot: effSlot,
      code: shown,
    });
    console.log(`[whatsapp] pairing code issued for ${clientId}:${effSlot}`);
  } catch (e: any) {
    const raw = e.message || 'Could not request a pairing code';
    // Baileys drops the socket ("Connection Closed") when the number is
    // not on WhatsApp or not in international format. The raw text tells
    // the user nothing, so translate it.
    const friendly = /connection closed/i.test(raw)
      ? 'WhatsApp closed the connection — this number may not be on WhatsApp, or the country code is wrong. Check the number and try again.'
      : raw;
    console.warn(
      `[whatsapp] pairing code failed for ${clientId}:${effSlot}:`,
      raw,
    );
    await coordinator.publishEvent(tenantEventsChannel(clientId), {
      type: SSE_EVENT_TYPES.PAIRING_ERROR,
      clientId: Number(clientId),
      channel: 'whatsapp',
      slot: effSlot,
      error: friendly,
    });
    // The failed request poisoned the saved session: Baileys stores the
    // half-registered identity (creds.me + pairingCode) before sending,
    // so the next socket load skips the QR flow and the server rejects
    // it as logged out — no QR ever arrives and every retry times out.
    // End the socket and wipe the slot's session dir so the next tap
    // starts clean. Nothing was paired, so nothing is lost.
    try {
      entry.sock.end?.(new Error('pairing failed, resetting session'));
    } catch {}
    try {
      await fs.promises.rm(whatsappSessionDir(clientId, effSlot), {
        recursive: true,
        force: true,
      });
    } catch {}
  }
}
