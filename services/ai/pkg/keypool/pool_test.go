package keypool

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// testPool builds a pool with n distinct keys, bypassing env.
func testPool(t *testing.T, n int) *Pool {
	t.Helper()
	p := &Pool{cooldownAfter: 3, cooldownFor: 10 * time.Minute}
	for i := 0; i < n; i++ {
		fp, err := p.Add(fmt.Sprintf("AIzaSyTestKey%02d-abcdefghij", i), "env", "")
		if err != nil || fp == "" {
			t.Fatalf("Add key %d: fp=%q err=%v", i, fp, err)
		}
	}
	return p
}

func TestFingerprintStableAndMasked(t *testing.T) {
	a := Fingerprint("AIzaSyTestKey00-abcdefghij")
	b := Fingerprint("AIzaSyTestKey00-abcdefghij")
	if a != b {
		t.Fatalf("fingerprint not stable: %q vs %q", a, b)
	}
	if len(a) != 12 {
		t.Fatalf("fingerprint length = %d, want 12", len(a))
	}
	if a == "AIzaSyTestKey00-abcdefghij" {
		t.Fatal("fingerprint equals the key value")
	}
	if Fingerprint("AIzaSyTestKey01-abcdefghij") == a {
		t.Fatal("different keys share a fingerprint")
	}
}

func TestAddValidationAndDedupe(t *testing.T) {
	p := &Pool{cooldownAfter: 3, cooldownFor: time.Minute}
	if _, err := p.Add("short", "admin", ""); err == nil {
		t.Fatal("short key accepted")
	}
	if _, err := p.Add("has space in it 1234567890", "admin", ""); err == nil {
		t.Fatal("key with spaces accepted")
	}
	fp1, err := p.Add("AIzaSyValidKey0123456789", "admin", "main")
	if err != nil {
		t.Fatalf("valid key rejected: %v", err)
	}
	fp2, err := p.Add("AIzaSyValidKey0123456789", "env", "")
	if err != nil || fp1 != fp2 {
		t.Fatalf("duplicate add: fp1=%q fp2=%q err=%v", fp1, fp2, err)
	}
	if p.Len() != 1 {
		t.Fatalf("Len() = %d after duplicate add, want 1", p.Len())
	}
}

func TestPickUniformRandom(t *testing.T) {
	p := testPool(t, 3)
	counts := map[string]int{}
	const n = 3000
	for i := 0; i < n; i++ {
		cands := p.Shuffled()
		if len(cands) != 3 {
			t.Fatalf("Shuffled() len = %d, want 3", len(cands))
		}
		counts[cands[0].Fingerprint]++
	}
	// Uniform random: each key first ~1000/3000 times. A 20% band is
	// far outside random noise at n=3000 (sigma ~26).
	for fp, c := range counts {
		if c < 800 || c > 1200 {
			t.Fatalf("key %s picked first %d/%d times — not uniform", fp, c, n)
		}
	}
}

func TestShuffledNoRepeatWithinRequest(t *testing.T) {
	p := testPool(t, 3)
	seen := map[string]bool{}
	for _, c := range p.Shuffled() {
		if seen[c.Fingerprint] {
			t.Fatalf("fingerprint %s appears twice in one shuffle", c.Fingerprint)
		}
		seen[c.Fingerprint] = true
	}
}

func TestCooldownAfterConsecutiveFailures(t *testing.T) {
	p := testPool(t, 2)
	cands := p.Shuffled()
	victim := cands[0].Fingerprint
	// Two failures: still healthy.
	p.Report(victim, errors.New("boom"), "status 500")
	p.Report(victim, errors.New("boom"), "status 500")
	if p.HealthyCount() != 2 {
		t.Fatalf("HealthyCount = %d after 2 failures, want 2", p.HealthyCount())
	}
	// Third consecutive failure: cooldown opens.
	p.Report(victim, errors.New("boom"), "status 500")
	if p.HealthyCount() != 1 {
		t.Fatalf("HealthyCount = %d after 3 failures, want 1", p.HealthyCount())
	}
	// The cooled-down key is never first while the other is healthy.
	for i := 0; i < 50; i++ {
		if got := p.Shuffled()[0].Fingerprint; got == victim {
			t.Fatalf("cooled-down key %s picked while another key is healthy", victim)
		}
	}
	// A success resets the consecutive count.
	other := ""
	for _, c := range p.Shuffled() {
		other = c.Fingerprint
	}
	p.Report(other, errors.New("boom"), "status 500")
	p.Report(other, errors.New("boom"), "status 500")
	p.Report(other, nil, "")
	p.Report(other, errors.New("boom"), "status 500")
	p.Report(other, errors.New("boom"), "status 500")
	if p.HealthyCount() != 1 {
		t.Fatalf("HealthyCount = %d after success-reset + 2 failures, want 1 (no cooldown)", p.HealthyCount())
	}
}

func TestAllCooledDownStillTriesOne(t *testing.T) {
	p := testPool(t, 2)
	for _, c := range p.Shuffled() {
		p.Report(c.Fingerprint, errors.New("boom"), "status 500")
		p.Report(c.Fingerprint, errors.New("boom"), "status 500")
		p.Report(c.Fingerprint, errors.New("boom"), "status 500")
	}
	if p.HealthyCount() != 0 {
		t.Fatalf("HealthyCount = %d, want 0", p.HealthyCount())
	}
	got := p.Shuffled()
	if len(got) != 1 {
		t.Fatalf("Shuffled() with all keys cooled down returned %d candidates, want 1", len(got))
	}
}

func TestRemoveAndStatsMasked(t *testing.T) {
	p := testPool(t, 2)
	stats := p.Stats()
	if len(stats) != 2 {
		t.Fatalf("Stats len = %d, want 2", len(stats))
	}
	for _, s := range stats {
		if len(s.Fingerprint) != 12 {
			t.Fatalf("stat fingerprint %q is not 12 chars", s.Fingerprint)
		}
	}
	victim := stats[0].Fingerprint
	if !p.Remove(victim) {
		t.Fatal("Remove returned false for a known fingerprint")
	}
	if p.Len() != 1 {
		t.Fatalf("Len() = %d after remove, want 1", p.Len())
	}
	if p.Remove(victim) {
		t.Fatal("Remove returned true for an already-removed fingerprint")
	}
	if p.Remove("nonexistent1") {
		t.Fatal("Remove returned true for an unknown fingerprint")
	}
}

func TestNewFromEnvDedupes(t *testing.T) {
	t.Setenv("GEMINI_API_KEYS", "AIzaSyEnvKey0123456789, AIzaSyEnvKey0123456789 , AIzaSyEnvKey1123456789")
	t.Setenv("GEMINI_API_KEY", "AIzaSyEnvKey0123456789")
	p := NewFromEnv()
	if p.Len() != 2 {
		t.Fatalf("Len() = %d, want 2 (duplicates across both vars dropped)", p.Len())
	}
}

func TestNewFromEnvEmpty(t *testing.T) {
	t.Setenv("GEMINI_API_KEYS", "")
	t.Setenv("GEMINI_API_KEY", "")
	p := NewFromEnv()
	if p.Len() != 0 {
		t.Fatalf("Len() = %d, want 0", p.Len())
	}
	if p.Shuffled() != nil {
		t.Fatal("Shuffled() on an empty pool is not nil")
	}
}
