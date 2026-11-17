// Package keypool is the Gemini API key serving pool — one component,
// one responsibility: hold the keys, hand out a uniform-random healthy
// key per request, record the outcome, and report masked stats.
//
// The pool knows nothing about HTTP, tiers, or the admin panel. Callers
// (the Go AI engine, the internal /internal/pool endpoints) drive it.
// Keys enter from the environment (GEMINI_API_KEYS, comma-separated, +
// legacy single GEMINI_API_KEY) at boot, and from the admin panel later
// via Add — both paths land in the same in-memory pool, so a mechanism
// change here cannot break any other service.
//
// Security rules enforced here, not by convention elsewhere:
//   - A key VALUE is never logged, never returned by Stats, and never
//     leaves this package except as the Authorization header of an
//     outbound Gemini call made by the engine.
//   - Stats expose only the SHA-256 fingerprint (first 12 hex chars),
//     the source, and counters. A fingerprint identifies a key without
//     revealing any of its characters.
//   - A key that fails consecutively is cooled down instead of being
//     retried forever: after cooldownAfter failures it is skipped for
//     cooldownFor, so one dead key (e.g. a project with no free tier)
//     cannot stall a customer — the next random key is tried instead.
package keypool

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Defaults: 3 consecutive failures put a key on cooldown for 10 minutes.
// Both are env-overridable (GEMINI_KEY_COOLDOWN_AFTER,
// GEMINI_KEY_COOLDOWN_SEC) so an operator can tune without a rebuild.
const (
	defaultCooldownAfter = 3
	defaultCooldownFor   = 10 * time.Minute
)

// Entry is one key in the pool. value is the secret itself; everything
// else is bookkeeping safe to expose.
type Entry struct {
	value           string
	fp              string // sha256 hex, first 12 chars — the public id
	source          string // "env" | "admin"
	label           string
	modelOverride   string // pinned model when the default 404s for this key (see below)
	uses            int
	successes       int
	failures        int
	consecutive     int
	cooldownUntil   time.Time
	lastUsed        time.Time
	lastFailureAt   time.Time
	lastFailureKind string
}

// Stat is the admin-safe view of one Entry. No key material.
// Model is the pinned model override ("" = the pool default model).
type Stat struct {
	Fingerprint   string    `json:"fingerprint"`
	Source        string    `json:"source"`
	Label         string    `json:"label"`
	Model         string    `json:"model,omitempty"`
	Uses          int       `json:"uses"`
	Successes     int       `json:"successes"`
	Failures      int       `json:"failures"`
	Healthy       bool      `json:"healthy"`
	CooldownUntil time.Time `json:"cooldown_until,omitempty"`
	LastUsed      time.Time `json:"last_used,omitempty"`
	LastFailure   string    `json:"last_failure,omitempty"`
}

// Candidate is one key handed to the engine for a single attempt: the
// value (used only as the outbound API header) and its fingerprint
// (used for reporting and logging). Values never leave the process
// except in that header.
type Candidate struct {
	Value       string
	Fingerprint string
}

// Pool is the serving pool. All methods are safe for concurrent use.
type Pool struct {
	mu            sync.Mutex
	entries       []*Entry
	cooldownAfter int
	cooldownFor   time.Duration
}

// Fingerprint identifies a key without revealing it.
func Fingerprint(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:12]
}

// NewFromEnv builds a pool from GEMINI_API_KEYS (comma-separated) plus
// the legacy single GEMINI_API_KEY. Duplicates (same fingerprint) are
// dropped — an operator re-listing a key in both vars must not double
// its selection weight. An empty env yields an empty pool (Len() == 0);
// the engine then skips the pool leg entirely.
func NewFromEnv() *Pool {
	p := &Pool{
		cooldownAfter: envInt("GEMINI_KEY_COOLDOWN_AFTER", defaultCooldownAfter),
		cooldownFor:   time.Duration(envInt("GEMINI_KEY_COOLDOWN_SEC", int(defaultCooldownFor/time.Second))) * time.Second,
	}
	seen := map[string]bool{}
	add := func(value, source string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		fp := Fingerprint(value)
		if seen[fp] {
			return
		}
		seen[fp] = true
		p.entries = append(p.entries, &Entry{value: value, fp: fp, source: source})
	}
	for _, v := range strings.Split(os.Getenv("GEMINI_API_KEYS"), ",") {
		add(v, "env")
	}
	add(os.Getenv("GEMINI_API_KEY"), "env")
	if len(p.entries) > 0 {
		log.Printf("[keypool] loaded %d key(s) from env", len(p.entries))
	}
	return p
}

func envInt(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// Len returns the number of keys in the pool (healthy or not).
func (p *Pool) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.entries)
}

// HealthyCount returns the number of keys not currently on cooldown.
func (p *Pool) HealthyCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.healthyLocked(time.Now()))
}

func (p *Pool) healthyLocked(now time.Time) []*Entry {
	out := make([]*Entry, 0, len(p.entries))
	for _, e := range p.entries {
		if e.cooldownUntil.IsZero() || now.After(e.cooldownUntil) {
			out = append(out, e)
		}
	}
	return out
}

// Shuffled returns the healthy keys as Candidates in uniform-random
// order. One call per request: the caller walks the list in order, so
// a request tries each healthy key at most once and the first key
// tried is uniformly random across keys. When every key is on cooldown
// it returns the single key whose cooldown expires soonest — a request
// still tries something (it fails fast) and falls through to the next
// tier instead of failing outright.
func (p *Pool) Shuffled() []Candidate {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	healthy := p.healthyLocked(now)
	if len(healthy) == 0 {
		if len(p.entries) == 0 {
			return nil
		}
		soonest := p.entries[0]
		for _, e := range p.entries[1:] {
			if e.cooldownUntil.Before(soonest.cooldownUntil) {
				soonest = e
			}
		}
		return []Candidate{{Value: soonest.value, Fingerprint: soonest.fp}}
	}
	rand.Shuffle(len(healthy), func(i, j int) { healthy[i], healthy[j] = healthy[j], healthy[i] })
	out := make([]Candidate, len(healthy))
	for i, e := range healthy {
		out[i] = Candidate{Value: e.value, Fingerprint: e.fp}
	}
	return out
}

// Report records one attempt's outcome for the key with this
// fingerprint. A success resets the consecutive-failure count; a
// failure increments it and opens the cooldown once the threshold is
// reached. Unknown fingerprints are ignored (a key removed mid-flight).
func (p *Pool) Report(fp string, err error, kind string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.entries {
		if e.fp != fp {
			continue
		}
		e.uses++
		e.lastUsed = time.Now()
		if err == nil {
			e.successes++
			e.consecutive = 0
			e.lastFailureKind = ""
			return
		}
		e.failures++
		e.consecutive++
		e.lastFailureAt = time.Now()
		e.lastFailureKind = kind
		if e.consecutive >= p.cooldownAfter {
			e.cooldownUntil = time.Now().Add(p.cooldownFor)
			log.Printf("[keypool] key %s cooling down for %s after %d consecutive failures (%s)", e.fp, p.cooldownFor, e.consecutive, kind)
			e.consecutive = 0
		}
		return
	}
}

// Stats returns the admin-safe view of every key. Key values never
// leave this package through Stats.
func (p *Pool) Stats() []Stat {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	out := make([]Stat, 0, len(p.entries))
	for _, e := range p.entries {
		healthy := e.cooldownUntil.IsZero() || now.After(e.cooldownUntil)
		out = append(out, Stat{
			Fingerprint:   e.fp,
			Source:        e.source,
			Label:         e.label,
			Model:         e.modelOverride,
			Uses:          e.uses,
			Successes:     e.successes,
			Failures:      e.failures,
			Healthy:       healthy,
			CooldownUntil: e.cooldownUntil,
			LastUsed:      e.lastUsed,
			LastFailure:   e.lastFailureKind,
		})
	}
	return out
}

// ModelFor returns the pinned model override for a key, or "" when
// the key uses the pool default model.
func (p *Pool) ModelFor(fp string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.entries {
		if e.fp == fp {
			return e.modelOverride
		}
	}
	return ""
}

// SetModelOverride pins a model for one key. Called when the default
// model 404s with "no longer available" for that key's project
// (live 2026-11-17: Google gates gemini-2.5-flash for new users, who
// must use gemini-3.8-flash instead). The pin lives for the process
// lifetime; an ai restart re-learns it on the first 404 (one wasted
// attempt). Unknown fingerprints are ignored.
func (p *Pool) SetModelOverride(fp, model string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.entries {
		if e.fp == fp {
			e.modelOverride = model
			return
		}
	}
}

// Add inserts a key (admin path). The value is validated for shape
// only — liveness is the caller's job (live-probe before Add). A
// duplicate fingerprint returns the existing fingerprint with no change.
func (p *Pool) Add(value, source, label string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 20 {
		return "", errInvalidKey
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-') {
			return "", errInvalidKey
		}
	}
	fp := Fingerprint(value)
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.entries {
		if e.fp == fp {
			return fp, nil
		}
	}
	p.entries = append(p.entries, &Entry{value: value, fp: fp, source: source, label: label})
	log.Printf("[keypool] key %s added (source=%s)", fp, source)
	return fp, nil
}

// Remove drops the key with this fingerprint. Returns false when the
// fingerprint is unknown.
func (p *Pool) Remove(fp string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, e := range p.entries {
		if e.fp == fp {
			p.entries = append(p.entries[:i], p.entries[i+1:]...)
			log.Printf("[keypool] key %s removed", fp)
			return true
		}
	}
	return false
}

// errInvalidKey is returned by Add for a value that cannot be a Gemini
// API key (too short or outside the key charset).
var errInvalidKey = errInvalidKeyType{}

type errInvalidKeyType struct{}

func (errInvalidKeyType) Error() string {
	return "invalid key: expected a Gemini API key (at least 20 characters, letters/digits/._-)"
}
