package gemini

// Model registry — split from client.go in Phase 4 of the modular
// restructure. The model list is a config surface (new Gemini versions
// arrive regularly); editing it no longer means touching the HTTP client.

type ModelInfo struct {
	ID          string `json:"id"`
	Mode        int    `json:"mode"`
	Think       int    `json:"think"`
	Description string `json:"description"`
}

var AvailableModels = map[string]ModelInfo{
	"gemini-3.7-flash": {
		ID:          "gemini-3.7-flash",
		Mode:        1,
		Think:       4,
		Description: "Latest all-around model (Gemini 3.7 Flash)",
	},
	"gemini-3.6-flash": {
		ID:          "gemini-3.6-flash",
		Mode:        1,
		Think:       4,
		Description: "All-around model (Gemini 3.6 Flash)",
	},
	"gemini-3.5-flash": {
		ID:          "gemini-3.5-flash",
		Mode:        1,
		Think:       4,
		Description: "Alias for gemini-3.6-flash",
	},
	"gemini-3.5-flash-thinking": {
		ID:          "gemini-3.5-flash-thinking",
		Mode:        2,
		Think:       0,
		Description: "Deep thinking mode, longest output",
	},
	"gemini-auto": {
		ID:          "gemini-auto",
		Mode:        4,
		Think:       4,
		Description: "Auto model selection",
	},
	"gemini-flash-lite": {
		ID:          "gemini-flash-lite",
		Mode:        6,
		Think:       4,
		Description: "Lightweight fast model",
	},
}

// DefaultModel is the fallback when a caller names an unknown model.
const DefaultModel = "gemini-3.6-flash"

// DefaultBL is the Gemini web-UI build token the client starts with. It
// was hardcoded in two places (client.go NewClient and session.go
// GetSessionPool); both now read this one constant. FetchLatestBL
// (bl.go) refreshes the client's copy at runtime; the session pool's
// copy is only the starting value.
const DefaultBL = "boq_assistant-bard-web-server_20260716.08_p0"

// DefaultUserAgent is the browser User-Agent the undocumented web-UI
// endpoint expects.
const DefaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

// ResolveModel returns the ModelInfo for name, or the default model when
// the name is unknown.
func ResolveModel(name string) ModelInfo {
	if model, ok := AvailableModels[name]; ok {
		return model
	}
	return AvailableModels[DefaultModel]
}
