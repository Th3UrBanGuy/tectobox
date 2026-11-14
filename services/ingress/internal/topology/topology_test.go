package topology

import "testing"

// Drift check: the generated values must equal the literal strings the
// broker, the TypeScript services, and the handler tests expect. If a
// value here disagrees with topology.ts, regenerate with
// `node scripts/generate-go-topology.mjs` — do not hand-edit this file
// or the generated values. The handler tests assert the same literal
// routing keys independently, so a generator regression fails twice.
func TestTopologyValues(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"EVENTS_EXCHANGE", EVENTS_EXCHANGE, "tectobox.events"},
		{"DLX_EXCHANGE", DLX_EXCHANGE, "tectobox.dlx"},
		{"RETRY_EXCHANGE", RETRY_EXCHANGE, "tectobox.retry"},
		{"IncomingRoutingKey(meta)", IncomingRoutingKey("meta"), "message.incoming.meta"},
		{"IncomingRoutingKey(telegram)", IncomingRoutingKey("telegram"), "message.incoming.telegram"},
		{"IncomingRoutingKey(whatsapp)", IncomingRoutingKey("whatsapp"), "message.incoming.whatsapp"},
		{"OutgoingRoutingKey(whatsapp)", OutgoingRoutingKey("whatsapp"), "message.outgoing.whatsapp"},
		{"ConnectRoutingKey(whatsapp)", ConnectRoutingKey("whatsapp"), "channel.connect.whatsapp"},
		{"INBOUND_QUEUE", INBOUND_QUEUE, "tectobox.inbound.messages"},
		{"AI_REQUESTS_QUEUE", AI_REQUESTS_QUEUE, "ai.requests"},
		{"BROADCAST_JOBS_QUEUE", BROADCAST_JOBS_QUEUE, "broadcast.jobs"},
		{"MetaPageKey", MetaPageKey("page_123"), "meta:page:page_123"},
		{"TelegramBotKey", TelegramBotKey("tok_1"), "telegram:bot:tok_1"},
		{"WaQrKey", WaQrKey("69", "default"), "wa:qr:69:default"},
		{"WaPairingKey", WaPairingKey("69", "default"), "wa:pairing:69:default"},
		{"TgSessionKey", TgSessionKey("69", "default"), "tg:session:69:default"},
		{"TgCodeHashKey", TgCodeHashKey("69", "default"), "tg:codehash:69:default"},
		{"LeaseKey", LeaseKey("wa:69:default"), "lease:wa:69:default"},
		{"TenantEventsChannel", TenantEventsChannel("69"), "tenant:69:events"},
		{"SSEEventTypeMessage", SSEEventTypeMessage, "message"},
		{"SSEEventTypePairingCode", SSEEventTypePairingCode, "pairing_code"},
		{"SSEEventTypeChannelStatus", SSEEventTypeChannelStatus, "channel_status"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, c.got, c.want)
		}
	}
}

// The DEFAULT slot omits the suffix; any other slot carries it; an
// empty slot behaves like the default. This asymmetry is the one
// builder whose body is a ternary, not a template literal.
func TestTelegramSessionKey(t *testing.T) {
	cases := []struct {
		clientID string
		slot     string
		want     string
	}{
		{"69", "", "tg:69"},
		{"69", "default", "tg:69"},
		{"69", "slot2", "tg:69:slot2"},
	}
	for _, c := range cases {
		if got := TelegramSessionKey(c.clientID, c.slot); got != c.want {
			t.Errorf("TelegramSessionKey(%q, %q): got %q, want %q", c.clientID, c.slot, got, c.want)
		}
	}
}

func TestTopologyTTLs(t *testing.T) {
	if QR_TTL_SECONDS != 120 {
		t.Errorf("QR_TTL_SECONDS: got %d, want 120", QR_TTL_SECONDS)
	}
	if PAIRING_TTL_SECONDS != 120 {
		t.Errorf("PAIRING_TTL_SECONDS: got %d, want 120", PAIRING_TTL_SECONDS)
	}
	if TELEGRAM_CODE_TTL_SECONDS != 300 {
		t.Errorf("TELEGRAM_CODE_TTL_SECONDS: got %d, want 300", TELEGRAM_CODE_TTL_SECONDS)
	}
	if SEND_ATTEMPT_TTL_SECONDS != 86400 {
		t.Errorf("SEND_ATTEMPT_TTL_SECONDS: got %d, want 86400", SEND_ATTEMPT_TTL_SECONDS)
	}
	if LEASE_TTL_SECONDS != 60 {
		t.Errorf("LEASE_TTL_SECONDS: got %d, want 60", LEASE_TTL_SECONDS)
	}
	if RETRY_TTL_MS != 5000 {
		t.Errorf("RETRY_TTL_MS: got %d, want 5000", RETRY_TTL_MS)
	}
}
