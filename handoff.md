# Tectobox — Handoff

## Current State

- **Full Microservices Architecture Implementation**: Complete. Legacy Express monolithic business modules, event routing, frontend SPA hosting, and workers have been fully extracted and modernized:
  - **NestJS Core API**: All 15 modules active (`auth`, `tenant`, `inbox`, `catalog`, `leads`, `orders`, `knowledge`, `broadcasts`, `widget`, `licensing`, `admin`, `connectors`, `sse`, `events`, `database`).
  - **Auth & SPA Bridge**: Dual auth supporting `tb_session` cookies and Bearer JWTs, static SPA hosting, `/api/auth/me`, `/api/auth/logout`, `/api/captcha`.
  - **Messaging & Outbox**: `EventsService` running inbound consumer (`message.incoming.#`), deduplicating messages, upserting conversations, capturing CRM leads, and publishing `outbox_events` to platform routing keys.
  - **Channel Workers**: WhatsApp QR code rendering via `qrcode` published to Redis Pub/Sub (`tenant:${clientId}:events`); Meta Graph API outbound worker (`services/workers/src/meta/worker.ts`) handling Messenger & Instagram with idempotency and retry; Telegram & WhatsApp distributed leases with monotonic fencing tokens.
  - **Go Webhook Ingress**: Added zero-dependency RESP Redis client for dynamic multi-tenant webhook routing (`meta:page:{id}` and `telegram:bot:{token}` -> `clientId`).
  - **Test Suite**: 100% passing across the workspace (14/14 API Vitest tests, 13/13 Worker Node test runner safety invariant tests).
  - **AI Module**: Deferred to later phase per user instruction.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Migration strategy | Strangler fig (incremental) | Lower risk than big-bang rewrite |
| Message broker | RabbitMQ | Simpler ops than Kafka for current scale |
| Package manager | pnpm | Faster, disk-efficient, workspace support |
| Local dev | Native servers + pulled Docker images | Dev machine is slow, no local builds |
| CI/CD image builds | GitHub Actions → GHCR | No builds on local machine or VPS |
| Frontend | Keep vanilla JS SPA for now | Zero frontend changes required |
| Dynamic Routing | Pure Go RESP client in Ingress | Instant multi-tenant page resolution without ingress restarts or external Go deps |

## Next Steps

1. Provision production database & message broker (PostgreSQL + RabbitMQ + Redis).
2. Execute production cutover dry-run with live data migration.
3. Implement advanced AI router and fallback chains when user requests AI phase.
