package gemini

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
)

// BL-token lifecycle — split from client.go in Phase 4 of the modular
// restructure. The `bl` token is the Gemini web-UI build tag the
// StreamGenerate endpoint requires; it rotates, so the client refreshes
// it when the endpoint answers 405.

// ErrMethodNotAllowed is returned when the StreamGenerate endpoint
// answers 405. It is a typed sentinel (not a string match): callers
// retry with a refreshed BL token on errors.Is(err, ErrMethodNotAllowed).
// The message text is unchanged from the old fmt.Errorf so any log
// grepping for "405" keeps working.
var ErrMethodNotAllowed = errors.New("upstream returned 405 Method Not Allowed")

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
