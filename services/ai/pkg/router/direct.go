package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	// the 2s Tier-3 context would always time out.
	web2apiDetachedTimeout = 20 * time.Second
)

// web2APIAllowed is the F1 tenant-isolation guard, as a named method.
// The gemini-web2api proxy (GEMINI_WEB2API_URL) uses a single shared
// browser session for all requests without per-workspace session
// isolation. In multi-tenant environments, routing different workspaces
// to the same web2api session causes cross-workspace prompt and
// knowledge leakage (e.g. Shop 45 return policy leaking to other
// workspaces). Because gemini-web2api does not support isolated
// per-workspace sessions, Tier 3 web2api is skipped for workspace/widget
// traffic (pctx.ClientID != ""), safely falling through to the
// knowledge-grounded deterministic responder (Tier 4) or isolated
// direct APIs.
//
// NOTE — env-var name (renamed in Phase 6): this container reads the
// *external web2api proxy URL* from GEMINI_WEB2API_PROXY_URL. The old
// name GEMINI_WEB2API_URL is kept by the api/workers containers, where
// it means *this service's /v1 base URL* (http://ai:8081/v1). The two
// names must not be confused — setting the proxy URL under the old name
// in this container silently re-routes a tier.
func (e *Engine) web2APIAllowed(pctx PromptContext) bool {
	return pctx.ClientID == ""
}

func (e *Engine) tryDirectAPIs(ctx context.Context, pctx PromptContext, sysPrompt, userMsg string) (string, string, error) {
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
				if reply, err := e.callOpenAICompatible(wCtx, url, key, model, sysPrompt, userMsg); err == nil && reply != "" {
					return reply, "gemini-web2api:" + model, nil
				}
			}
		}
	}

	// 1. OpenRouter
	if key := os.Getenv("OPENROUTER_API_KEY"); key != "" {
		reply, err := e.callOpenAICompatible(ctx, "https://openrouter.ai/api/v1/chat/completions", key, "google/gemini-2.5-flash", sysPrompt, userMsg)
		if err == nil && reply != "" {
			return reply, "openrouter:gemini-2.5-flash", nil
		}
	}

	// 2. Direct Gemini API
	if key := os.Getenv("GEMINI_API_KEY"); key != "" {
		url := "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
		payload := map[string]interface{}{
			"contents": []map[string]interface{}{
				{"role": "user", "parts": []map[string]string{{"text": sysPrompt + "\n\nUser: " + userMsg}}},
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
		reply, err := e.callOpenAICompatible(ctx, "https://api.openai.com/v1/chat/completions", key, "gpt-4o-mini", sysPrompt, userMsg)
		if err == nil && reply != "" {
			return reply, "openai:gpt-4o-mini", nil
		}
	}

	return "", "", fmt.Errorf("no direct APIs available or succeeded")
}

func (e *Engine) callOpenAICompatible(ctx context.Context, endpoint, token, model, sysPrompt, userMsg string) (string, error) {
	payload := map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": sysPrompt},
			{"role": "user", "content": userMsg},
		},
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
