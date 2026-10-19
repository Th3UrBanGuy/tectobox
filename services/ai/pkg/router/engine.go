package router

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/cloudflare"
	"github.com/tect0nicofficial/tectobox/services/ai/pkg/detector"
	"github.com/tect0nicofficial/tectobox/services/ai/pkg/gemini"
)

type ProductItem struct {
	Name     string `json:"name"`
	SKU      string `json:"sku,omitempty"`
	PriceBDT string `json:"price_bdt"`
	Stock    int    `json:"stock,omitempty"`
	Category string `json:"category,omitempty"`
}

type KnowledgeItem struct {
	Title    string `json:"title"`
	Content  string `json:"content"`
	Category string `json:"category,omitempty"`
}

type PromptContext struct {
	ClientID     string          `json:"client_id,omitempty"`
	ClientName   string          `json:"client_name,omitempty"`
	BusinessType string          `json:"business_type,omitempty"`
	Products     []ProductItem   `json:"products,omitempty"`
	Knowledge    []KnowledgeItem `json:"knowledge,omitempty"`
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type CacheEntry struct {
	Reply     string
	ExpiresAt time.Time
}

type Engine struct {
	geminiClient *gemini.Client
	cfClient     *cloudflare.Client
	httpClient   *http.Client
	cache        map[string]CacheEntry
	cacheMutex   sync.RWMutex
}

func NewEngine() *Engine {
	e := &Engine{
		geminiClient: gemini.NewClient(),
		cfClient:     cloudflare.NewClient(),
		httpClient:   &http.Client{Timeout: 30 * time.Second},
		cache:        make(map[string]CacheEntry),
	}

	// Periodic cache cleanup
	go func() {
		ticker := time.NewTicker(2 * time.Minute)
		for range ticker.C {
			e.cleanExpiredCache()
		}
	}()

	return e
}

func (e *Engine) cleanExpiredCache() {
	e.cacheMutex.Lock()
	defer e.cacheMutex.Unlock()
	now := time.Now()
	for k, v := range e.cache {
		if now.After(v.ExpiresAt) {
			delete(e.cache, k)
		}
	}
}

func (e *Engine) getCached(key string) (string, bool) {
	e.cacheMutex.RLock()
	defer e.cacheMutex.RUnlock()
	entry, ok := e.cache[key]
	if !ok || time.Now().After(entry.ExpiresAt) {
		return "", false
	}
	return entry.Reply, true
}

func (e *Engine) setCache(key, val string, ttl time.Duration) {
	e.cacheMutex.Lock()
	defer e.cacheMutex.Unlock()
	e.cache[key] = CacheEntry{
		Reply:     val,
		ExpiresAt: time.Now().Add(ttl),
	}
}

func cacheKey(clientID string, lang detector.Language, text string, history []ChatMessage) string {
	h := sha256.New()
	historyHash := ""
	if len(history) > 0 {
		last := history[len(history)-1]
		historyHash = last.Role + ":" + strings.ToLower(strings.TrimSpace(last.Content))
	}
	h.Write([]byte(clientID + ":" + string(lang) + ":" + historyHash + ":" + strings.ToLower(strings.TrimSpace(text))))
	return hex.EncodeToString(h.Sum(nil))
}

// GenerateReply is the main high-performance AI entrypoint:
// 1. Detects customer language (Bangla script, Banglish, English)
// 2. Builds contextual system prompt with catalog, policies, and past conversation memory
// 3. Executes multi-tier routing: Gemini Web -> Cloudflare -> Direct APIs -> Demo responder
func (e *Engine) GenerateReply(ctx context.Context, pctx PromptContext, userMessage string, history []ChatMessage, modelPreference string) (string, detector.Language, string, bool) {
	cleanMsg := strings.TrimSpace(userMessage)
	if cleanMsg == "" {
		return "", detector.LangEnglish, "none", false
	}

	lang := detector.DetectLanguage(cleanMsg)
	cKey := cacheKey(pctx.ClientID, lang, cleanMsg, history)

	// Check cache
	if cached, ok := e.getCached(cKey); ok {
		return cached, lang, "cache", true
	}

	sysPrompt := BuildSystemPrompt(pctx, lang)

	// Format multi-turn transcript with conversational memory
	var sb strings.Builder
	sb.WriteString(sysPrompt)
	if len(history) > 0 {
		sb.WriteString("\n\n=== RECENT CONVERSATION HISTORY (PAST TURNS) ===\n")
		for _, h := range history {
			role := "Customer"
			if h.Role == "assistant" || h.Role == "model" || h.Role == "system" {
				role = "Assistant"
			}
			sb.WriteString(fmt.Sprintf("%s: %s\n", role, strings.TrimSpace(h.Content)))
		}
	}
	sb.WriteString("\nCustomer (Current Message): " + cleanMsg + "\nAssistant:")
	fullPrompt := sb.String()

	// Tier 1: Gemini Web2API (native Go)
	model := modelPreference
	if model == "" {
		model = "gemini-3.6-flash"
	}
	t1Ctx, t1Cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	if reply, err := e.geminiClient.Generate(t1Ctx, fullPrompt, model); err == nil && len(reply) > 0 {
		t1Cancel()
		e.setCache(cKey, reply, 5*time.Minute)
		return reply, lang, "gemini-web2api:" + model, false
	}
	t1Cancel()

	// Tier 2: Cloudflare Workers AI Playground models (full multi-turn message history)
	cfMessages := []cloudflare.Message{
		{Role: "system", Content: sysPrompt},
	}
	for _, h := range history {
		r := "user"
		if h.Role == "assistant" || h.Role == "model" {
			r = "assistant"
		}
		cfMessages = append(cfMessages, cloudflare.Message{Role: r, Content: h.Content})
	}
	cfMessages = append(cfMessages, cloudflare.Message{Role: "user", Content: cleanMsg})

	t2Ctx, t2Cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	if reply, err := e.cfClient.Generate(t2Ctx, cfMessages); err == nil && len(reply) > 0 {
		t2Cancel()
		e.setCache(cKey, reply, 5*time.Minute)
		return reply, lang, "cloudflare-pool", false
	}
	t2Cancel()

	// Tier 3: Direct APIs (OpenRouter / OpenAI / Gemini API if configured)
	t3Ctx, t3Cancel := context.WithTimeout(ctx, 2000*time.Millisecond)
	if reply, modelName, err := e.tryDirectAPIs(t3Ctx, sysPrompt, cleanMsg); err == nil && len(reply) > 0 {
		t3Cancel()
		e.setCache(cKey, reply, 5*time.Minute)
		return reply, lang, modelName, false
	}
	t3Cancel()

	// Tier 4: Catalog-Grounded Deterministic Demo Responder with conversational memory
	demoReply := DemoResponder(lang, cleanMsg, pctx.Products, pctx.Knowledge, history)
	e.setCache(cKey, demoReply, 10*time.Minute)
	return demoReply, lang, "deterministic-catalog", false
}

func (e *Engine) tryDirectAPIs(ctx context.Context, sysPrompt, userMsg string) (string, string, error) {
	// 1. OpenRouter
	if key := os.Getenv("OPENROUTER_API_KEY"); key != "" {
		reply, err := e.callOpenAICompatible(ctx, "https://openrouter.ai/api/v1/chat/completions", key, "google/gemini-2.5-flash", sysPrompt, userMsg)
		if err == nil && reply != "" {
			return reply, "openrouter:gemini-2.5-flash", nil
		}
	}

	// 2. Direct Gemini API
	if key := os.Getenv("GEMINI_API_KEY"); key != "" {
		url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=%s", key)
		payload := map[string]interface{}{
			"contents": []map[string]interface{}{
				{"role": "user", "parts": []map[string]string{{"text": sysPrompt + "\n\nUser: " + userMsg}}},
			},
		}
		data, _ := json.Marshal(payload)
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(data))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			resp, err := e.httpClient.Do(req)
			if err == nil {
				defer resp.Body.Close()
				body, _ := io.ReadAll(resp.Body)
				var gRes struct {
					Candidates []struct {
						Content struct {
							Parts []struct {
								Text string `json:"text"`
							} `json:"parts"`
						} `json:"content"`
					} `json:"candidates"`
				}
				if json.Unmarshal(body, &gRes) == nil && len(gRes.Candidates) > 0 && len(gRes.Candidates[0].Content.Parts) > 0 {
					return strings.TrimSpace(gRes.Candidates[0].Content.Parts[0].Text), "direct-gemini-api", nil
				}
			}
		}
	}

	// 3. OpenAI
	if key := os.Getenv("OPENAI_API_KEY"); key != "" {
		reply, err := e.callOpenAICompatible(ctx, "https://api.openai.com/v1/chat/completions", key, "gpt-4o-mini", sysPrompt, userMsg)
		if err == nil && reply != "" {
			return reply, "openai:gpt-4o-mini", nil
		}
	}

	return "", "", fmt.Errorf("no direct APIs available or succeeded")
}

func (e *Engine) callOpenAICompatible(ctx context.Context, endpoint, token, model, sysPrompt, userMsg string) (string, error) {
	payload := map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": sysPrompt},
			{"role": "user", "content": userMsg},
		},
		"temperature": 0.4,
		"max_tokens":  600,
	}
	data, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != 200 {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}

	var res struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &res); err == nil && len(res.Choices) > 0 {
		return strings.TrimSpace(res.Choices[0].Message.Content), nil
	}

	return "", fmt.Errorf("empty choice from OpenAI compatible endpoint")
}

// BuildSystemPrompt formats catalog, store policies, and ironclad language directives
func BuildSystemPrompt(ctx PromptContext, lang detector.Language) string {
	var sb strings.Builder

	storeName := ctx.ClientName
	if storeName == "" {
		storeName = "Our Store"
	}

	sb.WriteString(fmt.Sprintf("You are the official, intelligent, helpful, and courteous e-commerce sales assistant for \"%s\".\n\n", storeName))
	sb.WriteString(detector.LanguageDirective(lang))
	sb.WriteString("\n\n")

	sb.WriteString("=== OPERATIONAL RULES & POLICIES ===\n")
	sb.WriteString("1. ACCURACY: Only quote products, prices, and policies listed below. NEVER fabricate discounts or unlisted products.\n")
	sb.WriteString("2. POLITE & HELPFUL: Greet customers warmly and answer inquiries concisely with clear facts.\n")
	sb.WriteString("3. ORDER ASSISTANCE: When a customer expresses intent to buy, politely request their Full Name, Phone Number, and Full Delivery Address.\n\n")

	if len(ctx.Products) > 0 {
		sb.WriteString("=== CURRENT PRODUCT CATALOG & INVENTORY ===\n")
		for _, p := range ctx.Products {
			stockStr := "In Stock"
			if p.Stock <= 0 {
				stockStr = "Out of Stock"
			}
			sb.WriteString(fmt.Sprintf("- %s: %s BDT (%s)\n", p.Name, p.PriceBDT, stockStr))
		}
		sb.WriteString("\n")
	}

	if len(ctx.Knowledge) > 0 {
		sb.WriteString("=== STORE POLICIES & KNOWLEDGE BASE ===\n")
		for _, k := range ctx.Knowledge {
			sb.WriteString(fmt.Sprintf("[%s]: %s\n", k.Title, k.Content))
		}
		sb.WriteString("\n")
	} else {
		sb.WriteString("=== DEFAULT SHIPPING & DELIVERY POLICY ===\n")
		sb.WriteString("- Inside Dhaka: 60 BDT delivery charge (takes 24-48 hours).\n")
		sb.WriteString("- Outside Dhaka: 120 BDT delivery charge (takes 2-3 business days).\n")
		sb.WriteString("- Cash on Delivery (COD) is available nationwide.\n\n")
	}

	return sb.String()
}

// DemoResponder provides deterministic, ultra-fast responses grounded in catalog & language
func DemoResponder(lang detector.Language, text string, products []ProductItem, knowledge []KnowledgeItem, history []ChatMessage) string {
	t := strings.ToLower(text)

	// 1. Delivery / Shipping intent (checked first to avoid matching substrings in 'Dhaka' or 'charges')
	reDelivery := regexp.MustCompile(`(?i)(delivery|charge|shipping|courier|pathan|kobe|somoy|shomoy|ডেলিভারি|চার্জ|কুরিয়ার|পাঠান|সময়|কবে)`)
	if reDelivery.MatchString(t) {
		switch lang {
		case detector.LangBangla:
			return "আমাদের ডেলিভারি চার্জ ঢাকার ভেতরে ৬০ টাকা (২৪-৪৮ ঘণ্টা) এবং ঢাকার বাইরে ১২০ টাকা (২-৩ দিন)। ক্যাশ অন ডেলিভারি সুবিধা রয়েছে।"
		case detector.LangBanglish:
			return "Amader delivery charge Dhaka city-r bhitore 60 taka (24-48 hours) ebong Dhaka-r baire 120 taka (2-3 days). Cash on delivery available ache."
		default:
			return "Our delivery charge is 60 BDT inside Dhaka (24-48h) and 120 BDT outside Dhaka (2-3 days). Cash on Delivery is available."
		}
	}

	// 2. Order intent (with word boundaries and conversational memory across turns)
	reOrder := regexp.MustCompile(`(?i)(\b(order|buy|purchase|kinte|nibo|nebo|lagbe|nite|chai|chaichi|haa|ha|yes|confirm)\b|অর্ডার|কিনব|কিনতে|নিব|চাই|নিতে|চাচ্ছি|হাঁ|হ্যাঁ)`)
	if reOrder.MatchString(t) {
		var referencedProduct *ProductItem
		for i := len(history) - 1; i >= 0; i-- {
			hText := strings.ToLower(history[i].Content)
			for j := range products {
				pNameLower := strings.ToLower(products[j].Name)
				if strings.Contains(hText, pNameLower) {
					referencedProduct = &products[j]
					break
				}
			}
			if referencedProduct != nil {
				break
			}
		}

		prodNotice := ""
		if referencedProduct != nil {
			prodNotice = " (" + referencedProduct.Name + ")"
		}

		switch lang {
		case detector.LangBangla:
			return fmt.Sprintf("আপনার অর্ডারটি%s কনফার্ম করার জন্য অনুগ্রহ করে আপনার নাম, মোবাইল নম্বর এবং সম্পূর্ণ ডেলিভারি ঠিকানাটি এখানে লিখে দিন।", prodNotice)
		case detector.LangBanglish:
			return fmt.Sprintf("Apnar order%s confirm korte apnar naam, mobile number ar complete delivery address ta ekhane likhe din please.", prodNotice)
		default:
			return fmt.Sprintf("To confirm your order%s, please provide your Full Name, Mobile Number, and complete Delivery Address.", prodNotice)
		}
	}

	// 3. Knowledge Base & Policies inquiry (return, refund, exchange, warranty)
	rePolicy := regexp.MustCompile(`(?i)(return|refund|exchange|warranty|guarantee|ferot|change|policy|ফেরত|ওয়ারেন্টি|পলিসি)`)
	if rePolicy.MatchString(t) && len(knowledge) > 0 {
		for _, k := range knowledge {
			kTitleLower := strings.ToLower(k.Title)
			if strings.Contains(kTitleLower, "return") || strings.Contains(kTitleLower, "refund") ||
				strings.Contains(kTitleLower, "policy") || strings.Contains(kTitleLower, "warranty") ||
				strings.Contains(kTitleLower, "ফেরত") {
				switch lang {
				case detector.LangBangla:
					return fmt.Sprintf("আমাদের পলিসি: %s। বিস্তারিত জানতে আমাদের জানাতে পারেন।", k.Content)
				case detector.LangBanglish:
					return fmt.Sprintf("Amader policy: %s. Kono query thakle janate paren.", k.Content)
				default:
					return fmt.Sprintf("Our policy: %s.", k.Content)
				}
			}
		}
	}

	// 4. Price & Product inquiry with intelligent matching
	rePrice := regexp.MustCompile(`(?i)(dam|daam|price|cost|koto|rate|দাম|মূল্য|কত)`)
	if (rePrice.MatchString(t) || len(products) > 0) && len(products) > 0 {
		var matchedProduct *ProductItem
		for i := range products {
			pNameLower := strings.ToLower(products[i].Name)
			words := strings.Fields(pNameLower)
			for _, w := range words {
				if len(w) > 3 && strings.Contains(t, w) {
					matchedProduct = &products[i]
					break
				}
			}
			if matchedProduct != nil {
				break
			}
		}

		if matchedProduct != nil || rePrice.MatchString(t) {
			if matchedProduct == nil {
				matchedProduct = &products[0]
			}

			// Out of stock check
			if matchedProduct.Stock <= 0 {
				switch lang {
				case detector.LangBangla:
					return fmt.Sprintf("দুঃখিত, %s বর্তমানে স্টক আউট (Out of stock) আছে। নতুন স্টক এলে আমরা আপনাকে জানাতে পারব।", matchedProduct.Name)
				case detector.LangBanglish:
					return fmt.Sprintf("Dukkhito, %s ekhon stock out ache. Notun stock ashle apnake janate parbo.", matchedProduct.Name)
				default:
					return fmt.Sprintf("Sorry, %s is currently out of stock. We will notify you once new stock arrives.", matchedProduct.Name)
				}
			}

			switch lang {
			case detector.LangBangla:
				return fmt.Sprintf("%s-এর মূল্য %s টাকা। আপনি কি এটি অর্ডার করতে চান?", matchedProduct.Name, matchedProduct.PriceBDT)
			case detector.LangBanglish:
				return fmt.Sprintf("%s-er price %s BDT. Apni ki eta order korte chan?", matchedProduct.Name, matchedProduct.PriceBDT)
			default:
				return fmt.Sprintf("%s is %s BDT. Would you like to order it?", matchedProduct.Name, matchedProduct.PriceBDT)
			}
		}
	}

	// 5. Greetings & general inquiry
	switch lang {
	case detector.LangBangla:
		return "ধন্যবাদ আমাদের সাথে যোগাযোগ করার জন্য! আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
	case detector.LangBanglish:
		return "Message korar jonno dhonnobad! Apnake kivabe shahajjo korte pari?"
	default:
		return "Thank you for reaching out to us! How can we assist you today?"
	}
}
