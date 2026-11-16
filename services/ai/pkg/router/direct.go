package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Tier 3 timeouts and the detached web2api timeout. These were magic
// literals inside GenerateReply / tryDirectAPIs; they are named here so a
// latency change does not require reading the orchestrator.
const (
	// web2apiDetachedTimeout is the context given to the gemini-web2api
	// proxy call. It is detached from the Tier-3 context on purpose:
	// web2api drives the Gemini web UI, so first replies take ~5s and
	// the 2s Tier-3 context would always time out. 10s (was 20s): a
	// healthy first reply fits, and a saturated session's tail is
	// halved — the breaker below takes over from there.
	web2apiDetachedTimeout = 10 * time.Second

	// web2apiBreakerThreshold / web2apiBreakerCooldown: under load the
	// single shared web2api session serializes requests and the tail
	// burns the full detached timeout (2026-11-16 scenario audit S7:
	// p95 15.72s, max 23.21s, 429s in the ai log). After this many
	// consecutive failures the leg is skipped for the cooldown, so
	// traffic falls through to the deterministic Tier 4 reply in
	// milliseconds instead of queueing behind a saturated session. A
	// success resets the failure count.
	web2apiBreakerThreshold = 3
	web2apiBreakerCooldown  = 60 * time.Second
)

// web2apiBreakerOpen reports whether the web2api leg is currently
// skipped because of consecutive failures.
func (e *Engine) web2apiBreakerOpen() bool {
	e.web2apiMu.Lock()
	defer e.web2apiMu.Unlock()
	return time.Now().Before(e.web2apiOpenUntil)
}

// web2apiNoteResult records one web2api leg outcome: a success resets
// the failure count; a failure increments it and opens the breaker for
// the cooldown once the threshold is reached.
func (e *Engine) web2apiNoteResult(err error) {
	e.web2apiMu.Lock()
	defer e.web2apiMu.Unlock()
	if err == nil {
		e.web2apiFailures = 0
		return
	}
	e.web2apiFailures++
	if e.web2apiFailures >= web2apiBreakerThreshold {
		e.web2apiOpenUntil = time.Now().Add(web2apiBreakerCooldown)
		log.Printf("[ai] web2api breaker OPEN for %s after %d consecutive failures", web2apiBreakerCooldown, e.web2apiFailures)
		e.web2apiFailures = 0
	}
}

// web2APIAllowed — web2api is the PRIMARY backend for ALL traffic,
// including workspace/widget traffic (user order 2026-11-15).
//
// The old F1 guard skipped web2api for workspaces on the belief that the
// gemini-web2api proxy's single shared browser session would leak one
// workspace's prompts/knowledge into another's. Live probe 2026-11-15
// (marker test on the production :8083: REQ1 planted "ZEBRA-9911", a
// fresh REQ2 with no history answered "I DON'T KNOW") proved the
// endpoint is STATELESS per request — the server keeps no memory between
// calls, so nothing can leak across requests. Isolation rests on the
// caller, and the caller already scopes everything per workspace: the
// system prompt is built only from this workspace's products +
// knowledge (prompt.go), the reply cache key includes ClientID
// (cache.go), and intake caps each workspace at 200 AI replies/day.
//
// Residual shared-account risks (NOT leaks): one Google account's quota
// is shared by all workspaces, and the single cookie is a single point
// of failure. A direct per-workspace Gemini API key remains the more
// robust isolation; web2api stays primary until that is wired.
//
// NOTE — env-var name (renamed in Phase 6): this container reads the
// *external web2api proxy URL* from GEMINI_WEB2API_PROXY_URL. The old
// name GEMINI_WEB2API_URL is kept by the api/workers containers, where
// it means *this service's /v1 base URL* (http://ai:8081/v1). The two
// names must not be confused — setting the proxy URL under the old name
// in this container silently re-routes a tier.
func (e *Engine) web2APIAllowed(_ PromptContext) bool {
	return true
}

func (e *Engine) tryDirectAPIs(ctx context.Context, pctx PromptContext, sysPrompt, userMsg string, history []ChatMessage) (string, string, error) {
	// 0. Gemini via local gemini-web2api-go (OpenAI-compatible endpoint).
	// Runs first: it is the configured backend. web2api drives the Gemini
	// web UI, so first replies take ~5s — the 2s Tier-3 context would
	// always time out, hence a detached 25s context here.
	if e.web2APIAllowed(pctx) {
		if url := os.Getenv("GEMINI_WEB2API_PROXY_URL"); url != "" {
			if key := os.Getenv("GEMINI_WEB2API_KEY"); key != "" {
				model := os.Getenv("GEMINI_WEB2API_MODEL")
				if model == "" {
					model = "gemini-3.6-flash"
				}
				t3Timeout := web2apiDetachedTimeout
				if envMs := os.Getenv("GEMINI_WEB2API_TIMEOUT_MS"); envMs != "" {
					if d, err := strconv.Atoi(envMs); err == nil && d > 0 {
						t3Timeout = time.Duration(d) * time.Millisecond
					}
				} else if envSec := os.Getenv("GEMINI_WEB2API_TIMEOUT_SEC"); envSec != "" {
					if d, err := strconv.Atoi(envSec); err == nil && d > 0 {
						t3Timeout = time.Duration(d) * time.Second
					}
				}
				wCtx, wCancel := context.WithTimeout(context.WithoutCancel(ctx), t3Timeout)
				defer wCancel()
				// Seg-D instrumentation: this leg has a detached 10s timeout
				// (web2api drives the Gemini web UI), so log its elapsed time
				// whenever it is actually attempted.
				t3Start := time.Now()
				var reply string
				var err error
				if e.web2apiBreakerOpen() {
					// Saturated session: skip the leg outright so the
					// request falls through to the next tier / Tier 4
					// instead of queueing behind it. The skip itself is
					// NOT fed back into the breaker — counting it would
					// re-open the breaker on every request and the
					// cooldown would never lapse under sustained load.
					err = fmt.Errorf("web2api breaker open")
					log.Printf("[ai] tier3 web2api skipped (breaker open)")
				} else {
					reply, err = e.callOpenAICompatible(wCtx, url, key, model, sysPrompt, userMsg, history)
					e.web2apiNoteResult(err)
				}
				log.Printf("[ai] tier3 web2api elapsed_ms=%d err=%v", time.Since(t3Start).Milliseconds(), err)
				if err == nil && reply != "" {
					return reply, "gemini-web2api:" + model, nil
				}
			}
		}
	}

	// 1. OpenRouter
	if key := os.Getenv("OPENROUTER_API_KEY"); key != "" {
		reply, err := e.callOpenAICompatible(ctx, "https://openrouter.ai/api/v1/chat/completions", key, "google/gemini-2.5-flash", sysPrompt, userMsg, history)
		if err == nil && reply != "" {
			return reply, "openrouter:gemini-2.5-flash", nil
		}
	}

	// 2. Direct Gemini API — one text prompt, so the history goes in as a
	// transcript (same turns the OpenAI-compatible legs carry as messages).
	if key := os.Getenv("GEMINI_API_KEY"); key != "" {
		url := "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
		payload := map[string]interface{}{
			"contents": []map[string]interface{}{
				{"role": "user", "parts": []map[string]string{{"text": sysPrompt + historyTranscript(history) + "\n\nUser: " + userMsg}}},
			},
		}
		data, _ := json.Marshal(payload)
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(data))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("x-goog-api-key", key)
			resp, err := e.httpClient.Do(req)
			if err == nil {
				defer resp.Body.Close()
				body, _ := io.ReadAll(resp.Body)
				var gRes struct {
					Candidates []struct {
						Content struct {
							Parts []struct {
								Text string `json:"text"`
							} `json:"parts"`
						} `json:"content"`
					} `json:"candidates"`
				}
				if json.Unmarshal(body, &gRes) == nil && len(gRes.Candidates) > 0 && len(gRes.Candidates[0].Content.Parts) > 0 {
					return strings.TrimSpace(gRes.Candidates[0].Content.Parts[0].Text), "direct-gemini-api", nil
				}
			}
		}
	}

	// 3. OpenAI
	if key := os.Getenv("OPENAI_API_KEY"); key != "" {
		reply, err := e.callOpenAICompatible(ctx, "https://api.openai.com/v1/chat/completions", key, "gpt-4o-mini", sysPrompt, userMsg, history)
		if err == nil && reply != "" {
			return reply, "openai:gpt-4o-mini", nil
		}
	}

	return "", "", fmt.Errorf("no direct APIs available or succeeded")
}

func (e *Engine) callOpenAICompatible(ctx context.Context, endpoint, token, model, sysPrompt, userMsg string, history []ChatMessage) (string, error) {
	// History goes between the system prompt and the current message, as
	// proper turns — this is what gives the reply conversational memory.
	// (2026-11-16: before this, only system + current message were sent,
	// so the live web2api path forgot every earlier turn.)
	messages := make([]map[string]string, 0, len(history)+2)
	messages = append(messages, map[string]string{"role": "system", "content": sysPrompt})
	messages = append(messages, historyMessages(history)...)
	messages = append(messages, map[string]string{"role": "user", "content": userMsg})
	payload := map[string]interface{}{
		"model":    model,
		"messages": messages,
		"temperature": 0.4,
		"max_tokens":  600,
	}
	data, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != 200 {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}

	var res struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &res); err == nil && len(res.Choices) > 0 {
		return strings.TrimSpace(res.Choices[0].Message.Content), nil
	}

	return "", fmt.Errorf("empty choice from OpenAI compatible endpoint")
}

// historyMessages converts stored turns into OpenAI-compatible chat
// messages. System turns are dropped (the system prompt already carries
// the shop context) and empty turns are dropped. The current user message
// is appended by the caller, so history never duplicates it.
func historyMessages(history []ChatMessage) []map[string]string {
	out := make([]map[string]string, 0, len(history))
	for _, h := range history {
		content := strings.TrimSpace(h.Content)
		if content == "" {
			continue
		}
		role := "user"
		if h.Role == "assistant" || h.Role == "model" {
			role = "assistant"
		} else if h.Role == "system" {
			continue
		}
		out = append(out, map[string]string{"role": role, "content": content})
	}
	return out
}

// historyTranscript renders the same turns as plain text for the direct
// Gemini API leg, which takes one text prompt instead of a messages
// array. Empty string when there is no history.
func historyTranscript(history []ChatMessage) string {
	var sb strings.Builder
	wrote := false
	for _, h := range history {
		content := strings.TrimSpace(h.Content)
		if content == "" {
			continue
		}
		role := "Customer"
		if h.Role == "assistant" || h.Role == "model" {
			role = "Assistant"
		} else if h.Role == "system" {
			continue
		}
		if !wrote {
			sb.WriteString("\n\n=== RECENT CONVERSATION HISTORY (PAST TURNS) ===\n")
			wrote = true
		}
		sb.WriteString(role + ": " + content + "\n")
	}
	return sb.String()
}
