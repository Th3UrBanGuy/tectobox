package router

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/keypool"
)

// fakeGemini is a stand-in for generativelanguage.googleapis.com: it
// 403s the key named badKey (the live key3 case: project without a
// free tier) and answers 200 for every other key.
func fakeGemini(t *testing.T, badKey string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("x-goog-api-key")
		w.Header().Set("Content-Type", "application/json")
		if key == badKey {
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error": map[string]interface{}{"code": 403, "message": "The Gemini API free tier is not available for this project."},
			})
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{
				{"content": map[string]interface{}{"parts": []map[string]interface{}{{"text": "hello from gemini"}}}},
			},
		})
	}))
}

func testPoolEngine(t *testing.T, srv *httptest.Server, keys ...string) *Engine {
	t.Helper()
	t.Setenv("GEMINI_DIRECT_BASE_URL", srv.URL)
	t.Setenv("GEMINI_API_KEYS", "")
	t.Setenv("GEMINI_API_KEY", "")
	pool := keypool.NewFromEnv()
	for _, k := range keys {
		if _, err := pool.Add(k, "env", ""); err != nil {
			t.Fatalf("pool.Add: %v", err)
		}
	}
	return &Engine{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		keyPool:    pool,
		cache:      NewCache(),
	}
}

// A dead key (403, like live key3) must not sink the request: the pool
// leg reports the failure, tries the next random key, and the customer
// still gets a model reply. The first key tried is uniform-random, so
// the test repeats the call until the dead key has been attempted once
// (each attempt tries it first with probability 1/2).
func TestTryGeminiPoolFallsThroughDeadKey(t *testing.T) {
	bad := "AQAb8DeadKey0123456789abcdefghij"
	good := "AIzaSyGoodKey0123456789abcdefghij"
	srv := fakeGemini(t, bad)
	defer srv.Close()
	e := testPoolEngine(t, srv, bad, good)
	badFP := keypool.Fingerprint(bad)
	goodFP := keypool.Fingerprint(good)

	deadTried := false
	for i := 0; i < 10 && !deadTried; i++ {
		reply, model, err := e.tryGeminiPool(context.Background(), "sys", "hi", nil)
		if err != nil {
			t.Fatalf("tryGeminiPool attempt %d: %v", i, err)
		}
		if reply != "hello from gemini" {
			t.Fatalf("attempt %d: reply = %q, want %q", i, reply, "hello from gemini")
		}
		if !strings.HasPrefix(model, "direct-gemini-api:"+goodFP) {
			t.Fatalf("attempt %d: model = %q, want direct-gemini-api:%s", i, model, goodFP)
		}
		for _, s := range e.keyPool.Stats() {
			if s.Fingerprint == badFP && s.Failures >= 1 {
				deadTried = true
			}
		}
	}
	if !deadTried {
		t.Fatal("dead key was never attempted in 10 tries (p < 0.001 if random)")
	}
	// The dead key recorded exactly one failure; the good key recorded
	// the successes.
	for _, s := range e.keyPool.Stats() {
		switch s.Fingerprint {
		case badFP:
			if s.Failures != 1 {
				t.Fatalf("dead key failures = %d, want 1", s.Failures)
			}
		case goodFP:
			if s.Successes < 1 {
				t.Fatalf("serving key successes = %d, want >= 1", s.Successes)
			}
		}
	}
}

// With a healthy pool, tryDirectAPIs must serve from the pool WITHOUT
// touching web2api (the web2api URL here is a server that would fail
// the test if called). This proves the 2026-11-17 order: pool first,
// web2api fallback.
func TestTryDirectAPIsPoolBeforeWeb2API(t *testing.T) {
	good := "AIzaSyGoodKey0123456789abcdefghij"
	geminiSrv := fakeGemini(t, "no-such-bad-key")
	defer geminiSrv.Close()
	e := testPoolEngine(t, geminiSrv, good)

	web2apiHit := false
	web2apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		web2apiHit = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer web2apiSrv.Close()
	t.Setenv("GEMINI_WEB2API_PROXY_URL", web2apiSrv.URL+"/v1/chat/completions")
	t.Setenv("GEMINI_WEB2API_KEY", "proxy-key-0123456789")

	reply, model, err := e.tryDirectAPIs(context.Background(), PromptContext{}, "sys", "hi", nil)
	if err != nil {
		t.Fatalf("tryDirectAPIs: %v", err)
	}
	if reply != "hello from gemini" {
		t.Fatalf("reply = %q, want pool reply", reply)
	}
	if !strings.HasPrefix(model, "direct-gemini-api:") {
		t.Fatalf("model = %q, want direct-gemini-api:<fp>", model)
	}
	if web2apiHit {
		t.Fatal("web2api was called even though the pool succeeded")
	}
}

// When the pool is empty AND web2api is unset, tryDirectAPIs fails
// cleanly (no panic, no hang) so the caller falls through to Tier 4.
func TestTryDirectAPIsEmptyPoolNoWeb2API(t *testing.T) {
	t.Setenv("GEMINI_API_KEYS", "")
	t.Setenv("GEMINI_API_KEY", "")
	t.Setenv("GEMINI_WEB2API_PROXY_URL", "")
	t.Setenv("GEMINI_WEB2API_KEY", "")
	t.Setenv("OPENROUTER_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	e := &Engine{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		keyPool:    keypool.NewFromEnv(),
		cache:      NewCache(),
	}
	_, _, err := e.tryDirectAPIs(context.Background(), PromptContext{}, "sys", "hi", nil)
	if err == nil {
		t.Fatal("expected an error with no backends configured")
	}
}
