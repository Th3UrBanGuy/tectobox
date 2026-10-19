package router

import (
	"sync"
	"time"
)

// TokenBucket implements a high-throughput, thread-safe token bucket rate limiter.
type TokenBucket struct {
	capacity   float64
	tokens     float64
	refillRate float64 // tokens per second
	lastRefill time.Time
	mu         sync.Mutex
}

// NewTokenBucket creates a bucket with given burst capacity and steady refill rate.
func NewTokenBucket(capacity float64, refillRate float64) *TokenBucket {
	return &TokenBucket{
		capacity:   capacity,
		tokens:     capacity,
		refillRate: refillRate,
		lastRefill: time.Now(),
	}
}

// Allow consumes 1 token if available, returning true. If dry, returns false without blocking.
func (tb *TokenBucket) Allow() bool {
	return tb.AllowN(1)
}

// AllowN consumes n tokens if available.
func (tb *TokenBucket) AllowN(n float64) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(tb.lastRefill).Seconds()
	tb.lastRefill = now

	// Refill tokens based on elapsed time up to capacity
	tb.tokens = tb.tokens + (elapsed * tb.refillRate)
	if tb.tokens > tb.capacity {
		tb.tokens = tb.capacity
	}

	if tb.tokens >= n {
		tb.tokens -= n
		return true
	}

	return false
}

// RateLimiterManager tracks per-workspace and per-IP token buckets and brute-force defenses.
type RateLimiterManager struct {
	workspaceBuckets map[string]*TokenBucket
	ipBuckets        map[string]*TokenBucket
	failedAttempts   map[string]int
	blockedUntil     map[string]time.Time
	mu               sync.RWMutex
}

var globalLimiter *RateLimiterManager
var limiterOnce sync.Once

// GetRateLimiterManager returns the singleton rate limiter manager.
func GetRateLimiterManager() *RateLimiterManager {
	limiterOnce.Do(func() {
		globalLimiter = &RateLimiterManager{
			workspaceBuckets: make(map[string]*TokenBucket),
			ipBuckets:        make(map[string]*TokenBucket),
			failedAttempts:   make(map[string]int),
			blockedUntil:     make(map[string]time.Time),
		}
		// Periodically clean up stale limiter entries
		go globalLimiter.cleanupLoop()
	})
	return globalLimiter
}

func (rl *RateLimiterManager) cleanupLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for ip, unblockAt := range rl.blockedUntil {
			if now.After(unblockAt) {
				delete(rl.blockedUntil, ip)
				delete(rl.failedAttempts, ip)
			}
		}
		rl.mu.Unlock()
	}
}

// AllowWorkspace checks whether a workspace has token capacity (e.g. 100,000 burst, 50,000/sec refill).
func (rl *RateLimiterManager) AllowWorkspace(workspaceID string) bool {
	if workspaceID == "" {
		workspaceID = "default"
	}

	rl.mu.RLock()
	bucket, exists := rl.workspaceBuckets[workspaceID]
	rl.mu.RUnlock()

	if !exists {
		rl.mu.Lock()
		bucket, exists = rl.workspaceBuckets[workspaceID]
		if !exists {
			// Massive scale bucket: 150,000 capacity burst, 100,000/sec refill for 100k+ parallel msgs
			bucket = NewTokenBucket(150000, 100000)
			rl.workspaceBuckets[workspaceID] = bucket
		}
		rl.mu.Unlock()
	}

	return bucket.Allow()
}

// AllowIP checks whether an incoming IP has rate capacity and is not brute-force blocked.
func (rl *RateLimiterManager) AllowIP(ip string) bool {
	if ip == "" {
		return true
	}

	rl.mu.RLock()
	unblockAt, blocked := rl.blockedUntil[ip]
	rl.mu.RUnlock()

	if blocked {
		if time.Now().Before(unblockAt) {
			return false // Temporarily blocked due to brute-force or abuse
		}
		// Block expired
		rl.mu.Lock()
		delete(rl.blockedUntil, ip)
		delete(rl.failedAttempts, ip)
		rl.mu.Unlock()
	}

	rl.mu.RLock()
	bucket, exists := rl.ipBuckets[ip]
	rl.mu.RUnlock()

	if !exists {
		rl.mu.Lock()
		bucket, exists = rl.ipBuckets[ip]
		if !exists {
			// Per-IP bucket: 2,000 burst, 500/sec refill
			bucket = NewTokenBucket(2000, 500)
			rl.ipBuckets[ip] = bucket
		}
		rl.mu.Unlock()
	}

	return bucket.Allow()
}

// RecordFailedAuth registers a failed authentication or suspicious request for brute-force protection.
func (rl *RateLimiterManager) RecordFailedAuth(ip string) {
	if ip == "" {
		return
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()

	rl.failedAttempts[ip]++
	if rl.failedAttempts[ip] >= 10 {
		// Block IP for 15 minutes after 10 consecutive auth failures
		rl.blockedUntil[ip] = time.Now().Add(15 * time.Minute)
	}
}

// ResetFailedAuth clears the failed count on successful auth.
func (rl *RateLimiterManager) ResetFailedAuth(ip string) {
	if ip == "" {
		return
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.failedAttempts, ip)
}
