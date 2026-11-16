package router

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/detector"
)

// CacheEntry is one cached reply with its expiry.
type CacheEntry struct {
	Reply     string
	ExpiresAt time.Time
}

// Cache is a small TTL map for engine replies. It is the only place the
// reply cache lives; the Engine holds one and never touches the map
// directly.
type Cache struct {
	mu      sync.RWMutex
	entries map[string]CacheEntry
}

// NewCache returns an empty reply cache.
func NewCache() *Cache {
	return &Cache{entries: make(map[string]CacheEntry)}
}

// StartSweeper launches the periodic expired-entry cleanup. It runs until
// the process exits (same lifetime as the Engine that owns the cache).
func (c *Cache) StartSweeper(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		for range ticker.C {
			c.CleanExpired()
		}
	}()
}

// CleanExpired drops every entry whose TTL has passed.
func (c *Cache) CleanExpired() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, v := range c.entries {
		if now.After(v.ExpiresAt) {
			delete(c.entries, k)
		}
	}
}

// Get returns the cached reply for key, or ("", false) when absent/expired.
func (c *Cache) Get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.entries[key]
	if !ok || time.Now().After(entry.ExpiresAt) {
		return "", false
	}
	return entry.Reply, true
}

// Set stores a reply for key for ttl.
func (c *Cache) Set(key, val string, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = CacheEntry{
		Reply:     val,
		ExpiresAt: time.Now().Add(ttl),
	}
}

// cacheKey is the tenant- AND conversation-isolation rule for the reply
// cache: the SHA-256 of client + conversation + language + FULL-history
// hash + text + payment. Two workspaces never share a key (their
// ClientID differs), and two customers of the SAME workspace never share
// one either (their ConversationID differs) — even when their last
// history turn is the identical generic bot reply. That was the
// 2026-11-16 scenario-audit leak (#1, CRITICAL): the key hashed only
// the LAST history turn, so six customers who had all just received the
// same "Message korar jonno dhonnobad!..." reply hashed to one key and
// were served the first customer's reply — with another customer's name,
// phone and address in it. The full-history hash is the second guard:
// callers that cannot send a conversation id (the generic
// /v1/chat/completions path) still cannot collide unless their ENTIRE
// histories are identical. The ClientID part is what the F1 leak broke:
// a nil/empty ClientID made every workspace hash to one shared key. The
// /api/ai/chat handler now rejects a missing client_id (see pkg/server)
// so this function never receives the "<nil>" placeholder.
func cacheKey(clientID, conversationID string, lang detector.Language, text string, history []ChatMessage, payment PaymentConfig) string {
	h := sha256.New()
	// Full-history hash: every turn (role + normalized content), not
	// just the last one. Two customers never share a whole history.
	var hb strings.Builder
	for _, m := range history {
		hb.WriteString(m.Role)
		hb.WriteString(":")
		hb.WriteString(strings.ToLower(strings.TrimSpace(m.Content)))
		hb.WriteString("\n")
	}
	historyHash := sha256.Sum256([]byte(hb.String()))
	// The payment config is part of the key: a payment answer cached
	// before the owner saved their settings must not keep serving the
	// stale "not configured" reply (2026-11-16 probe D).
	paymentHash := fmt.Sprintf("%s|%d|%s|%s|%s", payment.Modes, payment.AdvanceBDT, payment.Bkash, payment.Nagad, payment.Rocket)
	h.Write([]byte(clientID + ":" + conversationID + ":" + string(lang) + ":" + hex.EncodeToString(historyHash[:]) + ":" + strings.ToLower(strings.TrimSpace(text)) + ":" + paymentHash))
	return hex.EncodeToString(h.Sum(nil))
}
