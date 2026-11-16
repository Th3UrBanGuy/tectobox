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
	sb.WriteString("3. ORDER ASSISTANCE: When a customer expresses intent to buy, politely request their Full Name, Phone Number, and Full Delivery Address.\n")
	// RULE 4 (2026-11-16 audit): the LLM once told a customer their
	// order was confirmed when NO order row existed — the deterministic
	// order service creates orders, never the LLM. The LLM must never
	// claim an order is confirmed, placed, or created; only the
	// system's own confirmation reply does that.
	sb.WriteString("4. NEVER CONFIRM ORDERS: NEVER tell a customer their order is confirmed, placed, or created. Only the system confirms orders — after it actually creates one. If asked about an order's status, say you will check, or ask for the order number.\n")
	// PAYMENT METHODS (2026-11-16): quote ONLY what is configured
	// here. An unconfigured shop gets an explicit do-not-claim line
	// instead of the old hardcoded "COD is available nationwide".
	sb.WriteString("5. PAYMENT METHODS — use ONLY what is listed here:\n")
	if PaymentConfigured(ctx.Payment) {
		modes := ctx.Payment.Modes
		if modes == "" {
			modes = "cod"
		}
		sb.WriteString(fmt.Sprintf("- Payment modes: %s.\n", modes))
		if ctx.Payment.AdvanceBDT > 0 {
			sb.WriteString(fmt.Sprintf("- Advance required: %d BDT — the customer MUST pay this advance before delivery, even for Cash on Delivery orders. NEVER say no advance is needed when an amount is listed here.\n", ctx.Payment.AdvanceBDT))
		} else {
			sb.WriteString("- Advance required: none.\n")
		}
		for _, num := range []struct{ label, value string }{
			{"bKash number", ctx.Payment.Bkash},
			{"Nagad number", ctx.Payment.Nagad},
			{"Rocket number", ctx.Payment.Rocket},
		} {
			if num.value != "" {
				sb.WriteString(fmt.Sprintf("- %s: %s.\n", num.label, num.value))
			}
		}
	} else {
		sb.WriteString("- Payment methods are NOT configured for this shop. Do NOT claim any payment method (no bKash, Nagad, Rocket, or Cash on Delivery) — say the shop will share payment details.\n")
	}
	sb.WriteString("\n")

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
		// The COD line is gated on the shop's real payment config:
		// an unconfigured shop must not have COD claimed for it.
		if ctx.Payment.Modes == "cod" || ctx.Payment.Modes == "both" {
			sb.WriteString("- Cash on Delivery (COD) is available nationwide.\n\n")
		} else if PaymentConfigured(ctx.Payment) {
			sb.WriteString("- Cash on Delivery is NOT available for this shop.\n\n")
		} else {
			sb.WriteString("- Payment methods are not configured for this shop yet.\n\n")
		}
	}

	return sb.String()
}
