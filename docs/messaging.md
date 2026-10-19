# Messaging Patterns

## RabbitMQ Topology
- **Exchange:** `tectobox.events` (Topic)
- **Dead Letter Exchange (DLX):** `tectobox.dlx` (Topic)
- **Queues:**
  - `incoming.messages` (Routing Key: `message.incoming.#`)
  - `outgoing.messages` (Routing Key: `message.outgoing.#`)
  - `ai.requests` (Routing Key: `ai.request.#`)
  - `broadcast.jobs` (Routing Key: `broadcast.job.#`)
- **Dead Letter Queues:** Each queue has a corresponding `.dlq` to capture failed messages using `x-dead-letter-exchange` and `x-dead-letter-routing-key`.

## Transactional Outbox Pattern
Ensures reliable message publishing without two-phase commit:
1. Producer saves event to `outbox_events` table in the same transaction as state changes.
2. Background worker (`OutboxProcessor`) polls `outbox_events` (using `FOR UPDATE SKIP LOCKED`).
3. Worker publishes to RabbitMQ (with publisher confirms).
4. Worker marks event as processed.

## Idempotent Inbox Pattern
Prevents duplicate message processing (RabbitMQ guarantees at-least-once delivery):
1. Consumer receives message.
2. `InboxProcessor` attempts to insert message ID into `inbox_events` table (`ON CONFLICT DO NOTHING`).
3. If insertion succeeds, handler processes message and ACKs.
4. If insertion fails (duplicate), consumer simply ACKs without processing.
