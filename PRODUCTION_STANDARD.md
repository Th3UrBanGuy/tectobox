# Tectobox Production Architecture & Hardening Standard (PRODUCTION_STANDARD.md)

This document establishes the official production standards, security baselines, and reliability status for the Tectobox platform.

---

## 1. Stack Architecture & Detection
- **Core API**: NestJS (TypeScript, Node 22, Express adapter, OOP with Dependency Injection, Helmet headers)
- **Ingress Webhooks**: Go 1.22+ (Static binary, goroutine concurrency, zero external dependencies)
- **AI Router & Intelligence Engine**: Go 1.22+ (`services/ai`) + NestJS Multi-tier Router
- **Channel Workers**: Node 22 (`@whiskeysockets/baileys`, `telegram/gramjs`, Redis lease fencing)
- **Data Tier**: PostgreSQL 16 (Relational multi-tenant), Redis 7 (In-memory cache & pub/sub), RabbitMQ 3 (Topic & dead-letter exchange)
- **Edge Gateway**: Caddy 2 (Reverse proxy, HTTP/3, automated Let's Encrypt TLS, security headers)
- **Containerization & CI/CD**: Docker Compose, GitHub Actions CI/CD with Dependabot & security scanning

---

## 2. Hardening Status Matrix

| Step | Focus Area | Production Requirement | Codebase Implementation Mapping | Status |
|---|---|---|---|:---:|
| **1** | **OWASP Zero-Trust & Cryptography** | No hardcoded secrets, strict Zod validation, parameterised queries, tenant isolation | `services/api/src/auth`, `services/api/src/tenant`, `.env.production` | **Enforced** |
| **2** | **Global Error Handling & Resilience** | Zero unhandled rejections, structured error envelopes, safe sanitized user messages | `services/api/src/common/filters/all-exceptions.filter.ts` | **Enforced** |
| **3** | **Load Balancing & Circuit Breakers** | Dynamic AI tier fallback (Tier 1 Gemini -> Tier 2 Cloudflare -> Tier 3 Direct), exponential backoff | `services/api/src/ai/router.ts`, `services/ai/pkg/router` | **Enforced** |
| **4** | **Clean Architecture & Tech Debt** | Typed configuration, zero magic numbers, elimination of dead prototype paths | `services/api/src/config/app.config.ts` (Zod validated at startup), `old-code/` archived | **Enforced** |
| **5** | **Modular Decoupling & Interfaces** | Controller -> Service -> Repository separation, contract-driven events | `packages/contracts`, NestJS modules | **Enforced** |
| **6** | **Resource Lifecycle & Leak Prevention** | Deterministic shutdown (`OnModuleDestroy`), graceful DB/Redis/AMQP connection closing | `services/api/src/database`, `services/api/src/events` | **Enforced** |
| **7** | **Database Indexing & Caching** | Composite indexes on tenant and status fields, limit/offset pagination, redis caching | `infra/postgres/migrations/003-add-indexes.sql`, limit/offset (50/200) on list endpoints | **Hardened** |
| **8** | **Chaos & Stress Proofing** | Malformed payloads, 0-byte files, race conditions, idempotent message queues | `services/workers`, `tests/` matrix | **Enforced** |
| **9** | **Observability & PII Redaction** | Structured JSON logging, automatic masking of tokens, passwords, and PII | `services/api/src/common/logger/logger.service.ts` | **Enforced** |
| **10** | **Release & Production Packaging** | Non-root `appuser` containers, Helmet security headers, Dependabot, CI security scans | `infra/Dockerfile.*.prod`, `main.ts`, `.github/workflows/ci.yml` | **Hardened** |

---

## 3. Operational Runbook & Health Diagnostics

- **Edge Gateway Status**: `curl -I https://box.tect0nic.com` or `curl -I http://160.25.5.64/`
- **Core API Health**: `curl http://127.0.0.1:3120/healthz` or `curl https://box.tect0nic.com/api/healthz`
- **AI Router Health**: `curl http://127.0.0.1:8081/health` (internal)
- **Ingress Health**: `curl http://127.0.0.1:8080/healthz` (internal)
