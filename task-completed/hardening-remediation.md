# Hardening Remediation Record

Implementation and unit-test work is recorded below. Live PostgreSQL/RabbitMQ integration and production cutover are not verified by this record; status claims must remain limited to checks actually run.

Addressed architectural, data safety, and ingress validation gaps:

- **Security & Secret Audit**: Audited repository history and untracked files; confirmed no tracked credentials. Ensured environment, SQLite WAL/DB files, and session caches are properly ignored.
- **API Authentication & Tenant Boundary**:
  - Secure async `scrypt` password hashing matching legacy format.
  - Fail-closed configuration when `JWT_SECRET` is missing.
  - Strict tenant guard preventing cross-tenant access and client-header spoofing.
- **Go Ingress Normalization & Mandatory Routing**:
  - Validated and normalized payloads into `NormalizedInboundEnvelope` contracts.
  - Mandatory RabbitMQ publishing with return listeners.
- **Worker Delivery & Fencing Safety**:
  - Monotonic Redis fencing tokens with atomic send boundary checks.
  - Bounded retries (capped at 3) routing to `tectonic.dlq`.
  - Persisted send attempt states to eliminate duplicate sends on provider ambiguity.
- **Catalog Schema Parity**:
  - Reconciled API catalog queries with PostgreSQL schema.
- **CI Gated Release Workflow**:
  - Pinned immutable full-SHA GHCR tags, gated release builds strictly on CI verification pass.
- **Resumable SQLite-to-PostgreSQL Migration**:
  - Read-only dry-run verifies compatible schema, counts, and full row content for non-empty targets.
  - Live migration checks full source/target row multisets and counts before recording each table checkpoint; failures roll back the table transaction.
  - Composite constraints are grouped by schema/name and ordered by key position for conflict lookup.
  - Unit tests cover mocked PostgreSQL behavior; live PostgreSQL migration remains unverified pending an isolated database.
