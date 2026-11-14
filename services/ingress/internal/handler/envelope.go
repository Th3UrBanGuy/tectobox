package handler

import (
	"context"
	"encoding/json"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ingress/internal/publisher"
)

// NormalizedInboundEnvelope is the one shape every inbound message is
// published as. It matches @tectonic/contracts
// InboundMessageEventSchema (packages/contracts/src/events.ts) and the
// Phase 1 InboundWireMessageSchema (packages/contracts/src/wire.ts):
// camelCase JSON tags, eventId a UUID, clientId a number, platform one
// of meta/telegram/whatsapp/webchat, platformUserId and text non-empty,
// timestamp an RFC 3339 datetime string. The api consumer
// (services/api/src/events/events.service.ts) hand-coerces and silently
// drops anything that fails that schema — so this builder must produce
// exactly what the consumer accepts, and nothing else may construct
// the envelope by hand.
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

// InboundEnvelopeParams are the inputs to NewInboundEnvelope. A struct
// (not nine positional args) so a caller cannot silently swap two
// string fields. CustomerName / CustomerPhone / ExternalID are optional
// and omitted when empty; Timestamp is formatted to RFC 3339 here so
// no caller can emit a non-datetime string.
type InboundEnvelopeParams struct {
	ClientID       int
	Platform       string
	PlatformUserID string
	CustomerName   string
	CustomerPhone  string
	Text           string
	ExternalID     string
	Timestamp      time.Time
	RawJSON        json.RawMessage
}

// NewInboundEnvelope builds the normalized envelope for one inbound
// message, assigning a fresh UUID eventId. It is the only constructor:
// both handlers (meta, telegram) build through it, so the envelope
// shape cannot drift between platforms again.
func NewInboundEnvelope(p InboundEnvelopeParams) NormalizedInboundEnvelope {
	return NormalizedInboundEnvelope{
		EventID:        GenerateUUID(),
		ClientID:       p.ClientID,
		Platform:       p.Platform,
		PlatformUserID: p.PlatformUserID,
		CustomerName:   p.CustomerName,
		CustomerPhone:  p.CustomerPhone,
		Text:           p.Text,
		ExternalID:     p.ExternalID,
		Timestamp:      p.Timestamp.Format(time.RFC3339),
		RawJSON:        p.RawJSON,
	}
}

// PublishEnvelope marshals an envelope and publishes it under routingKey.
// It returns the marshal or publish error unchanged so the handler can
// fail closed (HTTP 500, so the platform retries). The meta handler
// does NOT use it: it batches envelopes and must marshal each one
// during the validation pass, before anything is published, so a
// marshal failure cannot leave half a batch published.
func PublishEnvelope(ctx context.Context, pub publisher.Publisher, routingKey string, env NormalizedInboundEnvelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return pub.Publish(ctx, routingKey, data)
}
