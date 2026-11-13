# Cutover & Migration Runbook

This guide describes the step-by-step process for performing data migration from the legacy SQLite monolith to PostgreSQL and cutting over traffic to the scalable microservices stack.

---

## 1. Prerequisites
- Docker Compose dev/prod running with healthy PostgreSQL, Redis, and RabbitMQ.
- Node.js 22+ with `pnpm`.
- Verified snapshot of `old-code/tectonic-inbox.db`.

---

## 2. Pre-Cutover Verification (Dry Run)
Test the data migration against PostgreSQL in dry-run mode to detect table, constraint, or schema incompatibilities without writing target data:

```bash
pnpm exec tsx scripts/migrate-sqlite-to-postgres.ts \
  --sqlite-path old-code/tectonic-inbox.db \
  --dry-run
```

**Guarantees in Dry-Run**:
- Opens the SQLite source in read-only mode (`DatabaseSync` readOnly flag).
- Verifies the required SQLite and PostgreSQL tables, compatible columns/types, required target columns, and source foreign-key integrity.
- If a target table is empty, treats it as a migration destination and does not write to it.
- If a target table is non-empty, requires matching source row counts and full row-content reconciliation; a count match alone is not considered verification.
- Does **not** write target rows, sequences, DDL, or checkpoint records.
- Does not prove PostgreSQL runtime constraints/trigger behavior beyond the catalog checks performed by the script; a live migration/integration check remains necessary before cutover.

---

## 3. Maintenance Window Cutover Steps

1. **Quiesce Writes on Legacy Monolith**:
   Stop traffic to the legacy Express server:
   ```bash
   pkill -f "node.*server.js" || true
   ```

2. **Execute Full Database Migration**:
   ```bash
   pnpm exec tsx scripts/migrate-sqlite-to-postgres.ts \
     --sqlite-path old-code/tectonic-inbox.db
   ```

   **Guarantees in Live Migration**:
   - Inserts each table's rows and its completion checkpoint in one PostgreSQL transaction.
   - Revalidates completed checkpoints against full source and target row contents before skipping a table.
   - Treats a conflict as identical only when one unambiguous target row matches all source columns; otherwise rolls back the table and exits non-zero.
   - Verifies final row counts and full row contents before writing each table checkpoint, including empty-source tables.
   - Reconciles PostgreSQL serial sequence counters (`setval`).
   - Fails with a non-zero exit code on query, schema, conflict, reconciliation, or connection errors.
   - Unit tests use a PostgreSQL mock; run against an isolated PostgreSQL instance before any production cutover.

3. **Verify Data in PostgreSQL**:
   Inspect row counts across core tables:
   ```bash
   docker exec -it tectobox-postgres psql -U tectobox -d tectobox -c \
     "SELECT 'clients' as tbl, count(*) FROM clients UNION ALL SELECT 'conversations', count(*) FROM conversations UNION ALL SELECT 'messages', count(*) FROM messages;"
   ```

4. **Start the Microservices Stack**:
   On development:
   ```bash
   # Run NestJS API
   cd services/api && pnpm run start:dev

   # Run Workers
   cd services/workers && pnpm run start:dev

   # Run Ingress
   cd services/ingress && go run cmd/ingress/main.go
   ```
   Or on production via Docker Compose:
   ```bash
   cd infra && docker compose -f docker-compose.prod.yml up -d
   ```

5. **Verify Health Endpoints**:
   ```bash
   curl -i http://127.0.0.1:8080/healthz  # Ingress
   curl -i http://127.0.0.1:3120/api/healthz # API
   ```

---

## 4. Rollback Plan
If critical issues arise during the maintenance window:
1. Shut down the microservices stack:
   ```bash
   cd infra && docker compose -f docker-compose.prod.yml down
   ```
2. If restoring from archive:
   Extract `old-code-backup.tar.gz` and restore the SQLite snapshot `backup/tectonic-inbox.db`.
The original SQLite database file snapshot remains intact in the backup archive as a historical fallback.
