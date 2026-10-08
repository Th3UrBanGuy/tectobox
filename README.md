# Tectobox

Multi-tenant **social-commerce SaaS**: one platform, many businesses. Each client
gets an isolated workspace with a unified inbox (WhatsApp, Telegram, Messenger,
Instagram), product catalog, lead pipeline, AI knowledge base, broadcast
campaigns, and an AI sales bot — all gated by a per-workspace **license system**.

> **Status:** production. Live at `https://ss.kalandar.me`.

---

## Features

| Area | What you get |
|---|---|
| **Combined inbox** | Every channel in one view, AI auto-replies, human handover (`[NEEDS_HUMAN]`) |
| **AI engine** | Pluggable OpenAI-compatible backends, per-workspace knowledge base, lead scoring (Hot/Warm/Cold) |
| **Broadcast** | Bulk campaign messaging with audience builder, paced sending, live progress |
| **Webchat widget** | Embeddable chat bubble (`<script src="…/widget.js" data-client="KEY">`), appearance editor |
| **Licensing** | Time plans (monthly/quarterly/yearly), credit plans (per AI reply), feature plans (per-feature credits); suspend, AI-pause, deletion queue |
| **Public API v1** | Workspace-scoped API keys (`Authorization: Bearer tk_…`), outbound webhooks |
| **Client panel** | My Plan view, API keys, backup/restore, PWA install |

---

## Requirements

- **Node.js ≥ 22.5** (uses `node:sqlite`, no native deps)
- `npm`
- A domain + HTTPS if you want webhooks / Meta / public widget (plain HTTP works for local testing)

```bash
node --version   # must be 22.5+
```

---

## Quick start (5 minutes, local)

```bash
git clone https://github.com/Th3UrBanGuy/tectobox.git
cd tectobox
npm install
cp .env.example .env   # then edit .env (see below)
```

### 1. Create the first admin (one time only)

In `.env`, set:

```env
BOOTSTRAP_ADMIN=1
ADMIN_PASSWORD=<redacted>
NODE_ENV=development
PORT=3120
```

Start the server:

```bash
npm start
# → open http://localhost:3120
```

Log in as `admin` with your password. **Then remove `ADMIN_PASSWORD`
(and `BOOTSTRAP_ADMIN`) from `.env` and restart.** The account stays; the
bootstrap never runs again.

> Want demo data to click around? Run `npm run seed` (or set `SEED_DEMO=1`
> once). It creates two demo workspaces with catalog, chats and leads.
> Production stays empty by default.

### 2. Create a workspace

As admin: **Platform Panel → Users → New user**. Enter a username, password
and workspace name. This creates an isolated workspace for the client.

### 3. Give it a license

As admin: **Platform Panel → Plans & licenses**. Four starter plans are
pre-seeded (Starter/Growth/Business = time plans, AI Credits = credit plan).
On the workspace card, hit **Assign license** and pick a plan. The client's
panel updates **instantly** — features appear/disappear live, no reload needed.

Without a license a new workspace is **locked** (it can log in but every
feature returns 403 until you assign one).

### 4. Connect a channel

As the client: **Settings → Channels → Add channel → WhatsApp** and scan the
QR with the business phone. Telegram works the same way (needs
`TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from https://my.telegram.org).
Messenger/Instagram need a Meta app (see below).

That's it — send a message to the connected number and watch the inbox light
up. Toggle **AI Auto-Reply** in More to let the AI answer.

---

## Configuration (`.env`)

Copy `.env.example` → `.env`. Everything works with defaults except the
bits you want live. The important groups:

### Server

| Var | Default | What |
|---|---|---|
| `PORT` | `3120` | HTTP port |
| `NODE_ENV` | `development` | `production` enables Secure cookies (needs HTTPS) |
| `DB_PATH` | `./tectonic-inbox.db` | SQLite file location |
| `BIND_HOST` | `127.0.0.1` | Bind address |
| `COOKIE_SECURE` | — | `1` forces Secure cookies |

### Admin bootstrap (first run only)

| Var | What |
|---|---|
| `BOOTSTRAP_ADMIN=1` | Create the `admin` user on boot |
| `ADMIN_PASSWORD` | Min 12 chars. **Delete from `.env` after first login** |

Admins can enable TOTP 2FA from the login screen afterwards.

### AI engine

The AI talks to any OpenAI-compatible `/v1/chat/completions` endpoint:

| Var | Default | What |
|---|---|---|
| `AI_BASE_URL` | `http://127.0.0.1:18080/v1` | Chat endpoint |
| `AI_API_KEY` | — | Bearer key for it |
| `AI_MODEL` | `@cf/zai-org/glm-4.7-flash` | Model name |
| `AI_FALLBACK_URL` / `AI_FALLBACK_MODEL` | — | Second tier if the first fails |
| `AI_URL_ALLOWLIST` | — | Required if `AI_BASE_URL` is not loopback (comma-separated hostnames; SSRF guard) |

Optional tuning: `AI_GLOBAL_BUCKET_CAP/RATE`, `AI_CLIENT_BUCKET_CAP/RATE`
(reply rate limits), `AI_BUDGET_WAIT_MS`.

Per-workspace **daily AI spend caps** are set by the admin on each workspace
card (default 200/day) — enforced before any AI reply.

### WhatsApp (Baileys, QR login)

No env needed — connect from the client panel. Sessions persist in
`sessions/baileys-<clientId>-<slot>/` (AES-256-GCM encrypted at rest with
`SESSION_ENC_KEY`; auto-generated if unset — **back it up**, losing it
orphans stored sessions).

### Telegram

| Var | Where from |
|---|---|
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | https://my.telegram.org → API development tools (QR login) |
| `TELEGRAM_BOT_TOKEN` | @BotFather (optional Bot-API mode) |
| `TELEGRAM_WEBHOOK_SECRET` | You choose; webhook URL becomes `/webhooks/telegram/<secret>` |

### Meta (Messenger + Instagram)

1. Create an app at https://developers.facebook.com, add the **Messenger**
   product.
2. Set the webhook to `https://YOURDOMAIN/webhooks/meta` with your
   `META_VERIFY_TOKEN`, subscribe to `messages` + `messaging_postbacks`.
3. Put the app ID/secret in `.env`:

| Var | What |
|---|---|
| `META_APP_ID` / `META_APP_SECRET` | From app Settings → Basic (enables per-client Page connect via OAuth) |
| `META_VERIFY_TOKEN` | The token you typed when configuring the webhook |
| `META_PAGE_ACCESS_TOKEN` | Page token (legacy single-page mode) |

OAuth callback URL: `https://YOURDOMAIN/api/meta/oauth/callback`.
**Never set `DEMO_WEBHOOKS=1` in production** — it accepts unsigned webhooks.

### Google Drive backup (optional)

`GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` /
`GOOGLE_DRIVE_REDIRECT_URI` — standard Google OAuth credentials; clients can
then back up to their own Drive from Settings → Backup.

### Voice notes (optional)

`VOICE_STT_ENABLED=1` + `STT_PRIMARY` provider config transcribes inbound
voice messages before the AI sees them.

### Push notifications (optional)

`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — generate with
`npx web-push generate-vapid-keys`.

---

## License system (how it works)

Three plan kinds, all managed at **Platform Panel → Plans & licenses**:

- **Time** (monthly/quarterly/yearly) — unlimited use inside the window.
  Expired → workspace locked (`license_expired`).
- **Credit** — N AI replies total. Each real AI reply consumes 1 credit
  (atomic — concurrent replies can't double-spend). Empty → AI stops
  (`credits_exhausted`); inbox keeps working.
- **Feature** — per-feature grants, each `unlimited` or a credit pool.

Seven licensable features: `combined_inbox`, `ai_response`, `webchat`,
`broadcast`, `lead_intel`, `knowledge`, `api_access`. Every one is enforced
**server-side** (API returns 403 without it), not just hidden in the UI.

Admin controls per workspace (all instant over SSE — the client panel
re-gates live):
**Assign license** · **AI pause** (inbox works, AI silent) · **Suspend**
(whole workspace off, sessions killed instantly) · **AI budget** (daily cap) ·
**Delete** (15-day grace, then permanent wipe).

---

## Production deployment

```bash
NODE_ENV=production PORT=3120 nohup node server.js >>server.log 2>&1 &
```

- `monitor.sh` — 10-second self-heal loop (restarts node on failed health
  checks, guards edge + tunnel). Run it detached; the 1-min/5-min crons
  supervise it.
- Put the app behind TLS (Cloudflare Tunnel, Caddy, nginx…). Set
  `NODE_ENV=production` + `COOKIE_SECURE=1`.
- Never `pkill -f "server.js"` on a box running other node apps — match the
  process title / port instead.

### Data & backup

- SQLite at `DB_PATH` (WAL mode). Back up the `.db` file; clients can also
  self-serve JSON export from Settings → Backup.
- `SESSION_ENC_KEY` — if set, keep it safe; it encrypts WhatsApp/Telegram
  sessions and TOTP secrets.
- `nightly-garbage-clean.sh` — optional cron for old logs/sessions.

---

## Project structure

```
server.js            # Express app: auth, SSE, webhooks, AI pipeline, admin API
src/
  db.js              # SQLite schema + all queries (licenses, plans, broadcasts…)
  senders.js         # Channel senders (Meta, Telegram, WhatsApp/Baileys)
  pacer.js           # Per-number rate limiter (anti-ban)
  ai.js / ai-rules.js# AI reply chain
  connectors.js      # Channel session lifecycle (Baileys, gramjs)
  publicapi.js       # Public API v1 (key auth)
  lead-intel.js      # Lead scoring
  crawler.js         # Website → knowledge-base importer
  captcha.js / totp.js # Self-hosted CAPTCHA, admin 2FA
public/
  app.js             # Dashboard SPA (client + admin)
  widget.js          # Embeddable webchat
  index.html / install.html
seed.js              # Demo data (manual: npm run seed)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `BOOTSTRAP_ADMIN=1 but ADMIN_PASSWORD missing` | Set a 12+ char password, restart once, then remove it |
| Login loops / session lost | Check `COOKIE_SECURE` — must be `0`/unset on plain HTTP |
| WhatsApp QR never appears | Check server log for Baileys errors; session dir writable? |
| AI never replies | Admin: is AI paused? License has `ai_response`? Credits left? Daily budget hit? Check `server.log` for `[ai]` lines |
| `database is locked` | Don't open the DB from a second process while the server runs |
| Widget shows 403 | Workspace plan needs the `webchat` feature |
| Meta webhook rejected | `META_VERIFY_TOKEN` mismatch; never use `DEMO_WEBHOOKS=1` in prod |

---

## License

MIT.
