package router

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// ClientID is a validated workspace tenant id for the internal AI chat
// endpoint (POST /api/ai/chat). It is the type-level close of the F1
// leak: the endpoint used to take client_id as interface{}, so a
// camelCase `clientId` decoded to nil and fmt.Sprintf("%v", nil)
// produced "<nil>" — one shared cache key and one shared rate-limit
// bucket for every workspace. ClientID can only ever hold a real
// tenant id:
//
//   - a JSON string, non-empty ("69");
//   - a JSON number, coerced to its decimal string (69 -> "69") — the
//     same coercion as the Phase 1 wire schema AiRequestWireMessageSchema,
//     which does Number(clientId) and requires it non-zero.
//
// It rejects null, booleans, objects, arrays, the empty string, and
// the number 0. A missing client_id never calls UnmarshalJSON, so it
// unmarshals to "" — the handler rejects that with 400; it never
// reaches the engine, and the "<nil>" fallback is gone for good.
type ClientID string

// String returns the tenant id as the cache key / rate-limit bucket.
func (c ClientID) String() string {
	return string(c)
}

// UnmarshalJSON implements json.Unmarshaler for ClientID.
func (c *ClientID) UnmarshalJSON(data []byte) error {
	// JSON string: non-empty only.
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		if s == "" {
			return fmt.Errorf("client_id must be a non-empty string")
		}
		*c = ClientID(s)
		return nil
	}
	// JSON number: coerce to its decimal string; reject 0.
	var n json.Number
	if err := json.Unmarshal(data, &n); err == nil {
		f, err := n.Float64()
		if err != nil {
			return fmt.Errorf("client_id must be a valid number")
		}
		if f == 0 {
			return fmt.Errorf("client_id must be a non-zero number")
		}
		*c = ClientID(strconv.FormatFloat(f, 'f', -1, 64))
		return nil
	}
	return fmt.Errorf("client_id must be a non-empty string or a non-zero number")
}

// Domain types for the AI engine — split from engine.go in Phase 4 of the
// modular restructure. These are the wire contract with the Node callers
// (PromptContext mirrors the JSON the Go bridge receives); they must not
// move silently when the engine is refactored.

// ProductItem is one catalog row the prompt and the responder quote.
type ProductItem struct {
	Name     string      `json:"name"`
	SKU      string      `json:"sku,omitempty"`
	PriceBDT interface{} `json:"price_bdt"`
	Stock    int         `json:"stock,omitempty"`
	Category string      `json:"category,omitempty"`
}

// KnowledgeItem is one store policy / knowledge-base row.
type KnowledgeItem struct {
	Title    string `json:"title"`
	Content  string `json:"content"`
	Category string `json:"category,omitempty"`
}

// PromptContext is the workspace-scoped context for one reply: the tenant
// id (ClientID), the store identity, and the catalog + knowledge the reply
// must be grounded in. ClientID is the tenant-isolation key — see cacheKey
// in cache.go and the F1 guard in direct.go.
type PromptContext struct {
	ClientID     string          `json:"client_id,omitempty"`
	ClientName   string          `json:"client_name,omitempty"`
	BusinessType string          `json:"business_type,omitempty"`
	Products     []ProductItem   `json:"products,omitempty"`
	Knowledge    []KnowledgeItem `json:"knowledge,omitempty"`
}

// ChatMessage is one turn of the conversation history.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
