# Database Schema

Tectobox uses PostgreSQL as its primary data store. The schema is located in `infra/postgres/schema.sql`.

## Core Entities

- **clients**: Tenants in the multi-tenant system. Every other entity is scoped by `client_id` for isolation.
- **conversations**: A chat thread between a client's slot and a specific customer on a platform. Unique on `(client_id, platform, platform_user_id, slot)`.
- **messages**: The messages inside a conversation. Has `external_id` for idempotency to avoid double-processing incoming webhooks.
- **leads**: Lead intelligence CRM profiles mapped to `(client_id, platform, platform_user_id)`.
- **orders**: Transactions created via the AI or manually. Tracks subtotal, charges, and payment status.
- **products**: Inventory catalog. Unique on `(client_id, sku)`.

## Idempotent Messaging Tables

To support the transactional outbox pattern and idempotent message processing:
- **outbox_events**: Stores events that need to be published to RabbitMQ/Kafka. Written transactionally with domain data, and polled/tailed by a separate worker.
- **inbox_events**: Stores incoming message IDs to prevent duplicate processing if the broker redelivers a message.

## Tenant Isolation
The schema uses compound primary keys/unique constraints (e.g. `client_id` + `entity_id` or `client_id` + `external_id`) and cascading foreign keys referencing `clients(id)` to enforce tenant isolation at the database level.
