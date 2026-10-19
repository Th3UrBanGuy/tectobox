# Phase 6: Cutover, CI/CD & Production Topology

## Status: Completed

## Deliverables Completed
1. **GitHub Actions CI (`.github/workflows/ci.yml`)**:
   - Automated type-checking, building, and tests for all workspace packages (`@tectonic/contracts`, `@tectonic/messaging`, `@tectonic/coordination`, `@tectonic/workers`, and `services/api`).
   - Automated `go vet` verification for `services/ingress`.
   - Runs against live ephemeral Postgres, Redis, and RabbitMQ test containers.

2. **GitHub Actions Release Pipeline (`.github/workflows/release.yml`)**:
   - Automated multi-container build using Docker Buildx.
   - Pushes versioned and `latest` tags to GitHub Container Registry (`ghcr.io/tect0nicofficial/*`).

3. **Production Container Specifications**:
   - `infra/Dockerfile.api.prod` (Multi-stage build for NestJS Core API).
   - `infra/Dockerfile.ingress.prod` (Alpine-based static binary for Go Ingress).
   - `infra/Dockerfile.workers.prod` (Multi-stage build for Channel Workers).

4. **Production Deployment Orchestration (`infra/docker-compose.prod.yml`)**:
   - Production Docker Compose pulling pre-built images from GHCR without building locally on the VPS.
   - Pinned health checks, volume definitions, and environment variables.

5. **Data Cutover Strategy**:
   - Automated migration script in `scripts/migrate-sqlite-to-postgres.ts`.
   - Runbook documented in `docs/cutover-runbook.md`.
