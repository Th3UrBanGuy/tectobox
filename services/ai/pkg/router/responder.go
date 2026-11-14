package router

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/detector"
)

// DemoResponder provides deterministic, ultra-fast responses grounded in catalog & language.
// Split from engine.go in Phase 4 of the modular restructure; code moved
// verbatim. This is a second, independent product (a rule-based chatbot)
// from the LLM tiers: it is the part most likely to need product-by-product
// changes, so it lives on its own. The 60/120 BDT default delivery charge
// below is the same business default as in prompt.go and in the Node
// demoResponder — it should eventually come from the caller, not be baked
// into the responder.
func DemoResponder(lang detector.Language, text string, products []ProductItem, knowledge []KnowledgeItem, history []ChatMessage) string {
	// Helper for Unicode-aware word boundary matching
	matchWord := func(s, word string) bool {
		if word == "" {
			return false
		}
		pattern := `(?i)(?:^|[^\p{L}\p{M}\p{N}_])` + regexp.QuoteMeta(word) + `(?:[^\p{L}\p{M}\p{N}_]|$)`
		re, err := regexp.Compile(pattern)
		if err != nil {
			return false
		}
		return re.MatchString(s)
	}

	// 1. Delivery / Shipping intent (checked first; using word boundaries so words like 'চার্জার' or 'charger' don't match)
	reDelivery := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(delivery|charge|shipping|courier|pathan|kobe|somoy|shomoy|ডেলিভারি|চার্জ|কুরিয়ার|কুরিয়ার|পাঠান|সময়|কবে)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reDelivery.MatchString(text) {
		// Check knowledge FIRST for delivery / charge / shipping entries
		if len(knowledge) > 0 {
			for _, k := range knowledge {
				combined := strings.ToLower(k.Title + " " + k.Content + " " + k.Category)
				if strings.Contains(combined, "delivery") || strings.Contains(combined, "charge") ||
					strings.Contains(combined, "shipping") || strings.Contains(combined, "courier") ||
					strings.Contains(combined, "ডেলিভারি") || strings.Contains(combined, "চার্জ") ||
					strings.Contains(combined, "কুরিয়ার") || strings.Contains(combined, "কুরিয়ার") {
					switch lang {
					case detector.LangBangla:
						return fmt.Sprintf("আমাদের ডেলিভারি তথ্য: %s", k.Content)
					case detector.LangBanglish:
						return fmt.Sprintf("Amader delivery info: %s", k.Content)
					default:
						return fmt.Sprintf("Our delivery policy: %s", k.Content)
					}
				}
			}
		}

		// Fallback to generic template only when no knowledge entry matches
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
	reOrder := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(order|buy|purchase|kinte|nibo|nebo|lagbe|nite|chai|chaichi|haa|ha|yes|confirm|অর্ডার|কিনব|কিনতে|নিব|চাই|নিতে|চাচ্ছি|হাঁ|হ্যাঁ)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reOrder.MatchString(text) {
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
	rePolicy := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(return|refund|exchange|warranty|guarantee|ferot|change|policy|ফেরত|ওয়ারেন্টি|ওয়ারেন্টি|পলিসি)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if rePolicy.MatchString(text) && len(knowledge) > 0 {
		for _, k := range knowledge {
			combined := strings.ToLower(k.Title + " " + k.Content + " " + k.Category)
			if strings.Contains(combined, "return") || strings.Contains(combined, "refund") ||
				strings.Contains(combined, "policy") || strings.Contains(combined, "warranty") ||
				strings.Contains(combined, "ফেরত") || strings.Contains(combined, "পলিসি") {
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
	rePrice := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(dam|daam|price|cost|koto|rate|দাম|মূল্য|কত)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if (rePrice.MatchString(text) || len(products) > 0) && len(products) > 0 {
		var matchedProduct *ProductItem
		for i := range products {
			pNameLower := strings.ToLower(products[i].Name)
			if matchWord(text, pNameLower) {
				matchedProduct = &products[i]
				break
			}
			words := strings.Fields(pNameLower)
			for _, w := range words {
				if len(w) > 3 && (matchWord(text, w) || (w == "charger" && matchWord(text, "চার্জার")) || (w == "চার্জার" && matchWord(text, "charger"))) {
					matchedProduct = &products[i]
					break
				}
			}
			if matchedProduct != nil {
				break
			}
		}

		if matchedProduct != nil || rePrice.MatchString(text) {
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
				return fmt.Sprintf("%s-এর মূল্য %v টাকা। আপনি কি এটি অর্ডার করতে চান?", matchedProduct.Name, matchedProduct.PriceBDT)
			case detector.LangBanglish:
				return fmt.Sprintf("%s-er price %v BDT. Apni ki eta order korte chan?", matchedProduct.Name, matchedProduct.PriceBDT)
			default:
				return fmt.Sprintf("%s is %v BDT. Would you like to order it?", matchedProduct.Name, matchedProduct.PriceBDT)
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
