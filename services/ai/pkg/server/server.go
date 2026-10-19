package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/gemini"
	"github.com/tect0nicofficial/tectobox/services/ai/pkg/router"
)

type Server struct {
	engine    *router.Engine
	startTime time.Time
}

func NewServer() *Server {
	return &Server{
		engine:    router.NewEngine(),
		startTime: time.Now(),
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/v1/chat/completions", s.handleChatCompletions)
	mux.HandleFunc("/api/ai/chat", s.handleInternalAIChat)

	// High-throughput middleware: CORS, Token Bucket Rate Limiting, and Brute-force protection
	limiter := router.GetRateLimiterManager()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Workspace-ID")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		// Brute force & IP rate limiting check (exempting local health check)
		if r.URL.Path != "/health" {
			clientIP := r.Header.Get("X-Forwarded-For")
			if clientIP == "" {
				clientIP = r.RemoteAddr
			}
			if !limiter.AllowIP(clientIP) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"error":       "Too Many Requests - Rate limit exceeded or temporary abuse block",
					"status_code": 429,
				})
				return
			}
		}

		mux.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "healthy",
		"service":    "tectobox-ai-go",
		"uptime_sec": int(time.Since(s.startTime).Seconds()),
		"goroutines": runtime.NumGoroutine(),
		"alloc_mb":   float64(mem.Alloc) / 1024 / 1024,
	})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var data []map[string]interface{}
	for id, m := range gemini.AvailableModels {
		data = append(data, map[string]interface{}{
			"id":          id,
			"object":      "model",
			"created":     time.Now().Unix(),
			"owned_by":    "google",
			"description": m.Description,
		})
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"object": "list",
		"data":   data,
	})
}

type OpenAIChatRequest struct {
	Model    string               `json:"model"`
	Messages []router.ChatMessage `json:"messages"`
	Stream   bool                 `json:"stream"`
}

func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	var req OpenAIChatRequest
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	var userMsg, sysPrompt string
	var history []router.ChatMessage
	for i, m := range req.Messages {
		if m.Role == "system" {
			sysPrompt = m.Content
		} else if i == len(req.Messages)-1 && m.Role == "user" {
			userMsg = m.Content
		} else {
			history = append(history, m)
		}
	}

	if userMsg == "" && len(req.Messages) > 0 {
		userMsg = req.Messages[len(req.Messages)-1].Content
	}

	pctx := router.PromptContext{}
	if sysPrompt != "" {
		pctx.ClientName = "Store Assistant"
	}

	start := time.Now()
	reply, detectedLang, modelUsed, _ := s.engine.GenerateReply(r.Context(), pctx, userMsg, history, req.Model)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   modelUsed,
		"choices": []map[string]interface{}{
			{
				"index": 0,
				"message": map[string]interface{}{
					"role":    "assistant",
					"content": reply,
				},
				"finish_reason": "stop",
			},
		},
		"metadata": map[string]interface{}{
			"detected_language": detectedLang,
			"latency_ms":        time.Since(start).Milliseconds(),
		},
	})
}

type InternalChatRequest struct {
	ClientID     interface{}            `json:"client_id"`
	ClientName   string                 `json:"client_name"`
	BusinessType string                 `json:"business_type"`
	Text         string                 `json:"text"`
	History      []router.ChatMessage   `json:"history"`
	Products     []router.ProductItem   `json:"products"`
	Knowledge    []router.KnowledgeItem `json:"knowledge"`
	Model        string                 `json:"model"`
}

func (s *Server) handleInternalAIChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	var req InternalChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	start := time.Now()
	workspaceID := fmt.Sprintf("%v", req.ClientID)
	if !router.GetRateLimiterManager().AllowWorkspace(workspaceID) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":       "Workspace AI token bucket depleted. Capacity refilling continuously.",
			"status_code": 429,
		})
		return
	}

	pctx := router.PromptContext{
		ClientID:     workspaceID,
		ClientName:   req.ClientName,
		BusinessType: req.BusinessType,
		Products:     req.Products,
		Knowledge:    req.Knowledge,
	}

	reply, lang, modelUsed, cached := s.engine.GenerateReply(r.Context(), pctx, req.Text, req.History, req.Model)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"reply":      reply,
		"language":   lang,
		"model":      modelUsed,
		"cached":     cached,
		"latency_ms": time.Since(start).Milliseconds(),
	})
}
