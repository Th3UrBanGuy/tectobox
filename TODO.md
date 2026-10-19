# Tectobox — TODO

## Phase 0: Baseline & Safety
- [x] Audit git history for leaked credentials/secrets
- [x] Audit `.env.example` and shell scripts for hardcoded secrets
- [x] Establish regression tests for critical paths:
  - [x] Webhook dedup (concurrent insert race)
  - [x] Tenant isolation (cross-workspace data access)
  - [x] Meta HMAC signature verification
  - [x] Telegram webhook secret validation
  - [x] Order idempotency key enforcement
  - [x] WhatsApp pacer cap enforcement
  - [x] Broadcast pump restart recovery

## Phase 1: Foundation
- [x] Push existing history to `tect0nicofficial/tectobox`
- [x] Restructure repo (`old-code/`, `services/`, `packages/`, `infra/`)
- [x] Create AGENTS.md, handoff.md, TODO.md
- [x] Create docs/, plans/, tasks/, task-completed/
- [x] Create docker-compose.dev.yml (Postgres + Redis + RabbitMQ)
- [x] Set up pnpm workspace

## Phase 2: Contracts & PostgreSQL
- [x] Design PostgreSQL schema (tenants, conversations, messages, products, orders, leads, licenses, etc.)
- [x] Create `packages/contracts/` with Zod-validated event schemas
- [x] Build SQLite → PostgreSQL migration script
- [x] Set up TypeORM/Prisma/Drizzle for NestJS

## Phase 3: Messaging & Coordination
- [x] Configure RabbitMQ exchanges, queues, DLQ
- [x] Implement transactional outbox pattern
- [x] Move rate limits to Redis sliding windows
- [x] Implement Redis session leases with fencing tokens

## Phase 4: Ingress & API
- [x] Build Go webhook ingress (Meta HMAC, Telegram secret)
- [x] Build NestJS API modules (auth, tenant, inbox, catalog, licensing, etc.)
- [x] Preserve existing SSE/API contract for frontend compatibility

## Phase 5: Channel Workers
- [x] Extract WhatsApp (Baileys) worker with Redis lease
- [x] Extract Telegram (GramJS) worker with Redis lease
- [x] Extract AI processing worker
- [x] Implement durable pacer with Redis counters

## Phase 6: Cutover & CI/CD
- [x] GitHub Actions CI pipeline (lint, test, build images)
- [x] GitHub Actions release pipeline (push to GHCR)
- [x] Production docker-compose.prod.yml
- [x] Data migration and cutover plan

## Deferred
- [ ] Verify SQLite-to-PostgreSQL dry-run and migration against an isolated live PostgreSQL database (current migration tests use a mock)
- [ ] Verify RabbitMQ worker topology and retry/DLQ behavior against a live broker
- [ ] VPS procurement
- [ ] DNS/TLS setup
- [ ] Production secrets provisioning
- [ ] Frontend rewrite (React/Vue/Next.js)
- [ ] Kubernetes evaluation
