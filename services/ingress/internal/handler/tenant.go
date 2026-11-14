package handler

import (
	"crypto/subtle"
)

// MaxWebhookBodyBytes is the shared cap on inbound webhook bodies (10 MB).
// It was the same magic literal in both handlers.
const MaxWebhookBodyBytes = 10 << 20

// ResolveTenant resolves a routing key (a Meta page ID or a Telegram bot
// secret token) to a tenant client ID:
//  1. constant-time match against the static map — the key is a secret
//     for Telegram, so the match must not leak the key through timing;
//     Meta page IDs get the same treatment for free;
//  2. otherwise the dynamic resolver (the Redis lookup in main.go),
//     if set.
//
// It returns 0 when neither knows the key; each handler keeps its own
// failure code for that case (meta: 500 so the platform retries,
// telegram: 401/403/500 by branch).
//
// One deliberate corner, documented so it is not "fixed" by accident:
// a static entry with a non-positive value does not count as a match
// and falls through to the dynamic resolver. That is exactly how Meta's
// old lookup behaved (it required cid > 0). Telegram's old loop treated
// a non-positive static value as a match and failed closed with 403;
// that corner (a misconfigured zero-valued map entry plus a dynamic
// resolver that would have matched the same key) now falls through to
// the dynamic resolver instead. No production map holds a non-positive
// value, and no test covers that corner.
func ResolveTenant(static map[string]int, dynamic func(string) int, key string) int {
	if static != nil {
		for k, cid := range static {
			if subtle.ConstantTimeCompare([]byte(key), []byte(k)) == 1 && cid > 0 {
				return cid
			}
		}
	}
	if dynamic != nil {
		return dynamic(key)
	}
	return 0
}
