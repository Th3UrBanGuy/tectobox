package handler

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// ResolveTenant: static map first (constant-time), then the dynamic
// resolver, 0 when neither knows the key.
func TestResolveTenant(t *testing.T) {
	static := map[string]int{"page_123": 42, "page_zero": 0}
	dynamic := func(key string) int {
		if key == "page_dyn" {
			return 7
		}
		return 0
	}

	if got := ResolveTenant(static, dynamic, "page_123"); got != 42 {
		t.Errorf("static hit: got %d, want 42", got)
	}
	if got := ResolveTenant(static, dynamic, "page_dyn"); got != 7 {
		t.Errorf("dynamic hit: got %d, want 7", got)
	}
	if got := ResolveTenant(static, dynamic, "page_unknown"); got != 0 {
		t.Errorf("unknown key: got %d, want 0", got)
	}
	if got := ResolveTenant(static, nil, "page_dyn"); got != 0 {
		t.Errorf("no dynamic resolver: got %d, want 0", got)
	}
	if got := ResolveTenant(nil, nil, "page_123"); got != 0 {
		t.Errorf("no resolvers at all: got %d, want 0", got)
	}
	// A static entry with a non-positive value does not count as a
	// match and falls through to the dynamic resolver (Meta's old
	// behaviour; see the ResolveTenant doc comment).
	if got := ResolveTenant(static, dynamic, "page_zero"); got != 0 {
		t.Errorf("zero-valued static entry: got %d, want 0", got)
	}
}

// NewInboundEnvelope: camelCase JSON tags, a UUID eventId, an RFC 3339
// timestamp — exactly what the api consumer's InboundWireMessageSchema
// accepts (clientId > 0, platformUserId and text non-empty).
func TestNewInboundEnvelope(t *testing.T) {
	ts := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	env := NewInboundEnvelope(InboundEnvelopeParams{
		ClientID:       69,
		Platform:       "meta",
		PlatformUserID: "user_1",
		CustomerName:   "Test User",
		Text:           "hello",
		ExternalID:     "mid_1",
		Timestamp:      ts,
		RawJSON:        json.RawMessage(`{"object":"page"}`),
	})

	data, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if decoded["eventId"] == nil || len(decoded["eventId"].(string)) != 36 {
		t.Errorf("eventId: got %v, want a UUID", decoded["eventId"])
	}
	if decoded["clientId"] != float64(69) {
		t.Errorf("clientId: got %v, want 69", decoded["clientId"])
	}
	if decoded["platform"] != "meta" {
		t.Errorf("platform: got %v, want meta", decoded["platform"])
	}
	if decoded["platformUserId"] != "user_1" {
		t.Errorf("platformUserId: got %v, want user_1", decoded["platformUserId"])
	}
	if decoded["text"] != "hello" {
		t.Errorf("text: got %v, want hello", decoded["text"])
	}
	if decoded["timestamp"] != "2026-11-14T12:00:00Z" {
		t.Errorf("timestamp: got %v, want 2026-11-14T12:00:00Z", decoded["timestamp"])
	}
	// Optional empty fields are omitted, not sent as "".
	if _, ok := decoded["customerPhone"]; ok {
		t.Errorf("customerPhone: present but empty, want omitted")
	}
	// Two envelopes get different eventIds.
	env2 := NewInboundEnvelope(InboundEnvelopeParams{ClientID: 69, Platform: "meta", PlatformUserID: "u", Text: "hi", Timestamp: ts})
	if env2.EventID == env.EventID {
		t.Errorf("eventId not unique: both %q", env.EventID)
	}
}

// PublishEnvelope marshals and publishes under the given routing key.
// (mockPublisher is defined in meta_test.go, same package.)
func TestPublishEnvelope(t *testing.T) {
	pub := &mockPublisher{}
	env := NewInboundEnvelope(InboundEnvelopeParams{
		ClientID:       42,
		Platform:       "telegram",
		PlatformUserID: "123",
		Text:           "hi",
		Timestamp:      time.Now().UTC(),
	})
	if err := PublishEnvelope(context.Background(), pub, "message.incoming.telegram", env); err != nil {
		t.Fatalf("PublishEnvelope: %v", err)
	}
	if len(pub.published) != 1 {
		t.Fatalf("published: got %d, want 1", len(pub.published))
	}
	if pub.published[0].RoutingKey != "message.incoming.telegram" {
		t.Errorf("routing key: got %q", pub.published[0].RoutingKey)
	}
	if !strings.Contains(string(pub.published[0].Body), `"platform":"telegram"`) {
		t.Errorf("body missing platform: %s", pub.published[0].Body)
	}
}
