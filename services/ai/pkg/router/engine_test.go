package router

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Acceptance criterion:
// TestDemoResponder_DeliveryUsesKnowledge: delivery question with
// seeded knowledge "Delivery charge 130 taka" returns an answer containing
// 130 (not 60/120); with empty knowledge returns the generic template.
func TestDemoResponder_DeliveryUsesKnowledge(t *testing.T) {
	seededKnowledge := []KnowledgeItem{
		{
			Title:   "Shipping Policy",
			Content: "Delivery charge 130 taka nationwide via Steadfast Courier.",
		},
	}

	// 1. Delivery question with seeded knowledge -> returns 130, not 60/120
	replyWithKnowledge := DemoResponder(
		"en",
		"What is your delivery charge?",
		nil,
		seededKnowledge,
		nil,
	)
	if !strings.Contains(replyWithKnowledge, "130") {
		t.Fatalf("expected reply to contain 130, got: %s", replyWithKnowledge)
	}
	if strings.Contains(replyWithKnowledge, "60") || strings.Contains(replyWithKnowledge, "120") {
		t.Fatalf("expected reply NOT to contain 60 or 120, got: %s", replyWithKnowledge)
	}

	// 2. Delivery question with empty knowledge -> returns generic template (60/120)
	replyWithoutKnowledge := DemoResponder(
		"en",
		"What is your delivery charge?",
		nil,
		nil,
		nil,
	)
	if !strings.Contains(replyWithoutKnowledge, "60") || !strings.Contains(replyWithoutKnowledge, "120") {
		t.Fatalf("expected generic delivery template to contain 60 and 120, got: %s", replyWithoutKnowledge)
	}

	// 3. Bangla delivery question with seeded Bangla knowledge
	seededBanglaKB := []KnowledgeItem{
		{
			Title:   "ডেলিভারি চার্জ",
			Content: "সারা বাংলাদেশে ডেলিভারি চার্জ ১৩০ টাকা ফিক্সড।",
		},
	}
	replyBanglaKB := DemoResponder(
		"bn",
		"আপনাদের ডেলিভারি চার্জ কত?",
		nil,
		seededBanglaKB,
		nil,
	)
	if !strings.Contains(replyBanglaKB, "১৩০") && !strings.Contains(replyBanglaKB, "130") {
		t.Fatalf("expected Bangla delivery reply to contain 130, got: %s", replyBanglaKB)
	}
	if strings.Contains(replyBanglaKB, "৬০") || strings.Contains(replyBanglaKB, "১২০") {
		t.Fatalf("expected Bangla delivery reply NOT to contain default 60/120, got: %s", replyBanglaKB)
	}

	// 4. Bangla delivery question without knowledge -> returns default Bangla 60/120 template
	replyBanglaDefault := DemoResponder(
		"bn",
		"আপনাদের ডেলিভারি চার্জ কত?",
		nil,
		nil,
		nil,
	)
	if !strings.Contains(replyBanglaDefault, "৬০") || !strings.Contains(replyBanglaDefault, "১২০") {
		t.Fatalf("expected default Bangla delivery template with 60/120, got: %s", replyBanglaDefault)
	}
}

// Acceptance criterion:
// F4: word-boundary matching so "চার্জার" (charger) does not match a delivery-charge
// intent and a product named e.g. "Charger X" matches only as a product.
func TestDemoResponder_ChargerProductMatching_F4(t *testing.T) {
	products := []ProductItem{
		{
			Name:     "Charger X",
			PriceBDT: 450,
			Stock:    15,
		},
	}

	// Query in Bengali: "চার্জার এর দাম কত?" (contains "চার্জার", should NOT match delivery "চার্জ")
	replyBn := DemoResponder(
		"bn",
		"চার্জার এর দাম কত?",
		products,
		nil,
		nil,
	)
	if strings.Contains(replyBn, "৬০") || strings.Contains(replyBn, "১২০") || strings.Contains(replyBn, "ডেলিভারি চার্জ") {
		t.Fatalf("F4 regression: 'চার্জার এর দাম কত?' matched delivery charge template! Got: %s", replyBn)
	}
	if !strings.Contains(replyBn, "450") && !strings.Contains(replyBn, "Charger X") {
		t.Fatalf("expected product price reply for Charger X, got: %s", replyBn)
	}

	// Query in English: "How much is the charger?" (contains "charger", should NOT match delivery "charge")
	replyEn := DemoResponder(
		"en",
		"How much is the charger?",
		products,
		nil,
		nil,
	)
	if strings.Contains(replyEn, "60") || strings.Contains(replyEn, "120") || strings.Contains(replyEn, "delivery charge") {
		t.Fatalf("F4 regression: 'How much is the charger?' matched delivery charge template! Got: %s", replyEn)
	}
	if !strings.Contains(replyEn, "450") || !strings.Contains(replyEn, "Charger X") {
		t.Fatalf("expected product price reply for Charger X, got: %s", replyEn)
	}
}

// Out-of-stock alternative prefers the same category as the requested
// product instead of the lowest-id in-stock product (chocklate/food
// must not be offered for an out-of-stock electronics smart watch).
func TestDemoResponder_OutOfStockAlternativePrefersSameCategory(t *testing.T) {
	products := []ProductItem{
		{Name: "chocklate", PriceBDT: 700, Stock: 50, Category: "food"},
		{Name: "Wireless Earbuds Pro", PriceBDT: 2499, Stock: 25, Category: "electronics"},
		{Name: "Smart Watch Fit X2", PriceBDT: 3999, Stock: 0, Category: "electronics"},
	}

	reply := DemoResponder("en", "What is the Smart Watch price?", products, nil, nil)
	if !strings.Contains(reply, "Smart Watch Fit X2") {
		t.Fatalf("expected out-of-stock reply naming the watch, got: %s", reply)
	}
	if !strings.Contains(reply, "Wireless Earbuds Pro") {
		t.Fatalf("expected same-category alternative (Earbuds), got: %s", reply)
	}
	if strings.Contains(reply, "chocklate") {
		t.Fatalf("expected NO food alternative for an electronics item, got: %s", reply)
	}

	// Fallback: no same-category item in stock -> any in-stock item.
	productsNoSameCat := []ProductItem{
		{Name: "chocklate", PriceBDT: 700, Stock: 50, Category: "food"},
		{Name: "Smart Watch Fit X2", PriceBDT: 3999, Stock: 0, Category: "electronics"},
	}
	replyFallback := DemoResponder("en", "What is the Smart Watch price?", productsNoSameCat, nil, nil)
	if !strings.Contains(replyFallback, "chocklate") {
		t.Fatalf("expected fallback to any in-stock item, got: %s", replyFallback)
	}
}

// Farewell gets a closing reply, never the opening greeting.
func TestDemoResponder_FarewellGetsClosingReply(t *testing.T) {
	reply := DemoResponder("en", "Thank you, bye!", nil, nil, nil)
	if !strings.Contains(reply, "welcome") {
		t.Fatalf("expected farewell reply containing 'welcome', got: %s", reply)
	}
	if strings.Contains(reply, "assist you") {
		t.Fatalf("expected NO opening greeting in a farewell reply, got: %s", reply)
	}

	replyBn := DemoResponder("bn", "ধন্যবাদ, বিদায়!", nil, nil, nil)
	if !strings.Contains(replyBn, "ধন্যবাদ") {
		t.Fatalf("expected Bengali farewell reply, got: %s", replyBn)
	}
	if strings.Contains(replyBn, "সাহায্য করতে পারি") {
		t.Fatalf("expected NO opening greeting in a Bengali farewell reply, got: %s", replyBn)
	}

	// A plain greeting still gets the opening greeting.
	greeting := DemoResponder("en", "Hello", nil, nil, nil)
	if !strings.Contains(greeting, "assist you") {
		t.Fatalf("expected greeting to keep the opening reply, got: %s", greeting)
	}
}

// Acceptance criterion:
// TestGenerateReply_KnowledgeIsolation: two workspaces, distinct knowledge,
// sequential + concurrent + cached second call — every reply scoped to its own workspace.
func TestGenerateReply_KnowledgeIsolation(t *testing.T) {
	engine := NewEngine()
	ctx := context.Background()

	pctxA := PromptContext{
		ClientID:   "workspace-a-shop1",
		ClientName: "Shop A Fashion",
		Knowledge: []KnowledgeItem{
			{
				Title:   "Return Policy",
				Content: "10-day return policy for full refund or exchange.",
			},
		},
	}

	pctxB := PromptContext{
		ClientID:   "workspace-b-shop2",
		ClientName: "Shop B Electronics",
		Knowledge: []KnowledgeItem{
			{
				Title:   "Return Policy",
				Content: "Strictly no returns allowed. All sales are final.",
			},
		},
	}

	query := "What is your store return policy?"

	// --- 1. Sequential calls ---
	replyA1, _, modelA1, _ := engine.GenerateReply(ctx, pctxA, query, nil, "")
	if !strings.Contains(replyA1, "10-day") {
		t.Fatalf("Workspace A reply must contain 10-day policy, got: %s (model: %s)", replyA1, modelA1)
	}
	if strings.Contains(replyA1, "no returns") {
		t.Fatalf("Workspace A leaked Workspace B policy! Got: %s", replyA1)
	}

	replyB1, _, modelB1, _ := engine.GenerateReply(ctx, pctxB, query, nil, "")
	if !strings.Contains(replyB1, "no returns") {
		t.Fatalf("Workspace B reply must contain no returns policy, got: %s (model: %s)", replyB1, modelB1)
	}
	if strings.Contains(replyB1, "10-day") {
		t.Fatalf("Workspace B leaked Workspace A policy! Got: %s", replyB1)
	}

	// --- 2. Cached second calls ---
	replyA2, _, modelA2, cachedA2 := engine.GenerateReply(ctx, pctxA, query, nil, "")
	if !cachedA2 && modelA2 != "cache" {
		t.Fatalf("Workspace A second call expected to hit cache, got cached=%v model=%s", cachedA2, modelA2)
	}
	if !strings.Contains(replyA2, "10-day") || strings.Contains(replyA2, "no returns") {
		t.Fatalf("Workspace A cached reply corrupted! Got: %s", replyA2)
	}

	replyB2, _, modelB2, cachedB2 := engine.GenerateReply(ctx, pctxB, query, nil, "")
	if !cachedB2 && modelB2 != "cache" {
		t.Fatalf("Workspace B second call expected to hit cache, got cached=%v model=%s", cachedB2, modelB2)
	}
	if !strings.Contains(replyB2, "no returns") || strings.Contains(replyB2, "10-day") {
		t.Fatalf("Workspace B cached reply corrupted! Got: %s", replyB2)
	}

	// --- 3. Concurrent execution across both workspaces ---
	const concurrency = 20
	var wg sync.WaitGroup
	errCh := make(chan string, concurrency*2)

	for i := 0; i < concurrency; i++ {
		wg.Add(2)
		go func(iter int) {
			defer wg.Done()
			reply, _, _, _ := engine.GenerateReply(ctx, pctxA, query, nil, "")
			if !strings.Contains(reply, "10-day") {
				errCh <- "Concurrent A missing 10-day policy: " + reply
			}
			if strings.Contains(reply, "no returns") {
				errCh <- "Concurrent A leaked Workspace B policy: " + reply
			}
		}(i)

		go func(iter int) {
			defer wg.Done()
			reply, _, _, _ := engine.GenerateReply(ctx, pctxB, query, nil, "")
			if !strings.Contains(reply, "no returns") {
				errCh <- "Concurrent B missing no returns policy: " + reply
			}
			if strings.Contains(reply, "10-day") {
				errCh <- "Concurrent B leaked Workspace A policy: " + reply
			}
		}(i)
	}

	wg.Wait()
	close(errCh)

	for errStr := range errCh {
		t.Fatal(errStr)
	}
}

// TestTier3_SkipSharedWeb2APIForWorkspaceTraffic verifies that Tier 3 gemini-web2api
// is bypassed for workspace traffic (pctx.ClientID != "") to eliminate cross-workspace
// leaks through the unisolated shared web2api proxy session.
func TestTier3_SkipSharedWeb2APIForWorkspaceTraffic(t *testing.T) {
	t.Setenv("GEMINI_WEB2API_PROXY_URL", "http://127.0.0.1:9999/v1/chat/completions")
	t.Setenv("GEMINI_WEB2API_KEY", "dummy-shared-key")

	engine := NewEngine()
	ctx := context.Background()

	pctxWorkspace := PromptContext{
		ClientID:   "workspace-tenant-99",
		ClientName: "Shop 99",
		Knowledge: []KnowledgeItem{
			{
				Title:   "Delivery Policy",
				Content: "Delivery fee is 150 taka nationwide.",
			},
		},
	}

	// For workspace traffic with ClientID, tryDirectAPIs must skip the unisolated web2api endpoint
	// and fall through to DemoResponder without hanging or attempting connection to port 9999.
	reply, _, model, _ := engine.GenerateReply(ctx, pctxWorkspace, "delivery charge", nil, "")
	if !strings.Contains(reply, "150") {
		t.Fatalf("expected workspace reply grounded in knowledge (150), got: %s (model: %s)", reply, model)
	}
	if model == "gemini-web2api:gemini-3.6-flash" {
		t.Fatalf("workspace traffic must not route through shared web2api session")
	}
}

// TestTier3_Web2APITimeoutBounded verifies that when web2api backend is slow / hangs,
// the bounded timeout fires and falls through to Tier 4 demo responder.
func TestTier3_Web2APITimeoutBounded(t *testing.T) {
	// Start a mock slow server that sleeps longer than configured timeout
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"choices":[{"message":{"content":"late"}}]}`))
	}))
	defer server.Close()

	t.Setenv("GEMINI_WEB2API_PROXY_URL", server.URL)
	t.Setenv("GEMINI_WEB2API_KEY", "dummy-key")
	t.Setenv("GEMINI_WEB2API_TIMEOUT_MS", "50") // 50ms bounded timeout for test

	engine := NewEngine()
	ctx := context.Background()

	pctx := PromptContext{
		ClientID: "", // Tier 3 web2api runs when ClientID == ""
		Knowledge: []KnowledgeItem{
			{
				Title:   "Delivery Policy",
				Content: "Delivery fee is 120 taka.",
			},
		},
	}

	start := time.Now()
	reply, _, model, _ := engine.GenerateReply(ctx, pctx, "delivery charge", nil, "")
	dur := time.Since(start)

	if dur > 4*time.Second {
		t.Fatalf("expected bounded timeout within 4s, took %v", dur)
	}
	if !strings.Contains(reply, "120") {
		t.Fatalf("expected fallback demo responder reply containing 120, got: %s (model: %s)", reply, model)
	}
	if model != "deterministic-catalog" {
		t.Fatalf("expected deterministic-catalog model on timeout fallback, got: %s", model)
	}
}
