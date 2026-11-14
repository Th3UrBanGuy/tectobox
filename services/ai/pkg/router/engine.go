package router

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/cloudflare"
	"github.com/tect0nicofficial/tectobox/services/ai/pkg/detector"
	"github.com/tect0nicofficial/tectobox/services/ai/pkg/gemini"
)

// Tier timeouts and cache TTLs. These were magic literals inside
// GenerateReply; they are named here so a latency change does not require
// reading the orchestrator.
const (
	// tier1Timeout bounds the Gemini web2api session call.
	tier1Timeout = 2500 * time.Millisecond
	// tier2Timeout bounds the Cloudflare Workers AI call.
	tier2Timeout = 2500 * time.Millisecond
	// tier3Timeout bounds the direct-API tier (its web2api leg uses the
	// detached web2apiDetachedTimeout in direct.go instead).
	tier3Timeout = 2000 * time.Millisecond
	// tierCacheTTL is how long an LLM-tier reply is cached.
	tierCacheTTL = 5 * time.Minute
	// demoCacheTTL is how long a deterministic-template reply is cached.
	demoCacheTTL = 10 * time.Minute
	// cacheSweepInterval is how often expired cache entries are dropped.
	cacheSweepInterval = 2 * time.Minute
)

// Engine is the AI router: language detect → reply cache → system prompt →
// Tier 1–4 dispatch → cache-store. The tiers themselves live in direct.go
// (Tier 3) and responder.go (Tier 4); the prompt builder in prompt.go; the
// cache and its tenant-isolation key rule in cache.go.
type Engine struct {
	geminiClient *gemini.Client
	cfClient     *cloudflare.Client
	httpClient   *http.Client
	cache        *Cache
}

func NewEngine() *Engine {
	e := &Engine{
		geminiClient: gemini.NewClient(),
		cfClient:     cloudflare.NewClient(),
		httpClient:   &http.Client{Timeout: 30 * time.Second},
		cache:        NewCache(),
	}

	// Periodic cache cleanup
	e.cache.StartSweeper(cacheSweepInterval)

	return e
}

// GenerateReply is the main high-performance AI entrypoint:
// 1. Detects customer language (Bangla script, Banglish, English)
// 2. Builds contextual system prompt with catalog, policies, and past conversation memory
// 3. Executes multi-tier routing: Gemini Web -> Cloudflare -> Direct APIs -> Demo responder
func (e *Engine) GenerateReply(ctx context.Context, pctx PromptContext, userMessage string, history []ChatMessage, modelPreference string) (string, detector.Language, string, bool) {
	cleanMsg := strings.TrimSpace(userMessage)
	if cleanMsg == "" {
		return "", detector.LangEnglish, "none", false
	}

	lang := detector.DetectLanguage(cleanMsg)
	cKey := cacheKey(pctx.ClientID, lang, cleanMsg, history)

	// Check cache
	if cached, ok := e.cache.Get(cKey); ok {
		return cached, lang, "cache", true
	}

	sysPrompt := BuildSystemPrompt(pctx, lang)

	// Format multi-turn transcript with conversational memory
	var sb strings.Builder
	sb.WriteString(sysPrompt)
	if len(history) > 0 {
		sb.WriteString("\n\n=== RECENT CONVERSATION HISTORY (PAST TURNS) ===\n")
		for _, h := range history {
			role := "Customer"
			if h.Role == "assistant" || h.Role == "model" || h.Role == "system" {
				role = "Assistant"
			}
			sb.WriteString(fmt.Sprintf("%s: %s\n", role, strings.TrimSpace(h.Content)))
		}
	}
	sb.WriteString("\nCustomer (Current Message): " + cleanMsg + "\nAssistant:")
	fullPrompt := sb.String()

	// Tier 1: Gemini Web2API with per-workspace isolated session pool.
	// Skip when the workspace has no configured session (no cookies):
	// the direct gemini.google.com call can never authenticate and
	// would burn the full 2.5s timeout on every request. No code path
	// populates session cookies today, so this is skipped in practice
	// until a session is provisioned.
	model := modelPreference
	if model == "" {
		model = "gemini-3.6-flash"
	}
	if gemini.GetSessionPool().HasSession(pctx.ClientID) {
		t1Ctx, t1Cancel := context.WithTimeout(ctx, tier1Timeout)
		if reply, err := e.geminiClient.GenerateForWorkspace(t1Ctx, pctx.ClientID, fullPrompt, model); err == nil && len(reply) > 0 {
			t1Cancel()
			e.cache.Set(cKey, reply, tierCacheTTL)
			return reply, lang, "gemini-web2api:" + model, false
		}
		t1Cancel()
	}

	// Tier 2: Cloudflare Workers AI Playground models (full multi-turn message history).
	// Skip when Cloudflare credentials are unset: Generate would fail
	// immediately, so skip the call (and the message build) outright
	// instead of entering the tier at all.
	if e.cfClient.Configured() {
		cfMessages := []cloudflare.Message{
			{Role: "system", Content: sysPrompt},
		}
		for _, h := range history {
			r := "user"
			if h.Role == "assistant" || h.Role == "model" {
				r = "assistant"
			}
			cfMessages = append(cfMessages, cloudflare.Message{Role: r, Content: h.Content})
		}
		cfMessages = append(cfMessages, cloudflare.Message{Role: "user", Content: cleanMsg})

		t2Ctx, t2Cancel := context.WithTimeout(ctx, tier2Timeout)
		if reply, err := e.cfClient.Generate(t2Ctx, cfMessages); err == nil && len(reply) > 0 {
			t2Cancel()
			e.cache.Set(cKey, reply, tierCacheTTL)
			return reply, lang, "cloudflare-pool", false
		}
		t2Cancel()
	}

	// Tier 3: Direct APIs (OpenRouter / OpenAI / Gemini API if configured)
	t3Ctx, t3Cancel := context.WithTimeout(ctx, tier3Timeout)
	if reply, modelName, err := e.tryDirectAPIs(t3Ctx, pctx, sysPrompt, cleanMsg); err == nil && len(reply) > 0 {
		t3Cancel()
		e.cache.Set(cKey, reply, tierCacheTTL)
		return reply, lang, modelName, false
	}
	t3Cancel()

	// Tier 4: Catalog-Grounded Deterministic Demo Responder with conversational memory
	demoReply := DemoResponder(lang, cleanMsg, pctx.Products, pctx.Knowledge, history)
	e.cache.Set(cKey, demoReply, demoCacheTTL)
	return demoReply, lang, "deterministic-catalog", false
}
