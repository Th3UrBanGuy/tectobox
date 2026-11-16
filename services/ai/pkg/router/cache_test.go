package router

import (
	"testing"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/detector"
)

// Regression tests for the 2026-11-16 scenario-audit leak (#1, CRITICAL):
// the old cacheKey hashed only the LAST history turn, so six customers
// who had all just received the identical generic bot reply
// ("Message korar jonno dhonnobad!...") hashed to one key and were
// served the first customer's reply — with another customer's name,
// phone and address in it. The key now carries the conversation id AND
// a hash of the FULL history, so neither coincidence can collide again.

// The exact S1 shape: same client, same language, same incoming text,
// same last (generic) bot turn — but two different customers.
func TestCacheKey_ScopesByConversation(t *testing.T) {
	history := []ChatMessage{
		{Role: "user", Content: "Amar nam Rahim, phone 01711111111, thikana Dhanmondi"},
		{Role: "assistant", Content: "Message korar jonno dhonnobad! Apnar nam likhe din."},
	}
	a := cacheKey("69", "conv-rahim", detector.LangBanglish, "he", history, PaymentConfig{})
	b := cacheKey("69", "conv-jamal", detector.LangBanglish, "he", history, PaymentConfig{})
	if a == b {
		t.Fatalf("cache keys must differ across conversations; both were %s", a)
	}
}

// The cache must still HIT for the same conversation asking the same
// thing in the same state — scoping must not kill caching outright.
func TestCacheKey_SameConversationSameHistory_Hits(t *testing.T) {
	history := []ChatMessage{
		{Role: "user", Content: "Kitkat er dam koto?"},
		{Role: "assistant", Content: "Kitkat er dam 900 taka."},
	}
	a := cacheKey("69", "conv-1", detector.LangBanglish, "he", history, PaymentConfig{})
	b := cacheKey("69", "conv-1", detector.LangBanglish, "he", history, PaymentConfig{})
	if a != b {
		t.Fatalf("cache keys must match for identical inputs; got %s vs %s", a, b)
	}
}

// Second guard: even with NO conversation id (generic callers), two
// customers whose LAST turn matches but whose EARLIER turns differ must
// not collide — the key hashes the full history, not just the last turn.
func TestCacheKey_FullHistoryMattersWithoutConversation(t *testing.T) {
	last := ChatMessage{Role: "assistant", Content: "Message korar jonno dhonnobad! Apnar nam likhe din."}
	a := cacheKey("69", "", detector.LangBanglish, "he", []ChatMessage{
		{Role: "user", Content: "Amar nam Rahim, phone 01711111111"},
		last,
	}, PaymentConfig{})
	b := cacheKey("69", "", detector.LangBanglish, "he", []ChatMessage{
		{Role: "user", Content: "Amar nam Jamal, phone 01744444444"},
		last,
	}, PaymentConfig{})
	if a == b {
		t.Fatalf("cache keys must differ when earlier history differs, even with empty conversation id; both were %s", a)
	}
}
