package gemini

import (
	"context"
	"crypto/tls"
	"net/http"
	"sync"
	"time"
)

// WorkspaceSession represents an isolated Gemini session context for a specific workspace.
// Each workspace gets its own dedicated HTTP client, cookie container, header state, and conversation lease.
type WorkspaceSession struct {
	WorkspaceID string
	Cookies     string
	HTTPClient  *http.Client
	LastActive  time.Time
	ReqCount    uint64
	Mu          sync.RWMutex
}

// SessionPool manages isolated WorkspaceSessions with concurrent access and TTL eviction.
type SessionPool struct {
	sessions map[string]*WorkspaceSession
	mu       sync.RWMutex
	baseBL   string
}

var globalPool *SessionPool
var poolOnce sync.Once

// GetSessionPool returns the singleton session pool instance.
func GetSessionPool() *SessionPool {
	poolOnce.Do(func() {
		globalPool = &SessionPool{
			sessions: make(map[string]*WorkspaceSession),
			baseBL:   "boq_assistant-bard-web-server_20260716.08_p0",
		}
		// Background cleanup for inactive workspace sessions (30m TTL)
		go globalPool.evictionLoop()
	})
	return globalPool
}

func (p *SessionPool) evictionLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		p.mu.Lock()
		now := time.Now()
		for id, sess := range p.sessions {
			sess.Mu.RLock()
			idle := now.Sub(sess.LastActive)
			sess.Mu.RUnlock()
			if idle > 30*time.Minute {
				delete(p.sessions, id)
			}
		}
		p.mu.Unlock()
	}
}

// GetOrCreateSession retrieves or instantiates an isolated Google/Gemini session for a tenant workspace.
func (p *SessionPool) GetOrCreateSession(workspaceID string) *WorkspaceSession {
	if workspaceID == "" {
		workspaceID = "default"
	}

	p.mu.RLock()
	sess, exists := p.sessions[workspaceID]
	p.mu.RUnlock()
	if exists {
		sess.Mu.Lock()
		sess.LastActive = time.Now()
		sess.ReqCount++
		sess.Mu.Unlock()
		return sess
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Double-check under write lock
	if sess, exists := p.sessions[workspaceID]; exists {
		sess.Mu.Lock()
		sess.LastActive = time.Now()
		sess.ReqCount++
		sess.Mu.Unlock()
		return sess
	}

	// Create new isolated HTTP client with tuned connection pool for this workspace
	transport := &http.Transport{
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     60 * time.Second,
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: false},
		ForceAttemptHTTP2:   true,
	}

	newSess := &WorkspaceSession{
		WorkspaceID: workspaceID,
		HTTPClient: &http.Client{
			Transport: transport,
			Timeout:   60 * time.Second,
		},
		LastActive: time.Now(),
		ReqCount:   1,
	}

	p.sessions[workspaceID] = newSess
	return newSess
}

// GenerateForWorkspace sends the prompt via the tenant's isolated session client
func (c *Client) GenerateForWorkspace(ctx context.Context, workspaceID string, prompt string, modelName string) (string, error) {
	sess := GetSessionPool().GetOrCreateSession(workspaceID)

	model, ok := AvailableModels[modelName]
	if !ok {
		model = AvailableModels["gemini-3.6-flash"]
	}

	// Execute with workspace session client
	return c.doStreamGenerateWithClient(ctx, sess.HTTPClient, prompt, model)
}
