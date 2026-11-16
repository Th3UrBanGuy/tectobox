package router

import (
	"context"
	"encoding/json"
	"io"
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
		PaymentConfig{},
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
		PaymentConfig{},
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
		PaymentConfig{},
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
		PaymentConfig{},
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
		PaymentConfig{},
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
		PaymentConfig{},
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

	reply := DemoResponder("en", "What is the Smart Watch price?", products, nil, nil, PaymentConfig{})
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
	replyFallback := DemoResponder("en", "What is the Smart Watch price?", productsNoSameCat, nil, nil, PaymentConfig{})
	if !strings.Contains(replyFallback, "chocklate") {
		t.Fatalf("expected fallback to any in-stock item, got: %s", replyFallback)
	}
}

// Farewell gets a closing reply, never the opening greeting.
func TestDemoResponder_FarewellGetsClosingReply(t *testing.T) {
	reply := DemoResponder("en", "Thank you, bye!", nil, nil, nil, PaymentConfig{})
	if !strings.Contains(reply, "welcome") {
		t.Fatalf("expected farewell reply containing 'welcome', got: %s", reply)
	}
	if strings.Contains(reply, "assist you") {
		t.Fatalf("expected NO opening greeting in a farewell reply, got: %s", reply)
	}

	replyBn := DemoResponder("bn", "ধন্যবাদ, বিদায়!", nil, nil, nil, PaymentConfig{})
	if !strings.Contains(replyBn, "ধন্যবাদ") {
		t.Fatalf("expected Bengali farewell reply, got: %s", replyBn)
	}
	if strings.Contains(replyBn, "সাহায্য করতে পারি") {
		t.Fatalf("expected NO opening greeting in a Bengali farewell reply, got: %s", replyBn)
	}

	// A plain greeting still gets the opening greeting.
	greeting := DemoResponder("en", "Hello", nil, nil, nil, PaymentConfig{})
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

// TestTier3_Web2APIPrimaryForWorkspaceTraffic verifies that Tier 3
// gemini-web2api is the PRIMARY backend for workspace traffic too
// (user order 2026-11-15). The old F1 guard skipped web2api for
// workspaces fearing leaks through the shared session; live probe
// 2026-11-15 proved the endpoint stateless per request (marker
// "ZEBRA-9911" planted in one call was unknown to the next), so a
// request only ever sees the messages it carries — and GenerateReply
// builds those per workspace (prompt.go). The mock backend answers
// only when the system prompt carries this workspace's knowledge, so
// a web2api-model reply also proves the prompt was scoped correctly.
func TestTier3_Web2APIPrimaryForWorkspaceTraffic(t *testing.T) {
	// Mock web2api: reply grounded in the workspace's knowledge, but
	// ONLY if the request's system prompt actually contains it — a
	// reply without the marker means the prompt was not scoped.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(body, &payload)
		scoped := false
		for _, m := range payload.Messages {
			if strings.Contains(m.Content, "150 taka") {
				scoped = true
			}
		}
		w.WriteHeader(http.StatusOK)
		if scoped {
			w.Write([]byte(`{"choices":[{"message":{"content":"Mock Gemini: delivery is 150 taka nationwide."}}]}`))
		} else {
			w.Write([]byte(`{"choices":[{"message":{"content":"Mock Gemini: I do not know the delivery fee."}}]}`))
		}
	}))
	defer server.Close()

	t.Setenv("GEMINI_WEB2API_PROXY_URL", server.URL)
	t.Setenv("GEMINI_WEB2API_KEY", "dummy-key")

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

	// Workspace traffic must route through web2api and come back
	// grounded in that workspace's own knowledge.
	reply, _, model, _ := engine.GenerateReply(ctx, pctxWorkspace, "delivery charge", nil, "")
	if model != "gemini-web2api:gemini-3.6-flash" {
		t.Fatalf("workspace traffic must route through web2api (primary), got model: %s reply: %s", model, reply)
	}
	if !strings.Contains(reply, "150") {
		t.Fatalf("expected workspace reply grounded in knowledge (150), got: %s (model: %s)", reply, model)
	}
}

// TestTier3_Web2APIReceivesHistory verifies the web2api request carries
// the conversation history (2026-11-16 fix). Before this, GenerateReply
// built the history into fullPrompt but tryDirectAPIs only received the
// system prompt + current message, so Gemini forgot every earlier turn
// (the name given one message earlier was already gone). The mock answers
// with the name ONLY when an earlier turn carried it — a reply with the
// name proves the history reached the backend.
func TestTier3_Web2APIReceivesHistory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(body, &payload)
		// The name lives ONLY in an earlier turn, never in the current
		// message — if it is in the request, history was sent.
		sawName := false
		for _, m := range payload.Messages {
			if m.Role != "system" && strings.Contains(m.Content, "Rahima Khatun") {
				sawName = true
			}
		}
		w.WriteHeader(http.StatusOK)
		if sawName {
			w.Write([]byte(`{"choices":[{"message":{"content":"Mock Gemini: your name is Rahima Khatun."}}]}`))
		} else {
			w.Write([]byte(`{"choices":[{"message":{"content":"Mock Gemini: I do not know your name."}}]}`))
		}
	}))
	defer server.Close()

	t.Setenv("GEMINI_WEB2API_PROXY_URL", server.URL)
	t.Setenv("GEMINI_WEB2API_KEY", "dummy-key")

	engine := NewEngine()
	ctx := context.Background()

	pctx := PromptContext{
		ClientID:   "workspace-tenant-99",
		ClientName: "Shop 99",
		Knowledge: []KnowledgeItem{
			{Title: "Delivery Policy", Content: "Delivery fee is 150 taka nationwide."},
		},
	}
	history := []ChatMessage{
		{Role: "user", Content: "My name is Rahima Khatun."},
		{Role: "assistant", Content: "Thanks Rahima! How can I help you today?"},
	}

	reply, _, model, _ := engine.GenerateReply(ctx, pctx, "What is my name?", history, "")
	if model != "gemini-web2api:gemini-3.6-flash" {
		t.Fatalf("expected web2api model, got model: %s reply: %s", model, reply)
	}
	if !strings.Contains(reply, "Rahima Khatun") {
		t.Fatalf("expected the reply to use the name from history, got: %s (model: %s)", reply, model)
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
		ClientID: "", // Tier 3 web2api runs for all traffic, including workspaces (primary since 2026-11-15); empty here keeps the test minimal.
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

// 2026-11-16 order/payment audit fixes (Go responder mirror): the same
// flows the TS tests cover — a Bengali-script brand name, "নাম করিম"
// + keyword-less address, and honest payment replies.
func TestAuditFixes_SkeletonMatchesBengaliBrandName(t *testing.T) {
	kitkat := []ProductItem{{Name: "Kitkat", PriceBDT: 900, Stock: 75}}
	// No alias: the consonant skeleton alone must match.
	reply := DemoResponder("bn", "কিটক্যাটের দাম কত?", kitkat, nil, nil, PaymentConfig{})
	if !strings.Contains(reply, "Kitkat") || !strings.Contains(reply, "900") {
		t.Fatalf("expected Kitkat price reply, got: %s", reply)
	}
	// With the owner alias it matches the plain form too.
	kitkatAliased := []ProductItem{{Name: "Kitkat", PriceBDT: 900, Stock: 75, Aliases: []string{"কিটক্যাট"}}}
	reply = DemoResponder("bn", "কিটক্যাট কিনতে চাই", kitkatAliased, nil, nil, PaymentConfig{})
	if !strings.Contains(reply, "Kitkat") {
		t.Fatalf("expected Kitkat reply via alias, got: %s", reply)
	}
	// The skeleton must not over-match an unrelated product.
	saree := []ProductItem{{Name: "লাল জামদানি শাড়ি", PriceBDT: 8000, Stock: 10}}
	reply = DemoResponder("bn", "কিটক্যাট কিনতে চাই", saree, nil, nil, PaymentConfig{})
	if strings.Contains(reply, "8000") {
		t.Fatalf("skeleton over-matched the saree, got: %s", reply)
	}
}

func TestAuditFixes_ExtractCustomerDetails(t *testing.T) {
	d := ExtractCustomerDetails("নাম করিম, ০১৬৪২৭৭৫২৭২, ঊলিয়াপুর, চট্টগ্রাম")
	if d.Name != "করিম" {
		t.Fatalf("expected name করিম, got %q", d.Name)
	}
	if d.Phone != "01642775272" {
		t.Fatalf("expected phone 01642775272, got %q", d.Phone)
	}
	if d.Address != "ঊলিয়াপুর, চট্টগ্রাম" {
		t.Fatalf("expected address ঊলিয়াপুর, চট্টগ্রাম, got %q", d.Address)
	}
	// "আমার নাম কি?" captures no name.
	if d := ExtractCustomerDetails("আমার নাম কি?"); d.Name != "" {
		t.Fatalf("expected no name for 'আমার নাম কি?', got %q", d.Name)
	}
	// A bare quantity after the phone is not an address.
	if d := ExtractCustomerDetails("আমার নাম করিম, ফোন ০১৬৪২৭৭৫২৭২, ২টি"); d.Address != "" {
		t.Fatalf("expected no address for a bare quantity, got %q", d.Address)
	}
}

func TestAuditFixes_PaymentRepliesUseConfig(t *testing.T) {
	// No config: honest, never an invented method list.
	reply := DemoResponder("bn", "পেমেন্ট কিভাবে করব?", nil, nil, nil, PaymentConfig{})
	if strings.Contains(reply, "bKash") || strings.Contains(reply, "Nagad") {
		t.Fatalf("unconfigured shop must not claim a method, got: %s", reply)
	}
	if !strings.Contains(reply, "ঠিক করা হয়নি") {
		t.Fatalf("expected the honest not-configured line, got: %s", reply)
	}
	// Configured: the real number + advance.
	cfg := PaymentConfig{Modes: "both", AdvanceBDT: 100, Bkash: "01700000000"}
	reply = DemoResponder("bn", "পেমেন্ট কিভাবে করব?", nil, nil, nil, cfg)
	if !strings.Contains(reply, "01700000000") || !strings.Contains(reply, "১০০") {
		t.Fatalf("expected real number + advance, got: %s", reply)
	}
	reply = DemoResponder("bn", "অগ্রিম কত দিতে হবে?", nil, nil, nil, cfg)
	if !strings.Contains(reply, "১০০") || !strings.Contains(reply, "01700000000") {
		t.Fatalf("expected advance + number, got: %s", reply)
	}
	// "হে" reaches the order branch, not a greeting.
	kitkat := []ProductItem{{Name: "Kitkat", PriceBDT: 900, Stock: 75}}
	reply = DemoResponder("bn", "হে", kitkat, nil, nil, PaymentConfig{})
	if strings.Contains(reply, "নমস্কার") || strings.Contains(reply, "আসসালামু") {
		t.Fatalf("expected the order branch for 'হে', got: %s", reply)
	}
	if !strings.Contains(reply, "নাম") && !strings.Contains(reply, "Kitkat") {
		t.Fatalf("expected the order branch to ask for details, got: %s", reply)
	}
}

// 2026-11-16 probe: with advance=100 configured, the LLM twice told the
// customer "no advance needed". Pure payment questions are now answered
// deterministically before any LLM tier, so the model can never invent
// or deny an advance.
func TestAuditFixes_PaymentQuestionsAnsweredDeterministically(t *testing.T) {
	engine := NewEngine()
	ctx := context.Background()
	pctx := PromptContext{
		ClientID:   "69",
		ClientName: "Xyz",
		Payment:    PaymentConfig{Modes: "both", AdvanceBDT: 100, Bkash: "01700000000"},
	}

	// The exact yes/no phrasing that failed live, twice.
	reply, _, model, _ := engine.GenerateReply(ctx, pctx, "অগ্রিম দিতে হবে কি? কত টাকা?", nil, "")
	if model != "deterministic-payment" {
		t.Fatalf("expected deterministic-payment, got model: %s reply: %s", model, reply)
	}
	if !strings.Contains(reply, "১০০") || !strings.Contains(reply, "01700000000") {
		t.Fatalf("expected advance 100 + number, got: %s", reply)
	}

	// Unconfigured shop: the honest line, still deterministic.
	pctxNoCfg := PromptContext{ClientID: "69", ClientName: "Xyz"}
	reply, _, model, _ = engine.GenerateReply(ctx, pctxNoCfg, "পেমেন্ট কিভাবে করব?", nil, "")
	if model != "deterministic-payment" {
		t.Fatalf("expected deterministic-payment, got model: %s reply: %s", model, reply)
	}
	if strings.Contains(reply, "bKash") || strings.Contains(reply, "Nagad") {
		t.Fatalf("unconfigured shop must not claim a method, got: %s", reply)
	}

	// An order intent that mentions payment stays with the normal flow
	// (in this no-LLM test env that is the Tier-4 catalog responder).
	reply, _, model, _ = engine.GenerateReply(ctx, pctx, "Kitkat কিনতে চাই, বিকাশে পাঠাবো", nil, "")
	if model != "deterministic-catalog" {
		t.Fatalf("order intent must not take the payment shortcut, got model: %s reply: %s", model, reply)
	}
}
