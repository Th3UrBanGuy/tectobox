package handler

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetaHandler_GET_Subscribe_ValidToken(t *testing.T) {
	h := &MetaHandler{
		AppSecret:   "app_secret_123",
		VerifyToken: "verify_token_abc",
	}

	req := httptest.NewRequest(http.MethodGet, "/webhooks/meta?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=verify_token_abc", nil)
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
	if rr.Body.String() != "1158201444" {
		t.Fatalf("expected challenge '1158201444', got '%s'", rr.Body.String())
	}
}

func TestMetaHandler_GET_Subscribe_InvalidToken(t *testing.T) {
	h := &MetaHandler{
		AppSecret:   "app_secret_123",
		VerifyToken: "verify_token_abc",
	}

	req := httptest.NewRequest(http.MethodGet, "/webhooks/meta?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=wrong_token", nil)
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", rr.Code)
	}
}

func TestMetaHandler_GET_Subscribe_EmptyConfiguredToken(t *testing.T) {
	h := &MetaHandler{
		AppSecret:   "app_secret_123",
		VerifyToken: "",
	}

	req := httptest.NewRequest(http.MethodGet, "/webhooks/meta?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=some_token", nil)
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status 403 when verify token is not configured, got %d", rr.Code)
	}
}

func TestMetaHandler_POST_FailClosed_EmptyAppSecret(t *testing.T) {
	h := &MetaHandler{
		AppSecret:   "",
		VerifyToken: "verify_token_abc",
	}

	payload := `{"entry":[]}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", "sha256=anything")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected status 500 when AppSecret is empty, got %d", rr.Code)
	}
}

func TestMetaHandler_POST_MissingSignatureHeader(t *testing.T) {
	h := &MetaHandler{
		AppSecret:   "test_app_secret",
		VerifyToken: "verify_token_abc",
	}

	payload := `{"entry":[]}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for missing signature, got %d", rr.Code)
	}
}

func TestMetaHandler_POST_InvalidHexSignature(t *testing.T) {
	h := &MetaHandler{
		AppSecret:   "test_app_secret",
		VerifyToken: "verify_token_abc",
	}

	payload := `{"entry":[]}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", "sha256=not-a-valid-hex-string!")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for invalid hex signature, got %d", rr.Code)
	}
}

func TestMetaHandler_POST_SignatureMismatch(t *testing.T) {
	h := &MetaHandler{
		AppSecret:   "test_app_secret",
		VerifyToken: "verify_token_abc",
	}

	payload := `{"entry":[]}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	// Valid hex, but wrong signature
	fakeSig := hex.EncodeToString(make([]byte, 32))
	req.Header.Set("X-Hub-Signature-256", "sha256="+fakeSig)
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for signature mismatch, got %d", rr.Code)
	}
}

func TestMetaHandler_POST_BodyLimitExceeded(t *testing.T) {
	h := &MetaHandler{
		AppSecret:   "test_app_secret",
		VerifyToken: "verify_token_abc",
	}

	// Create body larger than 10MB (10MB + 1KB)
	largeBody := bytes.Repeat([]byte("a"), 10<<20+1024)
	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", bytes.NewReader(largeBody))

	mac := hmac.New(sha256.New, []byte(h.AppSecret))
	mac.Write(largeBody)
	sig := hex.EncodeToString(mac.Sum(nil))
	req.Header.Set("X-Hub-Signature-256", "sha256="+sig)

	rr := httptest.NewRecorder()
	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400 for body exceeding limit, got %d", rr.Code)
	}
}

func TestMetaHandler_MethodNotAllowed(t *testing.T) {
	h := &MetaHandler{
		AppSecret: "test_app_secret",
	}

	req := httptest.NewRequest(http.MethodPut, "/webhooks/meta", io.NopCloser(strings.NewReader("")))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status 405, got %d", rr.Code)
	}
}

type mockPublisher struct {
	published []struct {
		RoutingKey string
		Body       []byte
	}
	err error
}

func (m *mockPublisher) Publish(ctx context.Context, routingKey string, body []byte) error {
	if m.err != nil {
		return m.err
	}
	m.published = append(m.published, struct {
		RoutingKey string
		Body       []byte
	}{RoutingKey: routingKey, Body: body})
	return nil
}

func (m *mockPublisher) Close() {}

func signMetaPayload(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestMetaHandler_POST_ValidRealPayload_Routed(t *testing.T) {
	pub := &mockPublisher{}
	h := &MetaHandler{
		AppSecret:        "test_secret",
		Publisher:        pub,
		PageClientRoutes: map[string]int{"page_123": 42},
	}

	payload := `{
		"object": "page",
		"entry": [
			{
				"id": "page_123",
				"time": 1710000000000,
				"messaging": [
					{
						"sender": {"id": "user_456"},
						"recipient": {"id": "page_123"},
						"timestamp": 1710000000000,
						"message": {
							"mid": "mid.123456789",
							"text": "Hello world"
						}
					}
				]
			}
		]
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", signMetaPayload("test_secret", payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 published message, got %d", len(pub.published))
	}
	if pub.published[0].RoutingKey != "message.incoming.meta" {
		t.Fatalf("expected routing key message.incoming.meta, got %s", pub.published[0].RoutingKey)
	}

	var env NormalizedInboundEnvelope
	if err := json.Unmarshal(pub.published[0].Body, &env); err != nil {
		t.Fatalf("failed to unmarshal published envelope: %v", err)
	}
	if env.ClientID != 42 {
		t.Fatalf("expected ClientID 42, got %d", env.ClientID)
	}
	if env.Platform != "meta" {
		t.Fatalf("expected platform 'meta', got %s", env.Platform)
	}
	if env.PlatformUserID != "user_456" {
		t.Fatalf("expected PlatformUserID 'user_456', got %s", env.PlatformUserID)
	}
	if env.Text != "Hello world" {
		t.Fatalf("expected text 'Hello world', got %s", env.Text)
	}
	if env.ExternalID != "mid.123456789" {
		t.Fatalf("expected ExternalID 'mid.123456789', got %s", env.ExternalID)
	}
}

func TestMetaHandler_POST_IgnoreEchoes(t *testing.T) {
	pub := &mockPublisher{}
	h := &MetaHandler{
		AppSecret:        "test_secret",
		Publisher:        pub,
		PageClientRoutes: map[string]int{"page_123": 42},
	}

	payload := `{
		"object": "page",
		"entry": [
			{
				"id": "page_123",
				"time": 1710000000000,
				"messaging": [
					{
						"sender": {"id": "page_123"},
						"recipient": {"id": "user_456"},
						"timestamp": 1710000000000,
						"message": {
							"mid": "mid.echo999",
							"text": "Echo back from us",
							"is_echo": true
						}
					}
				]
			}
		]
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", signMetaPayload("test_secret", payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if len(pub.published) != 0 {
		t.Fatalf("expected 0 published messages for echo, got %d", len(pub.published))
	}
}

func TestMetaHandler_POST_UnroutablePage_Returns500(t *testing.T) {
	pub := &mockPublisher{}
	h := &MetaHandler{
		AppSecret:        "test_secret",
		Publisher:        pub,
		PageClientRoutes: map[string]int{"page_known": 42},
	}

	payload := `{
		"object": "page",
		"entry": [
			{
				"id": "unknown_page_999",
				"time": 1710000000000,
				"messaging": [
					{
						"sender": {"id": "user_1"},
						"message": {"mid": "mid.1", "text": "Hi"}
					}
				]
			}
		]
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", signMetaPayload("test_secret", payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for unroutable page to allow retry, got %d", rr.Code)
	}
	if len(pub.published) != 0 {
		t.Fatalf("expected 0 published messages, got %d", len(pub.published))
	}
}

func TestMetaHandler_POST_QuickReplyAndAttachments(t *testing.T) {
	pub := &mockPublisher{}
	h := &MetaHandler{
		AppSecret:        "test_secret",
		Publisher:        pub,
		PageClientRoutes: map[string]int{"page_123": 10},
	}

	payload := `{
		"object": "page",
		"entry": [
			{
				"id": "page_123",
				"messaging": [
					{
						"sender": {"id": "user_1"},
						"message": {
							"mid": "mid.qr1",
							"quick_reply": {"payload": "DEVELOPER_SUPPORT"}
						}
					},
					{
						"sender": {"id": "user_2"},
						"message": {
							"mid": "mid.att1",
							"attachments": [
								{"type": "image", "payload": {"url": "https://example.com/img.png"}}
							]
						}
					}
				]
			}
		]
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", signMetaPayload("test_secret", payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if len(pub.published) != 2 {
		t.Fatalf("expected 2 published messages, got %d", len(pub.published))
	}

	var env1 NormalizedInboundEnvelope
	_ = json.Unmarshal(pub.published[0].Body, &env1)
	if env1.Text != "DEVELOPER_SUPPORT" {
		t.Fatalf("expected quick reply payload text, got %s", env1.Text)
	}
	if env1.ExternalID != "mid.qr1" {
		t.Fatalf("expected ExternalID mid.qr1, got %s", env1.ExternalID)
	}

	var env2 NormalizedInboundEnvelope
	_ = json.Unmarshal(pub.published[1].Body, &env2)
	if env2.Text != "[Image: https://example.com/img.png]" {
		t.Fatalf("expected attachment text formatted, got %s", env2.Text)
	}
	if env2.ExternalID != "mid.att1" {
		t.Fatalf("expected ExternalID mid.att1, got %s", env2.ExternalID)
	}
}

func TestMetaHandler_POST_BatchDeduplication(t *testing.T) {
	pub := &mockPublisher{}
	h := &MetaHandler{
		AppSecret:        "test_secret",
		Publisher:        pub,
		PageClientRoutes: map[string]int{"page_123": 10},
	}

	// Payload with duplicate mid in the same batch
	payload := `{
		"object": "page",
		"entry": [
			{
				"id": "page_123",
				"messaging": [
					{
						"sender": {"id": "user_1"},
						"message": {"mid": "mid.duplicate_id", "text": "First copy"}
					},
					{
						"sender": {"id": "user_1"},
						"message": {"mid": "mid.duplicate_id", "text": "Second copy"}
					}
				]
			}
		]
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", signMetaPayload("test_secret", payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected deduplication to result in 1 message, got %d", len(pub.published))
	}
}

func TestMetaHandler_POST_PartialBatchFailure_Returns500(t *testing.T) {
	pub := &mockPublisher{}
	h := &MetaHandler{
		AppSecret:        "test_secret",
		Publisher:        pub,
		PageClientRoutes: map[string]int{"page_known": 10}, // page_unknown has no route
	}

	// First entry is routable, second is unroutable
	payload := `{
		"object": "page",
		"entry": [
			{
				"id": "page_known",
				"messaging": [
					{"sender": {"id": "user_1"}, "message": {"mid": "mid.1", "text": "Hi"}}
				]
			},
			{
				"id": "page_unknown",
				"messaging": [
					{"sender": {"id": "user_2"}, "message": {"mid": "mid.2", "text": "Hello"}}
				]
			}
		]
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", signMetaPayload("test_secret", payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when batch contains unroutable entry, got %d", rr.Code)
	}
	// Nothing published because validation fails before publish
	if len(pub.published) != 0 {
		t.Fatalf("expected 0 published messages due to validation rejection, got %d", len(pub.published))
	}
}

func TestMetaHandler_POST_PublisherFailure_Returns500(t *testing.T) {
	pub := &mockPublisher{err: fmt.Errorf("rabbitmq connection lost")}
	h := &MetaHandler{
		AppSecret:        "test_secret",
		Publisher:        pub,
		PageClientRoutes: map[string]int{"page_123": 42},
	}

	payload := `{
		"object": "page",
		"entry": [
			{
				"id": "page_123",
				"messaging": [
					{
						"sender": {"id": "user_1"},
						"message": {"mid": "mid.1", "text": "Hi"}
					}
				]
			}
		]
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", signMetaPayload("test_secret", payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on publisher failure, got %d", rr.Code)
	}
}

func TestMetaHandler_POST_MalformedPayload(t *testing.T) {
	h := &MetaHandler{
		AppSecret: "test_secret",
	}

	payload := `not-a-json-object`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/meta", strings.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", signMetaPayload("test_secret", payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed JSON, got %d", rr.Code)
	}
}
