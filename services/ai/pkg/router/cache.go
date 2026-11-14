package router

import (
	"crypto/sha256"
	"encoding/hex"
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

// cacheKey is the tenant-isolation rule for the reply cache: the SHA-256
// of client + language + last history turn + text. Two workspaces never
// share a key (their ClientID differs), and the same workspace re-asks
// the same question in the same language and gets its own cached reply.
// The ClientID part is what the F1 leak broke: a nil/empty ClientID made
// every workspace hash to one shared key. The /api/ai/chat handler now
// rejects a missing client_id (see pkg/server) so this function never
// receives the "<nil>" placeholder.
func cacheKey(clientID string, lang detector.Language, text string, history []ChatMessage) string {
	h := sha256.New()
	historyHash := ""
	if len(history) > 0 {
		last := history[len(history)-1]
		historyHash = last.Role + ":" + strings.ToLower(strings.TrimSpace(last.Content))
	}
	h.Write([]byte(clientID + ":" + string(lang) + ":" + historyHash + ":" + strings.ToLower(strings.TrimSpace(text))))
	return hex.EncodeToString(h.Sum(nil))
}
