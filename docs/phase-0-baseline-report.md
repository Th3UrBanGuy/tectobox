# Phase 0 Baseline Report

## Security Audit
- **Git History & Tracked Files**: Scanned using `gitleaks`. Found 2 alerts in `public/api-docs.html` which turned out to be false positives (`tk_YOUR_KEY` placeholder tokens). No actual credentials, tokens, or sensitive information were exposed in the history.
- **Environment Scripts**: Reviewed `.env.example`, `monitor.sh`, `start-stack.sh`, `build-slim-image.sh`, and `rebuild-image.sh` for hardcoded secrets. Validated that only placeholders and locally seeded container hash states are present. The `rebuild-image.sh` handles SSH passwords dynamically via seeded hashes rather than plaintexts.

## Regression Testing Suite
Established a comprehensive Node.js testing script (`old-code/test-regression.js`) covering the system's critical paths:
1. **Tenant Isolation**: Validated that querying a product via SKU with one `client_id` (tenant) cannot bleed into another. Data access is strictly compartmentalized per workspace ID.
2. **Order Idempotency**: Created test enforcing `idempotency_key` behavior in `createOrder` DB logic. Replaying identical checkout events safely retrieves the same DB record instead of double-charging.
3. **WhatsApp Pacer**: Simulated outbound WhatsApp sends through the pacer queue (`src/pacer.js`) and verified accurate stats tracking and execution queue buffering limits.
4. **Broadcast Pump Recovery**: Configured a sending campaign via `setBroadcastStatus`, verifying that state and recipients persist to the SQLite backend and maintain accurate tracking for retry on server boot.
5. **Meta HMAC Verification**: Generated inbound requests against Express webhook routes to assure validation blocks requests possessing malformed `X-Hub-Signature-256`. 
6. **Telegram Webhook Secret validation**: Verified Telegram endpoints respond securely to unauthorized/bad webhook URLs based on `TELEGRAM_WEBHOOK_SECRET`.
7. **Webhook Deduplication**: Executed concurrent race tests simulating identical webhook receipts by validating that concurrent API posts for the same payload returned the deduplicated JSON `{"deduped": true}` response format.

## Conclusion
The legacy architecture is baselined and its fundamental behaviors are characterized effectively, providing a safe starting point to proceed to the Phase 1 microservices extraction.

