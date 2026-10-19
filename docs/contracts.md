# Contracts & Messaging Events

The `packages/contracts` package holds Zod schemas and TypeScript definitions for the shared events and APIs across the Tectobox microservices.

## Messaging Events

### 1. Inbound Message Event
Used to pass messages from the channel webhooks (Meta, Telegram, WhatsApp) to the central processing system.
- `eventId`: UUID
- `clientId`: Tenant ID
- `platform`: `meta`, `telegram`, `whatsapp`, `webchat`
- `platformUserId`: The user's platform-specific ID
- `text`: Message body
- `externalId`: Idempotency key from platform
- `timestamp`: When it was received

### 2. Outbound Message Event
Used to instruct the channel workers to send a message out to a platform.
- `eventId`: UUID
- `clientId`: Tenant ID
- `conversationId`: The conversation ID in our DB
- `platform`: Destination platform
- `platformUserId`: Destination user ID
- `text`: Message body
- `timestamp`: When it was queued

### 3. AI Generation Request
Instructs the AI worker to generate a response.
- Contains the `context` (messages array, knowledge passages, lead info).

### 4. Broadcast Job & Status Events
- **BroadcastJobEvent**: Emitted when a broadcast should send a specific message to a specific user.
- **BroadcastStatusEvent**: Emitted by the worker to report success/failure of a broadcast delivery.

## REST API Types

The package also exposes Zod schemas for the public REST APIs and shared types (e.g., `Conversation`, `Message`, `Product`, `Lead`, `License`). This ensures the API responses and types stay strictly synchronized with the frontend and backend services.
