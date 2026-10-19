# Ingress Service

## Overview
The Ingress Service is a lightweight, high-performance Go application designed to receive incoming webhooks from external channels (e.g., Meta/WhatsApp, Telegram) and publish them safely to the internal message broker (RabbitMQ) for asynchronous processing.

## Architecture
- **Language**: Go
- **Framework**: Standard library `net/http` for simplicity and performance.
- **Message Broker**: `amqp091-go` for RabbitMQ integration.

## Design Decisions
- **Fail-Closed Security**: Invalid signatures or missing headers result in immediate 401/403 responses.
- **Publisher Confirms**: Webhook requests are NOT acknowledged (HTTP 200) until RabbitMQ confirms durable broker persistence. This provides at-least-once delivery guarantees without premature acknowledgments.
- **Minimal Processing**: The service performs no business logic, database queries, or transformations. It solely verifies the payload's origin and queues it.

## Endpoints
- `GET /healthz`: Liveness check.
- `GET/POST /webhooks/meta`: Meta (WhatsApp) webhook verification and message ingestion.
- `POST /webhooks/telegram`: Telegram webhook ingestion.
