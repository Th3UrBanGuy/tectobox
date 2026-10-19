package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTelegramHandler_FailClosed_EmptySecret(t *testing.T) {
	h := &TelegramHandler{
		WebhookSecret: "",
	}

	payload := `{"update_id":12345}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	// Even if header matches empty secret, must fail closed with 500
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected status 500 when WebhookSecret is empty, got %d", rr.Code)
	}
}

func TestTelegramHandler_MissingSecretToken(t *testing.T) {
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 1},
	}

	payload := `{"update_id":12345}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for missing secret token header, got %d", rr.Code)
	}
}

func TestTelegramHandler_InvalidSecretToken(t *testing.T) {
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 1},
	}

	payload := `{"update_id":12345}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "wrong_token")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status 403 for invalid secret token, got %d", rr.Code)
	}
}

func TestTelegramHandler_BodyLimitExceeded(t *testing.T) {
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 1},
	}

	// Create body larger than 10MB (10MB + 1KB)
	largeBody := bytes.Repeat([]byte("b"), 10<<20+1024)
	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", bytes.NewReader(largeBody))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400 for body exceeding limit, got %d", rr.Code)
	}
}

func TestTelegramHandler_MethodNotAllowed(t *testing.T) {
	h := &TelegramHandler{
		WebhookSecret: "secret_12345",
	}

	req := httptest.NewRequest(http.MethodGet, "/webhooks/telegram", io.NopCloser(strings.NewReader("")))
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status 405, got %d", rr.Code)
	}
}

func TestTelegramHandler_POST_ValidMessage_DM(t *testing.T) {
	pub := &mockPublisher{}
	h := &TelegramHandler{
		BotTenantMap: map[string]int{
			"secret_12345": 1,
		},
		Publisher: pub,
	}

	payload := `{
		"update_id": 999123,
		"message": {
			"message_id": 1001,
			"from": {
				"id": 1234567,
				"is_bot": false,
				"first_name": "Alice",
				"last_name": "Smith",
				"username": "alicesmith"
			},
			"chat": {
				"id": 1234567,
				"type": "private"
			},
			"date": 1710000000,
			"text": "Hello Telegram bot!"
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 published message, got %d", len(pub.published))
	}
	if pub.published[0].RoutingKey != "message.incoming.telegram" {
		t.Fatalf("expected routing key message.incoming.telegram, got %s", pub.published[0].RoutingKey)
	}

	var env NormalizedInboundEnvelope
	if err := json.Unmarshal(pub.published[0].Body, &env); err != nil {
		t.Fatalf("failed to unmarshal published envelope: %v", err)
	}
	if env.ClientID != 1 {
		t.Fatalf("expected ClientID 1, got %d", env.ClientID)
	}
	if env.Platform != "telegram" {
		t.Fatalf("expected platform 'telegram', got %s", env.Platform)
	}
	if env.PlatformUserID != "1234567" {
		t.Fatalf("expected PlatformUserID '1234567', got %s", env.PlatformUserID)
	}
	if env.CustomerName != "Alice Smith" {
		t.Fatalf("expected CustomerName 'Alice Smith', got %s", env.CustomerName)
	}
	if env.Text != "Hello Telegram bot!" {
		t.Fatalf("expected text 'Hello Telegram bot!', got %s", env.Text)
	}
	if env.ExternalID != "1001" {
		t.Fatalf("expected ExternalID '1001', got %s", env.ExternalID)
	}
}

func TestTelegramHandler_POST_ValidMessage_GroupChat(t *testing.T) {
	pub := &mockPublisher{}
	h := &TelegramHandler{
		BotTenantMap: map[string]int{
			"secret_12345": 5,
		},
		Publisher: pub,
	}

	payload := `{
		"update_id": 999124,
		"message": {
			"message_id": 1002,
			"from": {
				"id": 98765,
				"first_name": "Bob"
			},
			"chat": {
				"id": -100123456789,
				"type": "group",
				"title": "Tectobox Support Group"
			},
			"date": 1710000000,
			"text": "Support question"
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 published message, got %d", len(pub.published))
	}

	var env NormalizedInboundEnvelope
	if err := json.Unmarshal(pub.published[0].Body, &env); err != nil {
		t.Fatalf("failed to unmarshal published envelope: %v", err)
	}
	if env.ClientID != 5 {
		t.Fatalf("expected ClientID 5, got %d", env.ClientID)
	}
	if env.PlatformUserID != "-100123456789" {
		t.Fatalf("expected PlatformUserID '-100123456789', got %s", env.PlatformUserID)
	}
	if env.CustomerName != "Tectobox Support Group" {
		t.Fatalf("expected CustomerName 'Tectobox Support Group', got %s", env.CustomerName)
	}
}

func TestTelegramHandler_POST_UnknownBot_Returns403(t *testing.T) {
	pub := &mockPublisher{}
	h := &TelegramHandler{
		BotTenantMap: map[string]int{
			"known_bot_secret": 1,
		},
		Publisher: pub,
	}

	payload := `{"update_id": 123, "message": {"message_id": 1, "chat": {"id": 10}, "text": "hi"}}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "unknown_bot_secret")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unknown bot secret token, got %d", rr.Code)
	}
	if len(pub.published) != 0 {
		t.Fatalf("expected 0 published messages for unknown bot, got %d", len(pub.published))
	}
}

func TestTelegramHandler_POST_EditedMessage(t *testing.T) {
	pub := &mockPublisher{}
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 1},
		Publisher:    pub,
	}

	payload := `{
		"update_id": 999126,
		"edited_message": {
			"message_id": 2001,
			"chat": {"id": 12345, "type": "private"},
			"date": 1710000000,
			"edit_date": 1710000050,
			"text": "Edited text content"
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 published message, got %d", len(pub.published))
	}

	var env NormalizedInboundEnvelope
	_ = json.Unmarshal(pub.published[0].Body, &env)
	if env.Text != "Edited text content" {
		t.Fatalf("expected 'Edited text content', got %s", env.Text)
	}
	if env.ExternalID != "2001" {
		t.Fatalf("expected '2001', got %s", env.ExternalID)
	}
}

func TestTelegramHandler_POST_MediaWithCaption(t *testing.T) {
	pub := &mockPublisher{}
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 2},
		Publisher:    pub,
	}

	payload := `{
		"update_id": 999127,
		"message": {
			"message_id": 3001,
			"chat": {"id": 12345, "type": "private"},
			"date": 1710000000,
			"caption": "Photo caption here",
			"photo": [{"file_id": "photo_123", "width": 100, "height": 100}]
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 published message, got %d", len(pub.published))
	}

	var env NormalizedInboundEnvelope
	_ = json.Unmarshal(pub.published[0].Body, &env)
	if env.Text != "Photo caption here" {
		t.Fatalf("expected caption text 'Photo caption here', got %s", env.Text)
	}
}

func TestTelegramHandler_POST_MediaWithoutCaption(t *testing.T) {
	pub := &mockPublisher{}
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 2},
		Publisher:    pub,
	}

	payload := `{
		"update_id": 999128,
		"message": {
			"message_id": 3002,
			"chat": {"id": 12345, "type": "private"},
			"date": 1710000000,
			"document": {"file_id": "doc_123", "file_name": "invoice.pdf"}
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 published message, got %d", len(pub.published))
	}

	var env NormalizedInboundEnvelope
	_ = json.Unmarshal(pub.published[0].Body, &env)
	if env.Text != "[Document: invoice.pdf]" {
		t.Fatalf("expected '[Document: invoice.pdf]', got %s", env.Text)
	}
}

func TestTelegramHandler_POST_NonMessageUpdate_AcknowledgedWithoutPublish(t *testing.T) {
	pub := &mockPublisher{}
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 1},
		Publisher:    pub,
	}

	// Telegram update without "message" (e.g. callback_query or my_chat_member)
	payload := `{"update_id": 999125, "callback_query": {"id": "123"}}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if len(pub.published) != 0 {
		t.Fatalf("expected 0 published messages for non-message update, got %d", len(pub.published))
	}
}

func TestTelegramHandler_POST_MalformedJSON(t *testing.T) {
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 1},
	}

	payload := `{not-valid-json`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed json, got %d", rr.Code)
	}
}

func TestTelegramHandler_POST_PublisherFailure_Returns500(t *testing.T) {
	pub := &mockPublisher{err: fmt.Errorf("broker unreachable")}
	h := &TelegramHandler{
		BotTenantMap: map[string]int{"secret_12345": 1},
		Publisher:    pub,
	}

	payload := `{
		"update_id": 1,
		"message": {
			"message_id": 100,
			"chat": {"id": 123},
			"text": "test"
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/webhooks/telegram", strings.NewReader(payload))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secret_12345")
	rr := httptest.NewRecorder()

	h.HandleWebhook(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on publisher error, got %d", rr.Code)
	}
}
