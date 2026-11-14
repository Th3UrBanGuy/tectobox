package router

import (
	"fmt"
	"strings"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/detector"
)

// BuildSystemPrompt formats catalog, store policies, and ironclad language directives.
// Split from engine.go in Phase 4 of the modular restructure; code moved
// verbatim (including the hardcoded 60/120 BDT default delivery policy,
// which is a business default the caller should eventually supply —
// it is duplicated in the Node demoResponder and in responder.go).
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
