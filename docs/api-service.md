# API Service

## Overview
The API Service is the core backend application serving the frontend dashboard and business operations. It is built with NestJS to provide a modular, maintainable, and type-safe foundation.

## Architecture
- **Language**: TypeScript
- **Framework**: NestJS
- **Validation**: Zod (via `@tectonic/contracts`)

## Core Modules
- **`AuthModule`**: Handles session authentication, 2FA/TOTP verification, and audit logging.
- **`TenantModule`**: Enforces strict tenant data isolation. Provides `TenantGuard` to inject tenant context into requests and ensure cross-tenant boundaries are never breached.
- **`InboxModule`**: Manages the core CRM functionalities: Conversations, Messages, and read/reply operations.
- **`CatalogModule`**: Handles product and SKU management within a tenant's scope.
- **`LicensingModule`**: Resolves subscription plan features and limits using `LicenseGuard`.
- **`SSEModule`**: Manages Server-Sent Events for real-time frontend updates, backed by Redis Pub/Sub.

## Design Decisions
- **Modularity**: Business domains are separated into independent modules to prevent spaghetti code.
- **Type Safety**: End-to-end type safety using Zod schemas shared from `packages/contracts`.
- **Dependency Injection**: Heavy reliance on NestJS's DI container for testability and decoupling.
