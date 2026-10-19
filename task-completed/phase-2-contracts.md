# Phase 2: Contracts & PostgreSQL Data Foundation

Status: **Completed**

## Tasks Accomplished:
1. Initialized `packages/contracts` with `package.json`, `tsconfig.json`, and Zod-validated TypeScript contracts. Includes:
   - Inbound message event
   - Outbound message event
   - AI generation request & response events
   - Broadcast job & status events
   - REST API contracts for conversations, messages, products, leads, and licenses.
2. Designed the comprehensive PostgreSQL schema in `infra/postgres/schema.sql` porting 26 tables from SQLite with data types, indexes, and constraints.
   - Enforced tenant isolation via `client_id` foreign keys and compound unique indexes.
   - Added `outbox_events` and `inbox_events` for idempotent messaging.
3. Built SQLite -> PostgreSQL data migration script in `scripts/migrate-sqlite-to-postgres.ts`.
4. Documented the contracts in `docs/contracts.md` and the schema in `docs/database-schema.md`.
