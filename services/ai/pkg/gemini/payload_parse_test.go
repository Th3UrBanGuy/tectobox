package gemini

import (
	"encoding/json"
	"strings"
	"testing"
)

// The StreamGenerate payload is an 80-slot positional array: a typo in
// a slot index silently changes what Gemini receives. This pins the
// layout the old inline builders produced (same slots, same values).
func TestBuildStreamGeneratePayload(t *testing.T) {
	model := ResolveModel("gemini-3.6-flash")
	payload, err := buildStreamGeneratePayload("hello", model)
	if err != nil {
		t.Fatalf("build payload: %v", err)
	}

	var outer []any
	if err := json.Unmarshal([]byte(payload), &outer); err != nil {
		t.Fatalf("unmarshal outer: %v", err)
	}
	if len(outer) != 2 {
		t.Fatalf("outer: got %d elements, want 2", len(outer))
	}
	innerStr, ok := outer[1].(string)
	if !ok {
		t.Fatalf("outer[1]: got %T, want string", outer[1])
	}
	var inner []any
	if err := json.Unmarshal([]byte(innerStr), &inner); err != nil {
		t.Fatalf("unmarshal inner: %v", err)
	}
	if len(inner) != streamGenerateSlots {
		t.Fatalf("inner: got %d slots, want %d", len(inner), streamGenerateSlots)
	}

	// Slot 0: [prompt, 0, nil, nil, nil, nil, 0]
	prompt, ok := inner[slotPrompt].([]any)
	if !ok || len(prompt) == 0 || prompt[0] != "hello" {
		t.Errorf("slotPrompt: got %v, want [hello ...]", inner[slotPrompt])
	}
	// Slot 1: ["en"]
	if lang, ok := inner[slotLanguage].([]any); !ok || len(lang) == 0 || lang[0] != "en" {
		t.Errorf("slotLanguage: got %v, want [en]", inner[slotLanguage])
	}
	// Slot 17: [[think]]
	think, ok := inner[slotThink].([]any)
	if !ok || len(think) == 0 {
		t.Fatalf("slotThink: got %v", inner[slotThink])
	}
	if lvl, ok := think[0].([]any); !ok || len(lvl) == 0 || lvl[0] != float64(model.Think) {
		t.Errorf("slotThink: got %v, want [[%d]]", inner[slotThink], model.Think)
	}
	// Slot 59: request id, non-empty "nanos-epoch" string
	if id, ok := inner[slotRequestID].(string); !ok || !strings.Contains(id, "-") {
		t.Errorf("slotRequestID: got %v, want a non-empty id", inner[slotRequestID])
	}
	// Slot 79: model mode
	if mode, ok := inner[slotMode].(float64); !ok || int(mode) != model.Mode {
		t.Errorf("slotMode: got %v, want %d", inner[slotMode], model.Mode)
	}
	// Slot 7 / 10 / 27 / 68 are 1; slot 11 / 18 / 53 are 0.
	for _, s := range []int{slotOne7, slotOne10, slotOne27, slotOne68} {
		if v, ok := inner[s].(float64); !ok || v != 1 {
			t.Errorf("slot %d: got %v, want 1", s, inner[s])
		}
	}
	for _, s := range []int{slotZero11, slotZero18, slotZero53} {
		if v, ok := inner[s].(float64); !ok || v != 0 {
			t.Errorf("slot %d: got %v, want 0", s, inner[s])
		}
	}
}

// extractLineTexts unwraps one `wrb.fr` line the same way the buffered
// and streaming parsers both did. Build a minimal envelope and check
// the texts come back in order.
func TestExtractLineTexts(t *testing.T) {
	text := strings.Repeat("hello world. ", 20) // long enough to clear the 150-char line guard
	inner := []any{nil, nil, nil, nil, []any{[]any{nil, []any{text, text + "!"}}}}
	innerJSON, err := json.Marshal(inner)
	if err != nil {
		t.Fatalf("marshal inner: %v", err)
	}
	envelope := []any{[]any{"wrb.fr", nil, string(innerJSON)}}
	line, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if len(line) < 150 {
		t.Fatalf("test line too short (%d chars); the 150-char guard would skip it", len(line))
	}

	texts := extractLineTexts(string(line))
	if len(texts) != 2 || texts[0] != text || texts[1] != text+"!" {
		t.Errorf("extractLineTexts: got %q, want [%q %q]", texts, text, text+"!")
	}

	// Non-wrb.fr lines and short lines carry no text.
	if got := extractLineTexts(`{"foo": 1}`); len(got) != 0 {
		t.Errorf("non-wrb.fr line: got %q, want none", got)
	}
	if got := extractLineTexts("short"); len(got) != 0 {
		t.Errorf("short line: got %q, want none", got)
	}
}
