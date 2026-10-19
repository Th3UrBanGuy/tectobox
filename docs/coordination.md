# Coordination Patterns

## Redis Distributed Utilities

### Rate Limiting
- **Pattern:** Sliding Window (using Redis Sorted Sets).
- **Usage:** Limits API and webhook requests based on IPs.
- **Implementation:** `RedisCoordinator.rateLimit(key, limit, windowSec)`

### Distributed Session Leases
- **Pattern:** Leases with Fencing Tokens.
- **Usage:** Prevents split-brain in worker components (e.g., WhatsApp sessions). Only one worker can hold the lease for a `clientId` at a time.
- **Implementation:** `acquireLease`, `renewLease`, `releaseLease` via Lua scripts.

### Distributed Locking
- **Pattern:** Simple Redis lock with TTL.
- **Usage:** Ensuring sequential processing for conversational replies (`lock:reply:{conversationId}`).
- **Implementation:** `acquireLock` (SET NX) and `releaseLock` (Lua script).

### Pub/Sub Real-time Fan-out
- **Pattern:** Redis Pub/Sub.
- **Usage:** Fan-out Server-Sent Events (SSE) across multiple API instances.
- **Implementation:** `RedisSubscriber` handles subscribing to channels and routing to in-memory handlers.
