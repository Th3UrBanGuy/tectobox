package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// POST /api/ai/chat — the client_id contract (the F1 leak, closed at
// the type level). Before this phase the field was interface{}, so a
// camelCase `clientId` decoded to nil and fmt.Sprintf("%v", nil) served
// the request under the shared "<nil>" cache key and rate-limit bucket.
// Now the field is router.ClientID: a missing, empty, zero, or
// wrong-typed client_id is rejected with 400, and only a real tenant
// id is ever served.
func TestHandleInternalAIChat_ClientID(t *testing.T) {
	srv := NewServer()

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/ai/chat", strings.NewReader(body))
		rec := httptest.NewRecorder()
		srv.handleInternalAIChat(rec, req)
		return rec
	}

	cases := []struct {
		name       string
		body       string
		wantStatus int
	}{
		// Rejected: no usable client_id at all.
		{"camelCase clientId only", `{"clientId":69,"text":"hello"}`, http.StatusBadRequest},
		{"missing client_id", `{"text":"hello"}`, http.StatusBadRequest},
		{"null client_id", `{"client_id":null,"text":"hello"}`, http.StatusBadRequest},
		{"zero client_id", `{"client_id":0,"text":"hello"}`, http.StatusBadRequest},
		{"empty string client_id", `{"client_id":"","text":"hello"}`, http.StatusBadRequest},
		{"bool client_id", `{"client_id":true,"text":"hello"}`, http.StatusBadRequest},
		// Accepted: a real tenant id, as a number or a string.
		{"number client_id", `{"client_id":69,"text":"hello"}`, http.StatusOK},
		{"string client_id", `{"client_id":"69","text":"hello"}`, http.StatusOK},
	}
	for _, c := range cases {
		rec := post(c.body)
		if rec.Code != c.wantStatus {
			t.Errorf("%s: got status %d, want %d (body: %s)", c.name, rec.Code, c.wantStatus, rec.Body.String())
		}
	}

	// The rejection names the field, so a caller can see the fix.
	rec := post(`{"clientId":69,"text":"hello"}`)
	if !strings.Contains(rec.Body.String(), "client_id") {
		t.Errorf("camelCase rejection body does not mention client_id: %s", rec.Body.String())
	}

	// A valid request is served (Tier 4 deterministic reply when no
	// LLM tier is configured) and the reply carries the tenant's own
	// cache/rate-limit scope, not "<nil>".
	rec = post(`{"client_id":69,"text":"hello"}`)
	var out struct {
		Reply string `json:"reply"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("valid request: bad JSON response: %v", err)
	}
	if out.Reply == "" {
		t.Errorf("valid request: empty reply")
	}
}
