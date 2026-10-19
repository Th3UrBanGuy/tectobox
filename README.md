# Tectobox

Multi-tenant social-commerce SaaS — unified inbox (WhatsApp, Telegram, Messenger, Instagram), product catalog, lead pipeline, AI knowledge base, broadcast campaigns, and AI sales bot.

## Status

**Migrating** from Express/SQLite monolith to scalable microservices architecture.

- Legacy app: `old-code/` (fully functional)
- New services: `services/` (in development)

## Quick Start (Local Development)

```bash
# 1. Start infrastructure (Postgres, Redis, RabbitMQ)
cd infra && docker compose -f docker-compose.dev.yml up -d

# 2. Run the legacy app (still works)
cd old-code && pnpm install && pnpm start
```

## Repository Layout

| Directory | Purpose |
|---|---|
| `old-code/` | Legacy Express/SQLite monolith (reference) |
| `services/api/` | NestJS core API (planned) |
| `services/ingress/` | Go webhook ingress (planned) |
| `services/workers/` | Node channel workers (planned) |
| `packages/contracts/` | Shared TypeScript event/API schemas (planned) |
| `infra/` | Docker Compose and infrastructure config |
| `docs/` | Architecture decisions and guides |
| `plans/` | Phase-specific implementation plans |
| `tasks/` | Active task records |
| `task-completed/` | Completed task records |

## Documentation

- [AGENTS.md](./AGENTS.md) — Agent/developer guide
- [handoff.md](./handoff.md) — Current state and next steps
- [TODO.md](./TODO.md) — Task tracker
- [plans/](./plans/) — Migration phase plans
