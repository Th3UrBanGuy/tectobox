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
