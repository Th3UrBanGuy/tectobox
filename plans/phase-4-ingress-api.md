# Phase 4: Ingress & Core API Extraction

## Overview
Extracting the public webhook ingress to a high-performance Go service and the core business logic API to a modular NestJS application.

## Components

### Webhook Ingress (Go)
- **Path**: `services/ingress/`
- **Purpose**: High-throughput receiver for incoming channel messages (WhatsApp via Meta, Telegram).
- **Features**:
  - HMAC-SHA256 signature verification for Meta webhooks (`X-Hub-Signature-256`).
  - Secret token validation for Telegram webhooks (`X-Telegram-Bot-Api-Secret-Token`).
  - Direct, fast publishing to RabbitMQ (`tectobox.events` -> `incoming.messages`) with publisher confirmations.
  - Returns HTTP 200 *only* after confirming the message is safely in the broker.

### Core API (NestJS)
- **Path**: `services/api/`
- **Purpose**: Backend API serving the frontend dashboard and business operations.
- **Modules**:
  - `AuthModule`: Session and 2FA authentication.
  - `TenantModule`: Tenant context and data isolation (`TenantGuard`).
  - `InboxModule`: Handling conversations, messages, reads, and replies.
  - `CatalogModule`: Product and SKU management (tenant-scoped).
  - `LicensingModule`: Subscription plan feature resolution (`LicenseGuard`).
  - `SSEModule`: Redis Pub/Sub backend for Server-Sent Events (SSE).
- **Validation**: Zod-based type-safe validation for incoming requests.

## Status
- [x] Initialized Go module and ingress structure.
- [x] Implemented Meta & Telegram webhook receivers.
- [x] Implemented RabbitMQ publisher with confirms.
- [x] Initialized NestJS API with `pnpm`.
- [x] Scaffolded NestJS modules (`auth`, `tenant`, `inbox`, `catalog`, `licensing`, `sse`).
