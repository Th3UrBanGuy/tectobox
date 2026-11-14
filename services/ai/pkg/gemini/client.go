package gemini

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Client talks to the undocumented Gemini web-UI StreamGenerate endpoint.
// Split in Phase 4 of the modular restructure: the model registry now
// lives in models.go, the BL-token lifecycle in bl.go, the payload +
// request builder in payload.go, and the response parsing in parse.go.
// This file keeps only the client wiring: Generate (buffered, with its
// 2-attempt retry), the buffered send helpers, and StreamGenerateChunks
// (channel-based streaming). GenerateForWorkspace lives in session.go
// with the session pool it belongs to.
type Client struct {
	httpClient *http.Client
	geminiBL   string
	blMutex    sync.RWMutex
	userAgent  string
}

func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 60 * time.Second},
		geminiBL:   DefaultBL,
		userAgent:  DefaultUserAgent,
	}
}

// Generate requests a full response and returns its text. It retries once
// (150ms backoff), refreshing the BL token first when the endpoint
// answers 405 — the 405 check is errors.Is against the typed sentinel
// now, not a substring match on the error text.
func (c *Client) Generate(ctx context.Context, prompt, modelName string) (string, error) {
	model := ResolveModel(modelName)

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
		if err != nil && errors.Is(err, ErrMethodNotAllowed) {
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

// doStreamGenerate is the buffered send through the client's own HTTP
// client. It returns the parsed response text.
func (c *Client) doStreamGenerate(ctx context.Context, prompt string, model ModelInfo) (string, error) {
	return c.doStreamGenerateWithClient(ctx, c.httpClient, prompt, model)
}

// doStreamGenerateWithClient is the buffered send through a given HTTP
// client (the per-workspace session client for GenerateForWorkspace).
// It builds the payload once (payload.go), sends it, reads the whole
// body, and parses the response text (parse.go).
func (c *Client) doStreamGenerateWithClient(ctx context.Context, client *http.Client, prompt string, model ModelInfo) (string, error) {
	payloadJSON, err := buildStreamGeneratePayload(prompt, model)
	if err != nil {
		return "", err
	}

	resp, err := c.doStreamGenerateRaw(ctx, payloadJSON, client)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	return extractResponseText(string(bodyBytes))
}

// doStreamGenerateRaw is the shared send: one request, one response, no
// body read. The buffered path reads the body whole; the streaming path
// reads it incrementally. A 405 returns the typed ErrMethodNotAllowed
// sentinel (same message text as before); any other non-200 returns
// "upstream status %d".
func (c *Client) doStreamGenerateRaw(ctx context.Context, payloadJSON string, client *http.Client) (*http.Response, error) {
	req, err := buildStreamGenerateRequest(ctx, c.getBL(), c.userAgent, payloadJSON)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode == http.StatusMethodNotAllowed {
		resp.Body.Close()
		return nil, ErrMethodNotAllowed
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	return resp, nil
}

// StreamGenerateChunks sends prompt and streams tokens via channel.
// It returns when the stream completes or an error occurs. Each chunk is
// the delta since the previous candidate text (cleaned), not the
// cumulative text. The channel is closed on return. This is the same
// read loop as before — only the payload build, the request build, and
// the per-line unwrapping are now shared (payload.go / parse.go); the
// non-200 error text ("status %d") is unchanged.
func (c *Client) StreamGenerateChunks(ctx context.Context, prompt string, modelName string, outCh chan<- string) error {
	defer close(outCh)

	model := ResolveModel(modelName)

	payloadJSON, err := buildStreamGeneratePayload(prompt, model)
	if err != nil {
		return err
	}

	req, err := buildStreamGenerateRequest(ctx, c.getBL(), c.userAgent, payloadJSON)
	if err != nil {
		return err
	}

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
				for _, textStr := range extractLineTexts(line) {
					if len(textStr) > len(prevText) {
						delta := textStr[len(prevText):]
						outCh <- cleanGeminiText(delta)
						prevText = textStr
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
