package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

var PlaygroundModels = []string{
	"@cf/meta/llama-3.1-8b-instruct",
	"@cf/meta/llama-3-8b-instruct",
	"@cf/mistral/mistral-7b-instruct-v0.2",
	"@cf/qwen/qwen1.5-7b-chat",
}

type Client struct {
	httpClient *http.Client
	accountID  string
	apiToken   string
}

func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		accountID:  os.Getenv("CLOUDFLARE_ACCOUNT_ID"),
		apiToken:   os.Getenv("CLOUDFLARE_API_TOKEN"),
	}
}

// Configured reports whether Cloudflare credentials are set. When false,
// Generate fails immediately; callers use this to skip Tier 2 outright.
func (c *Client) Configured() bool {
	return c.accountID != "" && c.apiToken != ""
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Generate calls Cloudflare Workers AI models with automatic model fallback
func (c *Client) Generate(ctx context.Context, messages []Message) (string, error) {
	if c.accountID == "" || c.apiToken == "" {
		return "", fmt.Errorf("cloudflare credentials not configured")
	}

	for _, model := range PlaygroundModels {
		url := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/ai/run/%s", c.accountID, model)
		payload := map[string]interface{}{
			"messages": messages,
		}
		jsonBytes, _ := json.Marshal(payload)

		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(jsonBytes))
		if err != nil {
			continue
		}
		req.Header.Set("Authorization", "Bearer "+c.apiToken)
		req.Header.Set("Content-Type", "application/json")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != 200 {
			continue
		}

		var res struct {
			Success bool `json:"success"`
			Result  struct {
				Response string `json:"response"`
			} `json:"result"`
		}
		if err := json.Unmarshal(body, &res); err == nil && res.Result.Response != "" {
			return res.Result.Response, nil
		}
	}

	return "", fmt.Errorf("all cloudflare models failed or unavailable")
}
