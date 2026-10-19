package gemini

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type ModelInfo struct {
	ID          string `json:"id"`
	Mode        int    `json:"mode"`
	Think       int    `json:"think"`
	Description string `json:"description"`
}

var AvailableModels = map[string]ModelInfo{
	"gemini-3.7-flash": {
		ID:          "gemini-3.7-flash",
		Mode:        1,
		Think:       4,
		Description: "Latest all-around model (Gemini 3.7 Flash)",
	},
	"gemini-3.6-flash": {
		ID:          "gemini-3.6-flash",
		Mode:        1,
		Think:       4,
		Description: "All-around model (Gemini 3.6 Flash)",
	},
	"gemini-3.5-flash": {
		ID:          "gemini-3.5-flash",
		Mode:        1,
		Think:       4,
		Description: "Alias for gemini-3.6-flash",
	},
	"gemini-3.5-flash-thinking": {
		ID:          "gemini-3.5-flash-thinking",
		Mode:        2,
		Think:       0,
		Description: "Deep thinking mode, longest output",
	},
	"gemini-auto": {
		ID:          "gemini-auto",
		Mode:        4,
		Think:       4,
		Description: "Auto model selection",
	},
	"gemini-flash-lite": {
		ID:          "gemini-flash-lite",
		Mode:        6,
		Think:       4,
		Description: "Lightweight fast model",
	},
}

type Client struct {
	httpClient *http.Client
	blMutex    sync.RWMutex
	geminiBL   string
	userAgent  string
}

func NewClient() *Client {
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: false},
		ForceAttemptHTTP2:   true,
	}

	return &Client{
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   120 * time.Second,
		},
		geminiBL:  "boq_assistant-bard-web-server_20260716.08_p0",
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
	}
}

func (c *Client) getBL() string {
	c.blMutex.RLock()
	defer c.blMutex.RUnlock()
	return c.geminiBL
}

func (c *Client) updateBL(newBL string) {
	c.blMutex.Lock()
	defer c.blMutex.Unlock()
	if newBL != "" {
		c.geminiBL = newBL
	}
}

func (c *Client) FetchLatestBL(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://gemini.google.com/app", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", c.userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return "", err
	}

	re := regexp.MustCompile(`(boq_assistant-bard-web-server_\d+\.\d+_p\d+)`)
	matches := re.FindStringSubmatch(string(body))
	if len(matches) > 1 {
		c.updateBL(matches[1])
		return matches[1], nil
	}
	return "", fmt.Errorf("could not find gemini_bl in HTML")
}

// Generate sends prompt directly to Gemini StreamGenerate endpoint with zero authentication
func (c *Client) Generate(ctx context.Context, prompt string, modelName string) (string, error) {
	model, ok := AvailableModels[modelName]
	if !ok {
		model = AvailableModels["gemini-3.6-flash"]
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		text, err := c.doStreamGenerate(ctx, prompt, model)
		if err == nil && len(strings.TrimSpace(text)) > 0 {
			return strings.TrimSpace(text), nil
		}

		lastErr = err
		// If 405 error, try updating BL
		if err != nil && strings.Contains(err.Error(), "405") {
			_, _ = c.FetchLatestBL(ctx)
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 150 * time.Millisecond):
		}
	}

	return "", fmt.Errorf("gemini generation failed after retries: %w", lastErr)
}

func (c *Client) doStreamGenerate(ctx context.Context, prompt string, model ModelInfo) (string, error) {
	// Build 80-element payload
	inner := make([]interface{}, 80)
	inner[0] = []interface{}{prompt, 0, nil, nil, nil, nil, 0}
	inner[1] = []interface{}{"en"}
	inner[2] = []interface{}{"", "", "", nil, nil, nil, nil, nil, nil, ""}
	inner[6] = []interface{}{0}
	inner[7] = 1
	inner[10] = 1
	inner[11] = 0
	inner[17] = []interface{}{[]interface{}{model.Think}}
	inner[18] = 0
	inner[27] = 1
	inner[30] = []interface{}{4}
	inner[41] = []interface{}{2}
	inner[53] = 0
	inner[59] = fmt.Sprintf("%d-%d", time.Now().UnixNano(), time.Now().Unix())
	inner[61] = []interface{}{}
	inner[68] = 1
	inner[79] = model.Mode

	innerJSON, err := json.Marshal(inner)
	if err != nil {
		return "", err
	}

	outer := []interface{}{nil, string(innerJSON)}
	outerJSON, err := json.Marshal(outer)
	if err != nil {
		return "", err
	}

	formData := url.Values{}
	formData.Set("f.req", string(outerJSON))

	reqID := int(time.Now().Unix()) % 1000000
	bl := c.getBL()
	urlStr := fmt.Sprintf("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=%s&hl=en&_reqid=%d&rt=c", bl, reqID)

	req, err := http.NewRequestWithContext(ctx, "POST", urlStr, strings.NewReader(formData.Encode()))
	if err != nil {
		return "", err
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://gemini.google.com")
	req.Header.Set("Referer", "https://gemini.google.com/app")
	req.Header.Set("X-Same-Domain", "1")
	req.Header.Set("User-Agent", c.userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 405 {
		return "", fmt.Errorf("upstream returned 405 Method Not Allowed")
	}
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	return extractResponseText(string(bodyBytes))
}

func extractResponseText(raw string) (string, error) {
	if strings.Contains(raw, "BardErrorInfo") {
		return "", fmt.Errorf("gemini rejected request with BardErrorInfo")
	}

	var candidates []string
	lines := strings.Split(raw, "\n")
	for _, line := range lines {
		if !strings.Contains(line, `"wrb.fr"`) || len(line) < 150 {
			continue
		}

		var envelope [][]interface{}
		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			continue
		}
		if len(envelope) == 0 || len(envelope[0]) < 3 {
			continue
		}

		innerStr, ok := envelope[0][2].(string)
		if !ok || len(innerStr) < 40 {
			continue
		}

		var innerData []interface{}
		if err := json.Unmarshal([]byte(innerStr), &innerData); err != nil {
			continue
		}

		if len(innerData) > 4 && innerData[4] != nil {
			parts, ok := innerData[4].([]interface{})
			if ok {
				for _, p := range parts {
					partArr, ok := p.([]interface{})
					if ok && len(partArr) > 1 && partArr[1] != nil {
						texts, ok := partArr[1].([]interface{})
						if ok {
							for _, t := range texts {
								if textStr, ok := t.(string); ok && len(textStr) > 0 {
									candidates = append(candidates, textStr)
								}
							}
						}
					}
				}
			}
		}
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

// StreamGenerateChunks sends prompt and streams tokens via channel
func (c *Client) StreamGenerateChunks(ctx context.Context, prompt string, modelName string, outCh chan<- string) error {
	defer close(outCh)

	model, ok := AvailableModels[modelName]
	if !ok {
		model = AvailableModels["gemini-3.6-flash"]
	}

	inner := make([]interface{}, 80)
	inner[0] = []interface{}{prompt, 0, nil, nil, nil, nil, 0}
	inner[1] = []interface{}{"en"}
	inner[2] = []interface{}{"", "", "", nil, nil, nil, nil, nil, nil, ""}
	inner[6] = []interface{}{0}
	inner[7] = 1
	inner[10] = 1
	inner[11] = 0
	inner[17] = []interface{}{[]interface{}{model.Think}}
	inner[18] = 0
	inner[27] = 1
	inner[30] = []interface{}{4}
	inner[41] = []interface{}{2}
	inner[53] = 0
	inner[59] = fmt.Sprintf("%d-%d", time.Now().UnixNano(), time.Now().Unix())
	inner[61] = []interface{}{}
	inner[68] = 1
	inner[79] = model.Mode

	innerJSON, _ := json.Marshal(inner)
	outer := []interface{}{nil, string(innerJSON)}
	outerJSON, _ := json.Marshal(outer)

	formData := url.Values{}
	formData.Set("f.req", string(outerJSON))

	reqID := int(time.Now().Unix()) % 1000000
	bl := c.getBL()
	urlStr := fmt.Sprintf("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=%s&hl=en&_reqid=%d&rt=c", bl, reqID)

	req, err := http.NewRequestWithContext(ctx, "POST", urlStr, strings.NewReader(formData.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://gemini.google.com")
	req.Header.Set("Referer", "https://gemini.google.com/app")
	req.Header.Set("X-Same-Domain", "1")
	req.Header.Set("User-Agent", c.userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}

	buf := make([]byte, 4096)
	var prevText string
	var accumulator bytes.Buffer

	for {
		n, rErr := resp.Body.Read(buf)
		if n > 0 {
			accumulator.Write(buf[:n])
			for {
				line, err := accumulator.ReadString('\n')
				if err != nil {
					accumulator.WriteString(line)
					break
				}
				if strings.Contains(line, `"wrb.fr"`) && len(line) > 150 {
					var envelope [][]interface{}
					if json.Unmarshal([]byte(line), &envelope) == nil && len(envelope) > 0 && len(envelope[0]) >= 3 {
						if innerStr, ok := envelope[0][2].(string); ok && len(innerStr) > 40 {
							var innerData []interface{}
							if json.Unmarshal([]byte(innerStr), &innerData) == nil && len(innerData) > 4 && innerData[4] != nil {
								if parts, ok := innerData[4].([]interface{}); ok {
									for _, p := range parts {
										if partArr, ok := p.([]interface{}); ok && len(partArr) > 1 && partArr[1] != nil {
											if texts, ok := partArr[1].([]interface{}); ok {
												for _, t := range texts {
													if textStr, ok := t.(string); ok && len(textStr) > len(prevText) {
														delta := textStr[len(prevText):]
														outCh <- cleanGeminiText(delta)
														prevText = textStr
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
		if rErr != nil {
			break
		}
	}

	return nil
}
