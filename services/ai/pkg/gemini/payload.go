package gemini

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// StreamGenerate payload — split from client.go in Phase 4 of the modular
// restructure. Generate and StreamGenerateChunks used to build the same
// 80-slot positional JSON array twice (same URL, same headers); there is
// now one builder. A single Gemini-side field move used to break both
// paths silently — the slot indices are named constants here so the
// layout is visible in one place.
//
// Slot layout (inner array, 80 slots):
//
//	0  prompt (+ flags)      17 think level       59 request id
//	1  language ("en")       18 (0)               61 (empty list)
//	2  (empty strings)       27 (1)               68 (1)
//	6  (0)                   30 ([4])             79 model mode
//	7  (1)                   41 ([2])
//	10 (1)                   53 (0)
//	11 (0)
const (
	slotPrompt    = 0
	slotLanguage  = 1
	slotEmptyStrs = 2
	slotZero6     = 6
	slotOne7      = 7
	slotOne10     = 10
	slotZero11    = 11
	slotThink     = 17
	slotZero18    = 18
	slotOne27     = 27
	slotFour30    = 30
	slotTwo41     = 41
	slotZero53    = 53
	slotRequestID = 59
	slotEmptyList = 61
	slotOne68     = 68
	slotMode      = 79

	streamGenerateSlots = 80
)

// buildStreamGeneratePayload builds the 80-slot inner array for one
// prompt + model, marshalled as the `f.req` outer JSON. It is the single
// payload builder for both the buffered (Generate) and streaming
// (StreamGenerateChunks) paths.
func buildStreamGeneratePayload(prompt string, model ModelInfo) (string, error) {
	inner := make([]interface{}, streamGenerateSlots)
	inner[slotPrompt] = []interface{}{prompt, 0, nil, nil, nil, nil, 0}
	inner[slotLanguage] = []interface{}{"en"}
	inner[slotEmptyStrs] = []interface{}{"", "", "", nil, nil, nil, nil, nil, nil, ""}
	inner[slotZero6] = []interface{}{0}
	inner[slotOne7] = 1
	inner[slotOne10] = 1
	inner[slotZero11] = 0
	inner[slotThink] = []interface{}{[]interface{}{model.Think}}
	inner[slotZero18] = 0
	inner[slotOne27] = 1
	inner[slotFour30] = []interface{}{4}
	inner[slotTwo41] = []interface{}{2}
	inner[slotZero53] = 0
	inner[slotRequestID] = fmt.Sprintf("%d-%d", time.Now().UnixNano(), time.Now().Unix())
	inner[slotEmptyList] = []interface{}{}
	inner[slotOne68] = 1
	inner[slotMode] = model.Mode

	innerJSON, err := json.Marshal(inner)
	if err != nil {
		return "", err
	}

	outer := []interface{}{nil, string(innerJSON)}
	outerJSON, err := json.Marshal(outer)
	if err != nil {
		return "", err
	}
	return string(outerJSON), nil
}

// buildStreamGenerateRequest builds the POST request for the undocumented
// StreamGenerate endpoint (form-encoded f.req + browser headers). Shared
// by the buffered and streaming paths so the URL, headers, and form
// encoding cannot drift apart.
func buildStreamGenerateRequest(ctx context.Context, bl, userAgent, payloadJSON string) (*http.Request, error) {
	formData := url.Values{}
	formData.Set("f.req", payloadJSON)

	reqID := int(time.Now().Unix()) % 1000000
	urlStr := fmt.Sprintf("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=%s&hl=en&_reqid=%d&rt=c", bl, reqID)

	req, err := http.NewRequestWithContext(ctx, "POST", urlStr, strings.NewReader(formData.Encode()))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://gemini.google.com")
	req.Header.Set("Referer", "https://gemini.google.com/app")
	req.Header.Set("X-Same-Domain", "1")
	req.Header.Set("User-Agent", userAgent)

	return req, nil
}
