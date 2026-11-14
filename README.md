# Tectobox

Multi-tenant social-commerce SaaS — unified inbox (WhatsApp, Telegram, Messenger, Instagram), product catalog, lead pipeline, AI knowledge base, broadcast campaigns, and AI sales bot.

## Status

Microservices architecture with NestJS Core API, Go Ingress webhook receiver, Node channel workers, PostgreSQL 16, Redis 7, and RabbitMQ 3. Legacy monolith has been deprecated and archived (`old-code-backup.tar.gz`).

## Quick Start (Local Development)

```bash
# 1. Start infrastructure (Postgres, Redis, RabbitMQ)
cd infra && docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies & build packages
pnpm install
pnpm --filter @tectonic/contracts run build
pnpm --filter @tectonic/messaging run build
pnpm --filter @tectonic/coordination run build

# 3. Start Core API
pnpm --filter api run start:dev
```

## Pre-commit Hooks

To enforce code hygiene and prevent committing credentials or malformed files, install pre-commit:

```bash
pre-commit install
```

The hooks run on `git commit` to verify YAML syntax, trim trailing whitespace, fix end-of-file newlines, and prevent private key leaks.

## Repository Layout

| Directory | Purpose |
|---|---|
| `services/api/` | NestJS core API (multi-tenant management, auth, inbox, catalog) |
| `services/ingress/` | Go webhook ingress (Meta HMAC, Telegram secret verification) |
| `services/workers/` | Node channel workers (WhatsApp/Baileys, Telegram/GramJS, AI worker) |
| `services/ai/` | Go AI router and engine bridge |
| `packages/contracts/` | Shared TypeScript event/API schemas (Zod validated) |
| `packages/messaging/` | RabbitMQ topology, durable exchanges, and queues |
| `packages/coordination/` | Redis leasing, session fencing, and distributed locking |
| `infra/` | Docker Compose, Postgres migrations, RabbitMQ definitions, Caddy |
| `docs/` | Architecture decisions, runbooks, and API documentation |
| `plans/` | Phase-specific architecture and implementation plans |
| `tests/` | Playwright E2E and cross-service resilience test suite |

## Documentation

- [AGENTS.md](./AGENTS.md) — Agent/developer guide
- [PRODUCTION_STANDARD.md](./PRODUCTION_STANDARD.md) — Hardening standard and status
- [handoff.md](./handoff.md) — Current state and architecture notes
- [TODO.md](./TODO.md) — Task tracker
- [plans/](./plans/) — Implementation plans
