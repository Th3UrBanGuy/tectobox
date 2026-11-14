package gemini

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Response parsing — split from client.go in Phase 4 of the modular
// restructure. The buffered path (extractResponseText) and the streaming
// path (StreamGenerateChunks) used to unwrap the same `wrb.fr` lines
// twice; the per-line unwrapping is now one function, extractLineTexts,
// used by both. Only the aggregation differs: buffered picks the longest
// candidate, streaming emits prefix-diffs as deltas.

// extractLineTexts unwraps one raw response line: it must be a `wrb.fr`
// JSON envelope whose [0][2] is a JSON string whose [4] holds the text
// parts. It returns the candidate texts on the line (usually one), or
// nil when the line carries no text. The length guards (150 / 40) are
// the same ones both old parsers applied.
func extractLineTexts(line string) []string {
	if !strings.Contains(line, `"wrb.fr"`) || len(line) < 150 {
		return nil
	}

	var envelope [][]interface{}
	if err := json.Unmarshal([]byte(line), &envelope); err != nil {
		return nil
	}
	if len(envelope) == 0 || len(envelope[0]) < 3 {
		return nil
	}

	innerStr, ok := envelope[0][2].(string)
	if !ok || len(innerStr) < 40 {
		return nil
	}

	var innerData []interface{}
	if err := json.Unmarshal([]byte(innerStr), &innerData); err != nil {
		return nil
	}

	if len(innerData) <= 4 || innerData[4] == nil {
		return nil
	}
	parts, ok := innerData[4].([]interface{})
	if !ok {
		return nil
	}

	var texts []string
	for _, p := range parts {
		partArr, ok := p.([]interface{})
		if !ok || len(partArr) <= 1 || partArr[1] == nil {
			continue
		}
		partTexts, ok := partArr[1].([]interface{})
		if !ok {
			continue
		}
		for _, t := range partTexts {
			if textStr, ok := t.(string); ok && len(textStr) > 0 {
				texts = append(texts, textStr)
			}
		}
	}
	return texts
}

func extractResponseText(raw string) (string, error) {
	if strings.Contains(raw, "BardErrorInfo") {
		return "", fmt.Errorf("gemini rejected request with BardErrorInfo")
	}

	var candidates []string
	lines := strings.Split(raw, "\n")
	for _, line := range lines {
		candidates = append(candidates, extractLineTexts(line)...)
	}

	if len(candidates) == 0 {
		return "", fmt.Errorf("no candidate text found in Gemini response")
	}

	// Pick the longest/most complete candidate
	best := candidates[len(candidates)-1]
	for _, c := range candidates {
		if len(c) > len(best) {
			best = c
		}
	}

	clean := cleanGeminiText(best)
	return clean, nil
}

func cleanGeminiText(text string) string {
	// Strip internal code execution artifacts
	reCode := regexp.MustCompile("(?s)```(?:python|javascript|text)\\?code_(?:reference|stdout)&code_event_index=\\d+\\n.*?```\\n?")
	cleaned := reCode.ReplaceAllString(text, "")
	return strings.TrimSpace(cleaned)
}
