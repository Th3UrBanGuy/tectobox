package handler

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ingress/internal/publisher"
)

type TelegramHandler struct {
	WebhookSecret string
	BotTenantMap  map[string]int // Map of secret/token to tenant ClientID
	Publisher     publisher.Publisher
	DynamicRoute  func(secretToken string) int
}

type telegramUpdatePayload struct {
	UpdateID          int64            `json:"update_id"`
	Message           *telegramMessage `json:"message"`
	EditedMessage     *telegramMessage `json:"edited_message"`
	ChannelPost       *telegramMessage `json:"channel_post"`
	EditedChannelPost *telegramMessage `json:"edited_channel_post"`
}

type telegramMessage struct {
	MessageID int64              `json:"message_id"`
	From      *telegramUser      `json:"from"`
	Chat      telegramChat       `json:"chat"`
	Date      int64              `json:"date"`
	EditDate  int64              `json:"edit_date,omitempty"`
	Text      string             `json:"text"`
	Caption   string             `json:"caption"`
	Photo     []telegramPhotoSize `json:"photo,omitempty"`
	Document  *telegramDocument  `json:"document,omitempty"`
	Audio     *telegramAudio     `json:"audio,omitempty"`
	Voice     *telegramVoice     `json:"voice,omitempty"`
	Video     *telegramVideo     `json:"video,omitempty"`
	Sticker   *telegramSticker   `json:"sticker,omitempty"`
}

type telegramPhotoSize struct {
	FileID   string `json:"file_id"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	FileSize int64  `json:"file_size,omitempty"`
}

type telegramDocument struct {
	FileID   string `json:"file_id"`
	FileName string `json:"file_name,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

type telegramAudio struct {
	FileID   string `json:"file_id"`
	Duration int    `json:"duration"`
	Performer string `json:"performer,omitempty"`
	Title    string `json:"title,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

type telegramVoice struct {
	FileID   string `json:"file_id"`
	Duration int    `json:"duration"`
	MimeType string `json:"mime_type,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

type telegramVideo struct {
	FileID   string `json:"file_id"`
	Duration int    `json:"duration"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	MimeType string `json:"mime_type,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

type telegramSticker struct {
	FileID string `json:"file_id"`
	Emoji  string `json:"emoji,omitempty"`
}

type telegramUser struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
}

type telegramChat struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

func (h *TelegramHandler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	secretToken := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")

	// Tenant resolution:
	// 1. Check BotTenantMap if configured (key can be secretToken)
	// 2. If WebhookSecret is configured, verify constant time match
	var clientID int
	if len(h.BotTenantMap) > 0 {
		if secretToken == "" {
			log.Printf("Telegram secret token header missing")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		// Match against BotTenantMap
		var found bool
		for tokenOrSecret, cid := range h.BotTenantMap {
			if subtle.ConstantTimeCompare([]byte(secretToken), []byte(tokenOrSecret)) == 1 {
				clientID = cid
				found = true
				break
			}
		}
		if !found && h.DynamicRoute != nil {
			clientID = h.DynamicRoute(secretToken)
			if clientID > 0 {
				found = true
			}
		}
		if !found || clientID <= 0 {
			log.Printf("Telegram bot secret not mapped to any known tenant (fail closed)")
			http.Error(w, "unknown or unmapped bot token", http.StatusForbidden)
			return
		}
	} else if h.WebhookSecret != "" {
		if subtle.ConstantTimeCompare([]byte(secretToken), []byte(h.WebhookSecret)) != 1 {
			log.Printf("Telegram secret token mismatch")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if h.DynamicRoute != nil {
			clientID = h.DynamicRoute(secretToken)
		}
		if clientID <= 0 {
			log.Printf("Telegram bot tenant mapping not configured (fail closed)")
			http.Error(w, "no tenant mapping configured", http.StatusForbidden)
			return
		}
	} else if h.DynamicRoute != nil && secretToken != "" {
		clientID = h.DynamicRoute(secretToken)
		if clientID <= 0 {
			log.Printf("Telegram bot dynamic routing failed for token (fail closed)")
			http.Error(w, "unknown or unmapped bot token", http.StatusForbidden)
			return
		}
	} else {
		log.Printf("Telegram webhook secret / tenant map not configured (fail closed)")
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

	// Validate JSON schema
	var update telegramUpdatePayload
	if err := json.Unmarshal(body, &update); err != nil {
		log.Printf("Malformed Telegram JSON payload: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	// Resolve the message from supported update types
	var msg *telegramMessage
	if update.Message != nil {
		msg = update.Message
	} else if update.EditedMessage != nil {
		msg = update.EditedMessage
	} else if update.ChannelPost != nil {
		msg = update.ChannelPost
	} else if update.EditedChannelPost != nil {
		msg = update.EditedChannelPost
	} else {
		// Telegram sends non-message updates (inline queries, callback queries, poll, my_chat_member, etc.)
		// Explicitly acknowledge with 200 without processing
		w.WriteHeader(http.StatusOK)
		return
	}

	// Determine text content or caption or media descriptor
	var textContent string
	if msg.Text != "" {
		textContent = msg.Text
	} else if msg.Caption != "" {
		textContent = msg.Caption
	} else if len(msg.Photo) > 0 {
		textContent = "[Photo]"
	} else if msg.Document != nil {
		if msg.Document.FileName != "" {
			textContent = fmt.Sprintf("[Document: %s]", msg.Document.FileName)
		} else {
			textContent = "[Document]"
		}
	} else if msg.Audio != nil {
		if msg.Audio.Title != "" {
			textContent = fmt.Sprintf("[Audio: %s]", msg.Audio.Title)
		} else {
			textContent = "[Audio]"
		}
	} else if msg.Voice != nil {
		textContent = "[Voice Message]"
	} else if msg.Video != nil {
		textContent = "[Video]"
	} else if msg.Sticker != nil {
		if msg.Sticker.Emoji != "" {
			textContent = fmt.Sprintf("[Sticker: %s]", msg.Sticker.Emoji)
		} else {
			textContent = "[Sticker]"
		}
	} else {
		// Message without text or known media (e.g. service message like pinned message or user joined)
		// Explicitly ignore with 200 rather than creating empty text
		w.WriteHeader(http.StatusOK)
		return
	}

	// PlatformUserID is chat ID or sender ID
	var platformUserID string
	if msg.Chat.ID != 0 {
		platformUserID = strconv.FormatInt(msg.Chat.ID, 10)
	} else if msg.From != nil {
		platformUserID = strconv.FormatInt(msg.From.ID, 10)
	}

	// CustomerName resolution
	var customerName string
	if msg.Chat.Type == "group" || msg.Chat.Type == "supergroup" || msg.Chat.Type == "channel" {
		customerName = msg.Chat.Title
	} else if msg.From != nil {
		parts := []string{}
		if msg.From.FirstName != "" {
			parts = append(parts, msg.From.FirstName)
		}
		if msg.From.LastName != "" {
			parts = append(parts, msg.From.LastName)
		}
		if len(parts) > 0 {
			customerName = strings.Join(parts, " ")
		} else if msg.From.Username != "" {
			customerName = "@" + msg.From.Username
		}
	}

	effectiveTimestamp := msg.Date
	if msg.EditDate > 0 {
		effectiveTimestamp = msg.EditDate
	}
	msgTime := time.Now().UTC()
	if effectiveTimestamp > 0 {
		msgTime = time.Unix(effectiveTimestamp, 0).UTC()
	}

	envelope := NormalizedInboundEnvelope{
		EventID:        GenerateUUID(),
		ClientID:       clientID,
		Platform:       "telegram",
		PlatformUserID: platformUserID,
		CustomerName:   customerName,
		Text:           textContent,
		ExternalID:     strconv.FormatInt(msg.MessageID, 10),
		Timestamp:      msgTime.Format(time.RFC3339),
		RawJSON:        body,
	}

	envelopeBytes, err := json.Marshal(envelope)
	if err != nil {
		log.Printf("Failed to marshal normalized envelope: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	routingKey := "message.incoming.telegram"
	err = h.Publisher.Publish(r.Context(), routingKey, envelopeBytes)
	if err != nil {
		log.Printf("Failed to publish message: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

