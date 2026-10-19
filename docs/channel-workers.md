# Channel Workers

The Tectobox channel workers manage the lifecycle, state, and messaging integrations for third-party platforms. They run as decoupled microservices using RabbitMQ for event streaming.

## Services

### WhatsApp Worker
- **Responsibilities**: Manages Baileys sockets.
- **Concurrency**: Distributed via Redis session leases (`lease:wa:{clientId}:{slot}`) to prevent multi-instance conflicts.
- **Pacing**: Outbound messages are passed through an anti-ban pacer that simulates human typing behavior.

### Telegram Worker
- **Responsibilities**: Handles Telegram messaging using GramJS (`telegram` package).
- **Session Handling**: Uses `StringSession` for authentication.

### AI Worker
- **Responsibilities**: Processes inbound messages demanding automated AI replies.
- **Routing**: Consumes from `ai.requests` and implements multi-tier logic (e.g., GPT-4o-mini). Publishes generated responses back to the appropriate `message.outgoing.{platform}` queue.
