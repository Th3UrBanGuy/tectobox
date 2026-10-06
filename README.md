---
title: Tectonic Inbox
emoji: 📥
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
---

# Tectonic Inbox v2

Multi-tenant **social-commerce SaaS** for Tectonic: one platform, many
businesses. Each client gets an isolated workspace with a unified inbox
(WhatsApp, Telegram, Messenger, Instagram), product catalog, lead pipeline,
knowledge rack, QR-code connector setup, and a configurable AI sales bot.

Everything runs in **demo mode** out of the box — no API tokens needed. Connect
a channel from the **Connectors** tab and it flips to live automatically.

## Quickstart

```bash
npm install
npm start
# open http://localhost:3120
```

On first start the app seeds two demo clients — **Demo Fashion Store**
(physical) and **Demo Digital Services** (digital) — plus a catalog, 7
conversations, 2 orders, knowledge entries and sample leads. The SQLite file
`tectonic-inbox.db` is created next to `server.js` (override with `DB_PATH`).

> **Note — `bin/zstd`:** `@open-wa/wa-automate` pulls in `simple-zstd`, which
> shells out to the `zstd` CLI. This VM cannot install the real binary, so the
> project ships a pass-through shim at `bin/zstd` (bytes go through
> uncompressed; session data stays valid). `server.js` puts `bin/` on `PATH`
> automatically. If a real `zstd` is ever installed, put it earlier on `PATH`.

## What you get

- **Super Admin panel** — cards per client (chats, orders, revenue, connector
  states), global stats, client CRUD (name, physical/digital, per-field
  required toggles for the lead fields the AI collects).
- **Client workspace** — top switcher + per-client sub-nav:
  - **Inbox** — the v1 three-column UI (platform chips, searchable list, chat
    thread, Customer / Products / New Order tabs), scoped to the client.
  - **Leads** — pipeline table (`lead` → `user` → `confirmed`), filterable by
    status, click a row to jump to the chat, manual edit + status change.
  - **Knowledge** — the "rack": policies, shipping info, FAQs. Every entry is
    injected into that client's AI system prompt.
  - **Connectors** — per-channel status, QR connect, webhook URLs.
- **AI sales bot** — one lightweight OpenAI-compatible call per inbound
  message (see *AI engine* below). The system prompt is built per client from
  business name/type, catalog, knowledge base and lead-field config. The model
  returns JSON `{reply, lead, order}`: it answers from the catalog only,
  collects lead fields conversationally (Bangla/English mix), summarizes the
  order and asks for confirmation, and never invents prices/SKUs. If the AI
  endpoint is unreachable, the v1 keyword demo answers instead (logged).
- **Live updates** — SSE (`GET /api/events`) carries `message`, `lead`,
  `qr` (QR data URL for the scan modal) and `channel_status` events.

## Connect the real channels

### WhatsApp via OpenWA (QR scan) — the chosen route

1. Open the client's **Connectors** tab → **Connect via QR** on WhatsApp.
2. A QR code appears in the app. On the phone: WhatsApp → ⋮ menu →
   **Linked devices** → **Link a device** → scan.
3. Session persists in `sessions/` (per client: `tectonic-<id>`), so reconnects
   don't need a new scan. Inbound messages flow into the inbox; replies send
   through the same session.

> ⚠ **Ban risk:** OpenWA drives the real WhatsApp Web. WhatsApp can restrict
> or ban numbers that use automation. Use a **secondary business number** —
> scanning the QR means you accept this risk. (This is why the official Cloud
> API was deliberately *not* chosen as the primary route.)

### Telegram via QR (gramjs user session)

1. Get `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` at
   [my.telegram.org](https://my.telegram.org) → API development tools → `.env`.
2. **Connect via QR** on Telegram → scan with Telegram → Settings → Devices →
   **Link Desktop Device**.
3. The session string is stored per client (`channel_sessions` table);
   inbound DMs arrive in the inbox and replies send as the user account.
4. The classic **Bot API** path (BotFather token + webhook) still works as a
   fallback for outbound when no user session is connected.

### Messenger + Instagram (Meta webhook + page token)

1. [developers.facebook.com](https://developers.facebook.com) → app → add
   **Messenger** and **Instagram** products.
2. Webhook callback URL: `https://yourdomain/webhooks/meta`
   (see the Connectors tab for the exact URL), verify token → `META_VERIFY_TOKEN`.
3. Subscribe to `messages` (Messenger) and `messages` (Instagram topic).
4. Connect a Facebook Page, link the Instagram Business/Creator account,
   copy the **Page access token** → `META_PAGE_ACCESS_TOKEN`,
   **App secret** → `META_APP_SECRET`.
5. App Review (`pages_messaging`, `instagram_manage_messages`) + Business
   Verification before real users beyond testers can message.

> **24-hour messaging window:** Meta only lets you send free-form replies
> within 24 hours of the customer's last message. After that you need message
> templates (WhatsApp) or message tags (Messenger/Instagram).

## AI engine

`src/ai.js` makes a single plain chat-completion call — no tools, no
reasoning. Point it at any OpenAI-compatible endpoint via `.env`:

```
AI_BASE_URL=http://127.0.0.1:18080/v1
AI_API_KEY=dummy
AI_MODEL=@cf/zai-org/glm-4.7-flash
```

Defaults target the free-model bridge on this VM with a small/fast model
(`temperature 0.3`, `max_tokens 500`). The system prompt is assembled per
client (`buildSystemPrompt`) from business profile + catalog + knowledge +
lead fields; the model must reply with JSON
`{reply, lead:{...}, order:{items, confirmed}|null}`. Confirmed orders go
through the same validated `createOrder` path as manual orders (stock check,
BDT total, chat summary, lead → `confirmed`).

## API reference (v2)

All client-scoped routes take `?client_id=` (default 1).

| Method | Route | Notes |
|---|---|---|
| GET/POST | `/api/clients` | list (with stats+connectors) / create |
| PATCH/DELETE | `/api/clients/:id` | update (incl. lead fields) / delete |
| GET | `/api/global-stats` | platform-wide totals |
| GET | `/api/status?client_id=` | per-channel demo/live + method notes |
| GET | `/api/stats?client_id=` | chats, unread, orders/revenue today, leads by status |
| GET | `/api/conversations?client_id=&platform=&q=` | scoped list |
| GET/POST | `/api/conversations/:id/messages`, `…/read`, `…/reply` | as v1 |
| GET/POST/PATCH/DELETE | `/api/products…` | scoped CRUD |
| GET/POST | `/api/orders?client_id=`, `/api/conversations/:id/orders` | scoped orders |
| GET/PATCH | `/api/leads?client_id=&status=&q=`, `/api/leads/:id` | pipeline |
| GET/POST | `/api/clients/:id/knowledge` | rack entries |
| PATCH/DELETE | `/api/knowledge/:id` | edit/delete entry |
| GET | `/api/clients/:id/connectors` | WhatsApp/Telegram/Messenger/Instagram status |
| POST | `/api/clients/:id/connectors/:channel/connect` | starts QR flow (whatsapp/telegram) |
| POST | `/api/clients/:id/connectors/:channel/disconnect` | close session |
| GET | `/api/webhook-urls` | exact URLs to paste into consoles |
| GET | `/api/events` | SSE: `message`, `lead`, `qr`, `channel_status` |

Webhooks: `GET /webhooks/meta` (hub challenge), `POST /webhooks/meta`
(HMAC `X-Hub-Signature-256`), `POST /webhooks/telegram/:secret`.

## Project layout

```
tectonic-inbox/
├── server.js            # Express app: webhooks, REST API, SSE, multi-tenant
├── seed.js              # v2 demo seed: 2 clients, catalog, chats, orders, knowledge, leads
├── bin/
│   └── zstd             # pass-through shim (see note above)
├── sessions/            # OpenWA session data per client (created on connect)
├── src/
│   ├── db.js            # SQLite schema + queries (node:sqlite, no native build)
│   ├── normalize.js     # normalizeMessage(platform, raw) — one shape for all
│   ├── ai.js            # OpenAI-compatible sales bot + keyword demo fallback
│   ├── connectors.js    # OpenWA WhatsApp + gramjs Telegram QR sessions
│   └── senders.js       # outbound routing (live connectors → token fallbacks → demo)
├── public/
│   ├── index.html       # liquid-glass UI: Super Admin + Client workspace
│   └── app.js           # views, inbox, leads, knowledge, connectors, QR modal, SSE
├── .env.example         # copy to .env, fill tokens/keys
└── README.md
```
