package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ingress/internal/publisher"
)

type MetaHandler struct {
	AppSecret        string
	VerifyToken      string
	Publisher        publisher.Publisher
	PageClientRoutes map[string]int // Optional map: PageID -> ClientID
	DynamicRoute     func(pageID string) int
}

// NormalizedInboundEnvelope matches @tectonic/contracts InboundMessageEventSchema
type NormalizedInboundEnvelope struct {
	EventID        string          `json:"eventId"`
	ClientID       int             `json:"clientId"`
	Platform       string          `json:"platform"`
	PlatformUserID string          `json:"platformUserId"`
	CustomerName   string          `json:"customerName,omitempty"`
	CustomerPhone  string          `json:"customerPhone,omitempty"`
	Text           string          `json:"text"`
	ExternalID     string          `json:"externalId,omitempty"`
	Timestamp      string          `json:"timestamp"`
	RawJSON        json.RawMessage `json:"rawJson,omitempty"`
}

type metaWebhookPayload struct {
	Object string          `json:"object"`
	Entry  []metaEntryItem `json:"entry"`
}

type metaEntryItem struct {
	ID        string              `json:"id"`
	Time      int64               `json:"time"`
	Messaging []metaMessagingItem `json:"messaging"`
}

type metaMessagingItem struct {
	Sender    metaUserItem    `json:"sender"`
	Recipient metaUserItem    `json:"recipient"`
	Timestamp int64           `json:"timestamp"`
	Message   *metaMsgContent `json:"message"`
}

type metaUserItem struct {
	ID string `json:"id"`
}

type metaMsgContent struct {
	MID         string                `json:"mid"`
	Text        string                `json:"text"`
	IsEcho      bool                  `json:"is_echo"`
	QuickReply  *metaQuickReply       `json:"quick_reply,omitempty"`
	Attachments []metaMsgAttachment   `json:"attachments,omitempty"`
}

type metaQuickReply struct {
	Payload string `json:"payload"`
}

type metaMsgAttachment struct {
	Type    string                 `json:"type"`
	Payload metaAttachmentPayload `json:"payload"`
}

type metaAttachmentPayload struct {
	URL string `json:"url,omitempty"`
}

func (h *MetaHandler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		// Hub verify
		mode := r.URL.Query().Get("hub.mode")
		token := r.URL.Query().Get("hub.verify_token")
		challenge := r.URL.Query().Get("hub.challenge")

		if mode == "subscribe" && h.VerifyToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(h.VerifyToken)) == 1 {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(challenge))
			return
		}
		w.WriteHeader(http.StatusForbidden)
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if h.AppSecret == "" {
		log.Printf("Meta app secret not configured (fail closed)")
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 10<<20) // 10MB limit
	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("Failed to read body: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	signature := r.Header.Get("X-Hub-Signature-256")
	if signature == "" || !strings.HasPrefix(signature, "sha256=") {
		log.Printf("Missing or invalid signature header")
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	expectedSignature := signature[7:] // remove "sha256="
	expectedBytes, err := hex.DecodeString(expectedSignature)
	if err != nil {
		log.Printf("Invalid hex in signature header: %v", err)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	mac := hmac.New(sha256.New, []byte(h.AppSecret))
	mac.Write(body)
	calculatedBytes := mac.Sum(nil)

	if !hmac.Equal(expectedBytes, calculatedBytes) {
		log.Printf("Signature mismatch")
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	// Validate JSON schema
	var payload metaWebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		log.Printf("Malformed Meta JSON payload: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if len(payload.Entry) == 0 {
		// Valid empty payload (e.g. Meta ping/handshake)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("EVENT_RECEIVED"))
		return
	}

	// First pass: Validate routing for all entries and collect envelopes to publish.
	// Per requirements: Acknowledge HTTP 200 ONLY after ALL valid messages in the batch
	// are validated, routed to a known tenant, and durably published.
	// If any message is unroutable or broker publish fails, return 500 so Meta will retry,
	// handling partial batch dedup cleanly via stable mid.
	type readyEnvelope struct {
		routingKey string
		data       []byte
	}

	var toPublish []readyEnvelope
	seenMIDs := make(map[string]struct{})

	for _, entry := range payload.Entry {
		// Route by entry.id (Page ID / IG User ID) to client ID
		var clientID int
		if h.PageClientRoutes != nil {
			if cid, exists := h.PageClientRoutes[entry.ID]; exists && cid > 0 {
				clientID = cid
			}
		}

		if clientID == 0 && h.DynamicRoute != nil {
			clientID = h.DynamicRoute(entry.ID)
		}

		if clientID == 0 {
			log.Printf("Meta webhook event unroutable: entry ID '%s' has no mapped client (fail closed)", entry.ID)
			// Return 500 so Meta retries while logging unroutable condition
			http.Error(w, fmt.Sprintf("unroutable Meta event: unknown page %s", entry.ID), http.StatusInternalServerError)
			return
		}

		for _, item := range entry.Messaging {
			// Skip if no message content or if echo
			if item.Message == nil {
				continue
			}
			if item.Message.IsEcho {
				log.Printf("Skipping echo message (mid=%s)", item.Message.MID)
				continue
			}

			// Deduplicate within the batch by stable mid
			mid := item.Message.MID
			if mid != "" {
				if _, seen := seenMIDs[mid]; seen {
					log.Printf("Skipping duplicate mid in same batch (mid=%s)", mid)
					continue
				}
				seenMIDs[mid] = struct{}{}
			}

			// Resolve text content: text, quick_reply payload, or attachments
			var textContent string
			if item.Message.Text != "" {
				textContent = item.Message.Text
			} else if item.Message.QuickReply != nil && item.Message.QuickReply.Payload != "" {
				textContent = item.Message.QuickReply.Payload
			} else if len(item.Message.Attachments) > 0 {
				att := item.Message.Attachments[0]
				attType := att.Type
				if attType == "" {
					attType = "attachment"
				}
				if att.Payload.URL != "" {
					textContent = fmt.Sprintf("[%s: %s]", strings.Title(attType), att.Payload.URL)
				} else {
					textContent = fmt.Sprintf("[%s]", strings.Title(attType))
				}
			} else {
				// No text or recognizable attachment
				continue
			}

			// Format RFC3339 timestamp
			msgTime := time.Now().UTC()
			if item.Timestamp > 0 {
				msgTime = time.UnixMilli(item.Timestamp).UTC()
			}

			envelope := NormalizedInboundEnvelope{
				EventID:        GenerateUUID(),
				ClientID:       clientID,
				Platform:       "meta",
				PlatformUserID: item.Sender.ID,
				Text:           textContent,
				ExternalID:     mid,
				Timestamp:      msgTime.Format(time.RFC3339),
				RawJSON:        body,
			}

			envelopeBytes, err := json.Marshal(envelope)
			if err != nil {
				log.Printf("Failed to marshal normalized envelope: %v", err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}

			toPublish = append(toPublish, readyEnvelope{
				routingKey: "message.incoming.meta",
				data:       envelopeBytes,
			})
		}
	}

	// Publish all messages
	for _, item := range toPublish {
		if err := h.Publisher.Publish(r.Context(), item.routingKey, item.data); err != nil {
			log.Printf("Failed to publish message: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
	}

	w.WriteHeader(http.StatusOK)
	w.Write([]byte("EVENT_RECEIVED"))
}
