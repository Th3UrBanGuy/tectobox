# Tectobox — Agent Guide

## Overview

Tectobox is being migrated from a monolithic Express/SQLite app to a scalable
microservices architecture. The legacy code lives in `old-code/`. New services
are built in `services/`.

## Repository Layout

- `old-code/` — Legacy Express monolith. **Do not modify** unless fixing a
  production bug. Reference only for migration.
- `services/api/` — NestJS core API
- `services/ingress/` — Go webhook ingress
- `services/workers/` — Node channel workers (WhatsApp/Baileys, Telegram/GramJS, AI)
- `packages/contracts/` — Shared TypeScript event/API schemas (Zod validated)
- `infra/` — Docker Compose files and infrastructure config
- `docs/` — Architecture decision records and guides
- `plans/` — Phase-specific implementation plans (see links below)

## Engineering Principles

- **Parallel Subagents** — Break complex or multi-component tasks into small, self-contained sub-tasks and run parallel subagents to execute them concurrently for speed. Keep agent prompts focused on specific files or boundaries, and verify integration after.
- **Package Manager** — Use **pnpm ONLY** across the monorepo and all subpackages/services. Never use `npm` or `npx`.
- **No Local Docker Builds** — Do not build images locally. If verification requires building, build them strictly one by one and immediately remove the image (`docker rmi`) afterwards to conserve disk/memory.
- **DRY** — Don't repeat yourself. Shared code goes in `packages/`.
- **KISS** — Keep it simple. No premature optimization or over-engineering.
- **OOP** — Use classes, interfaces, and dependency injection (NestJS style).
- **Low Coupling** — Services communicate via message broker and typed contracts.
  Never share database access across services.
- **Type Safety** — Validate at every public boundary. Use Zod schemas in contracts.
- **Tenant Isolation** — Every query/mutation scoped by authenticated tenant context.
  Never trust URL/body tenant IDs without ownership verification.
- **Idempotent Processing** — Every queue handler must be safe under redelivery.
- **No Secrets in Source** — Never commit .env, tokens, keys, or credentials.

## Development Commands

```bash
# Start infrastructure (Postgres + Redis + RabbitMQ)
cd infra && docker compose -f docker-compose.dev.yml up -d

# Run legacy app (for reference/testing)
cd old-code && pnpm install && pnpm start

# Run NestJS API (when ready)
cd services/api && pnpm install && pnpm run start:dev

# Run Go ingress (when ready)
cd services/ingress && go run cmd/ingress/main.go

# Run workers (when ready)
cd services/workers && pnpm install && pnpm run start:dev
```

## Migration Plans

| Phase | Plan | Status |
|---|---|---|
| 0 | [Baseline & Safety](./plans/phase-0-baseline.md) | Completed |
| 1 | [Repo Structure & Local Dev](./plans/phase-1-foundation.md) | Completed |
| 2 | [Contracts & PostgreSQL](./plans/phase-2-contracts-data.md) | Completed |
| 3 | [Messaging & Coordination](./plans/phase-3-messaging.md) | Completed |
| 4 | [Ingress & API Extraction](./plans/phase-4-ingress-api.md) | Completed |
| 5 | [Channel Workers](./plans/phase-5-workers.md) | Completed |
| 6 | [Cutover & CI/CD](./plans/phase-6-cutover.md) | CI Hardened; Live Cutover Pending VPS/DB Provisioning |

## Task Tracking

- Active tasks: `tasks/`
- Completed tasks: `task-completed/`
- Overview: [TODO.md](./TODO.md)
- Current state: [handoff.md](./handoff.md)

