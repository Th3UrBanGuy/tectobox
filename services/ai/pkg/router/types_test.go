package router

import (
	"encoding/json"
	"testing"
)

// ClientID is the type-level close of the F1 leak: a camelCase
// `clientId` used to decode to nil and fall back to the "<nil>" shared
// cache key. These cases pin the coercion (same as the Phase 1 wire
// schema AiRequestWireMessageSchema: Number() then non-zero).
func TestClientIDUnmarshal(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		want    ClientID
		wantErr bool
	}{
		{"string id", `"69"`, "69", false},
		{"number id", `69`, "69", false},
		{"empty string", `""`, "", true},
		{"zero number", `0`, "", true},
		{"null", `null`, "", true},
		{"bool", `true`, "", true},
		{"object", `{"id":69}`, "", true},
		{"array", `[69]`, "", true},
	}
	for _, c := range cases {
		var got ClientID
		err := json.Unmarshal([]byte(c.json), &got)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: got %q, want an error", c.name, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: unexpected error: %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}

	// A missing client_id never calls UnmarshalJSON: it stays "".
	// The handler rejects "" with 400 (see pkg/server/server_test.go).
	var req struct {
		ClientID ClientID `json:"client_id"`
	}
	if err := json.Unmarshal([]byte(`{}`), &req); err != nil {
		t.Fatalf("missing client_id: unexpected error: %v", err)
	}
	if req.ClientID != "" {
		t.Errorf("missing client_id: got %q, want empty", req.ClientID)
	}
}

// ConversationID is the OPTIONAL cache-scope half of the same wire
// contract — and the 2026-11-17 live catch: the Node callers send the
// Postgres integer conversation id as a JSON NUMBER, and a plain
// `string` field rejected every /api/ai/chat request with 400 (the
// TS breaker then opened after 3 and the widget fell back to
// templates). Unlike ClientID, empty/zero/null must NOT error —
// the field only narrows the cache key, it never gates the request.
func TestConversationIDUnmarshal(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		want    ConversationID
		wantErr bool
	}{
		{"string id", `"7755"`, "7755", false},
		{"number id", `7755`, "7755", false},
		{"empty string", `""`, "", false},
		{"zero number", `0`, "0", false},
		{"null", `null`, "", false},
		{"bool", `true`, "", true},
		{"object", `{"id":7755}`, "", true},
		{"array", `[7755]`, "", true},
	}
	for _, c := range cases {
		var got ConversationID
		err := json.Unmarshal([]byte(c.json), &got)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: got %q, want an error", c.name, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: unexpected error: %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}

	// A missing conversation_id never calls UnmarshalJSON: it stays "".
	var req struct {
		ConversationID ConversationID `json:"conversation_id"`
	}
	if err := json.Unmarshal([]byte(`{}`), &req); err != nil {
		t.Fatalf("missing conversation_id: unexpected error: %v", err)
	}
	if req.ConversationID != "" {
		t.Errorf("missing conversation_id: got %q, want empty", req.ConversationID)
	}
}
