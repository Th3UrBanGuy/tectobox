package router

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
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
//
// Fixed 2026-11-15 (Segment A) — same logic as packages/ai-router/src/
// demo-responder.ts, keep the two in sync: no products[0] fallback (the
// "chocklate 700" hallucination); TEST- prefixes stripped, hyphens split,
// 3-letter words ("mug", "tea", "spf") match; stock, category, cheapest,
// compare, payment, shop-hours and advance-payment intents answered from
// the catalog/knowledge in Bengali, Banglish, English and Hindi; the
// policy branch scores entries by policy type; the order branch uses
// details already given in the message (W12) and refuses out-of-stock items.

// CustomerDetails is what ExtractCustomerDetails pulls out of one customer
// message: name / phone / address / quantity (W12).
type CustomerDetails struct {
	Name     string
	Phone    string
	Address  string
	Quantity int
	HasQty   bool
}

// genericProductWords are too generic to identify a product on their own.
var genericProductWords = map[string]struct{}{
	"pro": {}, "plus": {}, "max": {}, "mini": {}, "lite": {}, "new": {}, "premium": {},
	"standard": {}, "classic": {}, "basic": {}, "deluxe": {}, "set": {}, "pc": {},
	"2pc": {}, "1l": {}, "100ml": {}, "200g": {}, "x2": {}, "fit": {},
	"the": {}, "a": {}, "an": {},
}

// transliterations maps Bengali/Hindi transliterations of common product
// words to English, so "ওয়্যারলেস ইয়ারবাডসের দাম কত?" matches the
// English catalog. Longest keys are tried first.
var transliterations = [][2]string{
	{"ইয়ারবাডস", "earbuds"}, {"ইয়ারবাড", "earbuds"}, {"ওয়্যারলেস", "wireless"},
	{"টি-শার্ট", "t-shirt"}, {"টিশার্ট", "t-shirt"}, {"শার্ট", "shirt"},
	{"স্মার্ট", "smart"}, {"ওয়াচ", "watch"}, {"ঘড়ি", "watch"},
	{"বোতল", "bottle"}, {"পানি", "water"}, {"স্টিল", "steel"},
	{"গ্রিন", "green"}, {"টি", "tea"}, {"চা", "tea"}, {"ওয়ালেট", "wallet"},
	{"চামড়া", "leather"}, {"স্পিকার", "speaker"}, {"ব্লুটুথ", "bluetooth"},
	{"জুতা", "shoes"}, {"জুতো", "shoes"}, {"মগ", "mug"}, {"কফি", "coffee"},
	{"সানস্ক্রিন", "sunscreen"}, {"চার্জার", "charger"}, {"ল্যাপটপ", "laptop"},
	{"কাপড়", "clothing"}, {"ইলেকট্রনিক্স", "electronics"}, {"পোশাক", "clothing"},
	{"ईयरबड्स", "earbuds"}, {"इयरबड्स", "earbuds"}, {"वायरलेस", "wireless"},
	{"टी-शर्ट", "t-shirt"}, {"टीशर्ट", "t-shirt"}, {"शर्ट", "shirt"},
	{"स्मार्ट", "smart"}, {"वॉच", "watch"}, {"घड़ी", "watch"},
	{"बोतल", "bottle"}, {"पानी", "water"}, {"स्टील", "steel"},
	{"ग्रीन", "green"}, {"चाय", "tea"}, {"वॉलेट", "wallet"},
	{"चमड़ा", "leather"}, {"स्पीकर", "speaker"}, {"ब्लूटूथ", "bluetooth"},
	{"जूते", "shoes"}, {"जूता", "shoes"}, {"मग", "mug"}, {"कॉफ़ी", "coffee"},
	{"कॉफी", "coffee"}, {"सनस्क्रीन", "sunscreen"}, {"चार्जर", "charger"},
	{"लैपटॉप", "laptop"}, {"कपड़े", "clothing"}, {"इलेक्ट्रॉनिक्स", "electronics"},
}

// categoryKeywords maps a category label to product-name keywords in it.
var categoryKeywords = map[string][]string{
	"electronics": {"earbuds", "earphone", "headphone", "speaker", "watch", "smart", "charger", "phone", "laptop", "tablet", "cable", "bluetooth", "camera", "keyboard", "mouse"},
	"clothing":    {"shirt", "t-shirt", "tshirt", "pant", "pants", "dress", "jacket", "hoodie", "kurta", "saree", "punjabi"},
	"footwear":    {"shoe", "shoes", "sneaker", "sandal", "boot"},
	"food":        {"tea", "coffee", "honey", "spice", "snack", "organic", "food", "grocery"},
	"accessories": {"wallet", "bottle", "mug", "sunscreen", "bag", "belt", "sunglasses", "cap"},
}

type categoryLabel struct {
	re    *regexp.Regexp
	label string
}

var categoryLabels = []categoryLabel{
	{regexp.MustCompile(`(?i)electronics?|ইলেকট্রনিক্স|इलेक्ट्रॉनिक्स`), "electronics"},
	{regexp.MustCompile(`(?i)clothing|clothes|apparel|পোশাক|কাপড়|कपड़े`), "clothing"},
	{regexp.MustCompile(`(?i)footwear|জুতা|जूते`), "footwear"},
	{regexp.MustCompile(`(?i)\bfood\b|grocery|খাবার`), "food"},
	{regexp.MustCompile(`(?i)accessories`), "accessories"},
}

// romanHindiWords / banglishMarkerWords score Roman Hindi (Hinglish)
// against Banglish for the responder-side language guard below. The
// detector package scores Devanagari but not Roman Hindi, so a Roman
// Hindi question would otherwise arrive here as Banglish (L4).
var romanHindiWords = map[string]struct{}{
	"ki": {}, "kya": {}, "hai": {}, "hain": {}, "kaise": {}, "kaisa": {}, "kaisi": {},
	"kitna": {}, "kitne": {}, "kitni": {}, "keemat": {}, "kimat": {}, "daam": {},
	"karna": {}, "karo": {}, "karein": {}, "karen": {}, "mujhe": {}, "mera": {},
	"meri": {}, "mere": {}, "aap": {}, "aapka": {}, "aapki": {}, "aapko": {},
	"tum": {}, "tumhara": {}, "tumhari": {}, "chahiye": {}, "chahie": {},
	"sakte": {}, "sakta": {}, "sakti": {}, "kab": {}, "kahan": {}, "kaha": {},
	"kaun": {}, "kyun": {}, "kyu": {}, "batao": {}, "bataiye": {}, "dijiye": {},
	"lena": {}, "lene": {}, "khareedna": {}, "kharidna": {}, "dukaan": {},
	"dukan": {}, "khula": {}, "khulta": {}, "khulna": {}, "band": {},
	"subah": {}, "shaam": {}, "raat": {}, "aaj": {}, "abhi": {}, "yeh": {},
	"ye": {}, "woh": {}, "iska": {}, "uska": {}, "iski": {}, "uski": {},
	"ka": {}, "ke": {}, "ko": {}, "ne": {}, "bhi": {}, "nahin": {}, "nahi": {},
	"bahut": {}, "acha": {}, "achha": {}, "theek": {}, "samay": {},
	"paisa": {}, "rupay": {}, "rupaye": {}, "bhugtan": {},
}

var banglishMarkerWords = map[string]struct{}{
	"koto": {}, "dam": {}, "daam": {}, "kivabe": {}, "chai": {}, "lagbe": {},
	"dokan": {}, "ache": {}, "korbo": {}, "kinte": {}, "nibo": {}, "apni": {},
	"apnar": {}, "kothay": {}, "kokhon": {}, "thake": {}, "ektu": {},
	"ekta": {}, "kobe": {}, "somoy": {}, "shomoy": {}, "er": {},
}

func sortedTransliterations() [][2]string {
	out := make([][2]string, len(transliterations))
	copy(out, transliterations)
	sort.Slice(out, func(i, j int) bool {
		return len([]rune(out[i][0])) > len([]rune(out[j][0]))
	})
	return out
}

var transliterationsSorted = sortedTransliterations()

var bengaliDigitReplacer = strings.NewReplacer(
	"০", "0", "১", "1", "২", "2", "৩", "3", "৪", "4",
	"৫", "5", "৬", "6", "৭", "7", "৮", "8", "৯", "9",
)

func toASCIIDigits(s string) string { return bengaliDigitReplacer.Replace(s) }

func hasDevanagari(s string) bool {
	for _, r := range s {
		if r >= 0x0900 && r <= 0x097F {
			return true
		}
	}
	return false
}

func stripTestPrefix(name string) string {
	lower := strings.ToLower(name)
	if strings.HasPrefix(lower, "test-") {
		return name[5:]
	}
	if strings.HasPrefix(lower, "test ") {
		return name[5:]
	}
	return name
}

func productWords(p ProductItem) []string {
	return strings.FieldsFunc(strings.ToLower(stripTestPrefix(p.Name)), func(r rune) bool {
		return r == ' ' || r == '-' || r == '/'
	})
}

func priceOf(p ProductItem) float64 {
	switch v := p.PriceBDT.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f
	default:
		f, _ := strconv.ParseFloat(fmt.Sprintf("%v", p.PriceBDT), 64)
		return f
	}
}

func transliterateForMatch(text string) string {
	tokens := strings.Fields(strings.ToLower(text))
	for i, tok := range tokens {
		mapped := false
		for _, kv := range transliterationsSorted {
			if strings.HasPrefix(tok, kv[0]) {
				tokens[i] = kv[1]
				mapped = true
				break
			}
		}
		if mapped {
			continue
		}
		parts := strings.Split(tok, "-")
		for j, part := range parts {
			for _, kv := range transliterationsSorted {
				if part == kv[0] {
					parts[j] = kv[1]
					break
				}
			}
		}
		tokens[i] = strings.Join(parts, "-")
	}
	return strings.Join(tokens, " ")
}

// isRomanHindi mirrors detectCustomerLanguage in packages/ai-router/src/
// language.ts: Roman Hindi wins on 2+ distinctive Hindi words, or on a
// single one with no Banglish marker present.
func isRomanHindi(text string) bool {
	if hasDevanagari(text) {
		return false
	}
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !(r >= 'a' && r <= 'z')
	})
	hi, bn := 0, 0
	for _, w := range words {
		if _, ok := romanHindiWords[w]; ok {
			hi++
		}
		if _, ok := banglishMarkerWords[w]; ok {
			bn++
		}
	}
	return hi >= 2 || (hi >= 1 && bn == 0)
}

// ExtractCustomerDetails pulls name / phone / address / quantity out of
// one customer message (W12). Phone is matched first and removed before
// quantity is read, so a phone number is never mistaken for a quantity.
// Quantity is only read from this message, never from history.
func ExtractCustomerDetails(rawText string) CustomerDetails {
	var out CustomerDetails
	text := rawText
	ascii := toASCIIDigits(text)

	phoneRe := regexp.MustCompile(`(?:\+?880[\s\-]?1[3-9]\d{2}[\s\-]?\d{6}|01[3-9]\d{8}|1[3-9]\d{8})`)
	if m := phoneRe.FindString(ascii); m != "" {
		out.Phone = regexp.MustCompile(`[\s\-+]`).ReplaceAllString(m, "")
	}

	nameRes := []*regexp.Regexp{
		regexp.MustCompile(`(?i)my name is\s+([A-Za-z][A-Za-z.'\- ]{1,40})`),
		regexp.MustCompile(`(?i)amar naam(?:e)?\s+([A-Za-z][A-Za-z.'\- ]{1,40})`),
		regexp.MustCompile(`আমার নাম\s+([^\s,।]+(?:\s+[^\s,।]+){0,2})`),
		regexp.MustCompile(`(?i)naam\s+(?:hai|hain|mera|meri)?\s*([A-Za-z][A-Za-z.'\- ]{1,40})`),
		regexp.MustCompile(`(?i)\bi am\s+([A-Za-z][A-Za-z.'\- ]{1,40})`),
	}
	for _, re := range nameRes {
		if m := re.FindStringSubmatch(text); m != nil {
			name := strings.TrimSpace(m[1])
			for _, cut := range []string{",", ".", " phone", " my ", " and "} {
				if idx := strings.Index(strings.ToLower(name), cut); idx >= 0 {
					name = strings.TrimSpace(name[:idx])
				}
			}
			parts := strings.Fields(name)
			if len(parts) > 3 {
				parts = parts[:3]
			}
			name = strings.Join(parts, " ")
			if len(name) >= 2 {
				out.Name = name
				break
			}
		}
	}

	addrRe := regexp.MustCompile(`(?i)(?:deliver to|address(?: is|:)?|ঠিকানা|thikana)\s*:?\s*([^.,;\n।]{3,120})`)
	if m := addrRe.FindStringSubmatch(text); m != nil {
		out.Address = strings.TrimSpace(m[1])
	}

	withoutPhone := ascii
	if out.Phone != "" {
		withoutPhone = strings.Replace(ascii, phoneRe.FindString(ascii), " ", 1)
	}
	qtyRes := []*regexp.Regexp{
		regexp.MustCompile(`(?i)(?:quantity|qty)\s*:?\s*(\d{1,2})\b`),
		regexp.MustCompile(`(?i)\b(\d{1,2})\s*(?:ta|ti|pcs?|pieces?)\b`),
		regexp.MustCompile(`(?i)\bx\s*(\d{1,2})\b`),
		regexp.MustCompile(`(?i)\b(\d{1,2})\s+(?:ta|ti)\b`),
	}
	found := false
	for _, re := range qtyRes {
		if m := re.FindStringSubmatch(withoutPhone); m != nil {
			if q, err := strconv.Atoi(m[1]); err == nil && q >= 1 && q <= 99 {
				out.Quantity, out.HasQty = q, true
				found = true
			}
			break
		}
	}
	if !found {
		// "buy 2 earbuds": a bare number right before a product word.
		if m := regexp.MustCompile(`\b(\d{1,2})\s+[A-Za-z]{3,}`).FindStringSubmatch(withoutPhone); m != nil {
			if q, err := strconv.Atoi(m[1]); err == nil && q >= 1 && q <= 99 {
				out.Quantity, out.HasQty = q, true
			}
		}
	}

	return out
}

func DemoResponder(lang detector.Language, text string, products []ProductItem, knowledge []KnowledgeItem, history []ChatMessage) string {
	// Responder-side Roman-Hindi guard (see isRomanHindi): the detector
	// scores Devanagari but not Roman Hindi, so a Hinglish question
	// would otherwise be answered in Banglish (L4).
	if (lang == detector.LangBanglish || lang == detector.LangEnglish) && isRomanHindi(text) {
		lang = detector.LangHindi
	}

	// Pick the reply variant for the customer's language. Hindi uses
	// Devanagari when the customer wrote Devanagari, Roman Hindi when
	// they wrote Roman Hindi.
	pick := func(bn, banglish, en, hiDev, hiRoman string) string {
		switch lang {
		case detector.LangBangla:
			return bn
		case detector.LangBanglish:
			return banglish
		case detector.LangHindi:
			if hasDevanagari(text) {
				return hiDev
			}
			return hiRoman
		default:
			return en
		}
	}

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

	// Score one product against the message. Full-name phrase = 10;
	// each distinctive name word found = 2; a numeric token = 1.
	// Generic words ("pro", "mini", ...) never score on their own, so
	// "iPhone 15 Pro" does not match "Wireless Earbuds Pro".
	scoreProduct := func(p ProductItem, matchText, rawText string) int {
		normName := strings.ToLower(stripTestPrefix(p.Name))
		if matchWord(matchText, normName) {
			return 10
		}
		score := 0
		for _, w := range productWords(p) {
			if _, generic := genericProductWords[w]; generic {
				continue
			}
			if len(w) < 3 {
				continue
			}
			if matchWord(matchText, w) || matchWord(rawText, w) {
				if isDigits(w) {
					score += 1
				} else {
					score += 2
				}
				continue
			}
			// Prefix/substring match for short keywords ("earbud" ~ "earbuds").
			if len(w) >= 4 {
				tokens := regexp.MustCompile(`[^a-z0-9]+`).Split(matchText, -1)
				for _, tok := range tokens {
					if len(tok) >= 4 && (strings.HasPrefix(tok, w) || strings.HasPrefix(w, tok)) {
						score += 2
						break
					}
				}
			}
			if w == "charger" && matchWord(rawText, "চার্জার") {
				score += 2
			}
			if w == "চার্জার" && matchWord(rawText, "charger") {
				score += 2
			}
		}
		return score
	}

	matchProducts := func(sourceText string) []ProductItem {
		matchText := transliterateForMatch(sourceText)
		type scored struct {
			p     ProductItem
			score int
			idx   int
		}
		var list []scored
		for i, p := range products {
			if s := scoreProduct(p, matchText, sourceText); s >= 2 {
				list = append(list, scored{p, s, i})
			}
		}
		sort.SliceStable(list, func(i, j int) bool { return list[i].score > list[j].score })
		out := make([]ProductItem, 0, len(list))
		for _, s := range list {
			out = append(out, s.p)
		}
		return out
	}

	matchProduct := func(sourceText string) *ProductItem {
		m := matchProducts(sourceText)
		if len(m) == 0 {
			return nil
		}
		return &m[0]
	}

	// Closest alternative for a "we don't carry that" reply: any
	// product sharing even a generic token with the question ("Pro",
	// "100ml"). Only used when no product scored a real match.
	closestAlternative := func(sourceText string) *ProductItem {
		tokens := regexp.MustCompile(`[^a-z0-9]+`).Split(transliterateForMatch(sourceText), -1)
		var best *ProductItem
		bestCount := 0
		for i := range products {
			normName := strings.ToLower(stripTestPrefix(products[i].Name))
			count := 0
			for _, tok := range tokens {
				if len(tok) >= 3 && strings.Contains(normName, tok) {
					count++
				}
			}
			if count > bestCount {
				bestCount = count
				best = &products[i]
			}
		}
		if bestCount > 0 {
			return best
		}
		return nil
	}

	// Best knowledge entry by keyword score: title hit = 3, content hit = 1.
	findKnowledge := func(keywords []string) *KnowledgeItem {
		var best *KnowledgeItem
		bestScore := 0
		for i := range knowledge {
			k := &knowledge[i]
			title := strings.ToLower(k.Title)
			body := strings.ToLower(k.Content + " " + k.Category)
			score := 0
			for _, kw := range keywords {
				if strings.Contains(title, kw) {
					score += 3
				} else if strings.Contains(body, kw) {
					score += 1
				}
			}
			if score > bestScore {
				bestScore = score
				best = k
			}
		}
		if bestScore > 0 {
			return best
		}
		return nil
	}

	outOfStockReply := func(p *ProductItem) string {
		var alt *ProductItem
		for i := range products {
			if products[i].Name != p.Name && products[i].Stock > 0 {
				alt = &products[i]
				break
			}
		}
		altText := ""
		if alt != nil {
			altText = pick(
				fmt.Sprintf(" এর বদলে %s (%v টাকা) নিতে পারেন — এটি স্টকে আছে।", alt.Name, alt.PriceBDT),
				fmt.Sprintf(" Er bodle %s (%v BDT) nite paren — eta stock e ache.", alt.Name, alt.PriceBDT),
				fmt.Sprintf(" You could take %s (%v BDT) instead — it is in stock.", alt.Name, alt.PriceBDT),
				fmt.Sprintf(" आप इसके बजाय %s (%v BDT) ले सकते हैं — यह स्टॉक में है।", alt.Name, alt.PriceBDT),
				fmt.Sprintf(" Aap iske bajay %s (%v BDT) le sakte hain — ye stock mein hai.", alt.Name, alt.PriceBDT),
			)
		}
		return pick(
			fmt.Sprintf("দুঃখিত, %s বর্তমানে স্টক আউট আছে।%s", p.Name, altText),
			fmt.Sprintf("Dukkhito, %s ekhon stock out ache.%s", p.Name, altText),
			fmt.Sprintf("Sorry, %s is currently out of stock.%s", p.Name, altText),
			fmt.Sprintf("माफ़ कीजिए, %s अभी स्टॉक में नहीं है।%s", p.Name, altText),
			fmt.Sprintf("Maaf kijiye, %s abhi stock mein nahi hai.%s", p.Name, altText),
		)
	}

	notFoundReply := func() string {
		alt := closestAlternative(text)
		altText := ""
		if alt != nil {
			altText = pick(
				fmt.Sprintf(" কাছাকাছি আমাদের কাছে %s আছে (%v টাকা)।", alt.Name, alt.PriceBDT),
				fmt.Sprintf(" Kachakachi amader kache %s ache (%v BDT).", alt.Name, alt.PriceBDT),
				fmt.Sprintf(" The closest we have is %s (%v BDT).", alt.Name, alt.PriceBDT),
				fmt.Sprintf(" हमारे पास इससे मिलता-जुलता %s है (%v BDT)।", alt.Name, alt.PriceBDT),
				fmt.Sprintf(" Hamare paas isse milta-julta %s hai (%v BDT).", alt.Name, alt.PriceBDT),
			)
		}
		return pick(
			fmt.Sprintf("দুঃখিত, এই প্রোডাক্টটি আমাদের কাছে নেই।%s", altText),
			fmt.Sprintf("Dukkhito, ei product-ta amader kache nei.%s", altText),
			fmt.Sprintf("Sorry, we do not carry that item.%s", altText),
			fmt.Sprintf("माफ़ कीजिए, यह प्रोडक्ट हमारे पास नहीं है।%s", altText),
			fmt.Sprintf("Maaf kijiye, ye product hamare paas nahi hai.%s", altText),
		)
	}

	priceReply := func(p *ProductItem) string {
		if p.Stock <= 0 {
			return outOfStockReply(p)
		}
		return pick(
			fmt.Sprintf("%s-এর মূল্য %v টাকা। আপনি কি এটি অর্ডার করতে চান?", p.Name, p.PriceBDT),
			fmt.Sprintf("%s-er price %v BDT. Apni ki eta order korte chan?", p.Name, p.PriceBDT),
			fmt.Sprintf("%s is %v BDT. Would you like to order it?", p.Name, p.PriceBDT),
			fmt.Sprintf("%s की कीमत %v BDT है। क्या आप इसे ऑर्डर करना चाहेंगे?", p.Name, p.PriceBDT),
			fmt.Sprintf("%s ki keemat %v BDT hai. Kya aap ise order karna chahenge?", p.Name, p.PriceBDT),
		)
	}

	// 0. Advance-payment question — NEVER an order prompt (W13).
	reAdvance := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(advance|অগ্রিম|agrim|एडवांस|अग्रिम)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reAdvance.MatchString(text) {
		if entry := findKnowledge([]string{"advance", "অগ্রিম", "एडवांस", "अग्रिम"}); entry != nil {
			return pick(
				fmt.Sprintf("অগ্রিম পেমেন্ট সম্পর্কে: %s", entry.Content),
				fmt.Sprintf("Advance payment somporke: %s", entry.Content),
				fmt.Sprintf("About advance payment: %s", entry.Content),
				fmt.Sprintf("अग्रिम भुगतान के बारे में: %s", entry.Content),
				fmt.Sprintf("Advance payment ke baare mein: %s", entry.Content),
			)
		}
		// No advance rule in knowledge: answer with the payment info
		// (knowledge if present, else the payment fallback) — never invent
		// an advance rule and never start the order flow.
		payContent := "We accept bKash, Nagad, Rocket, and Cash on Delivery."
		if payEntry := findKnowledge([]string{"bkash", "nagad", "payment", "পেমেন্ট", "cash on delivery", "cod", "rocket", "বিকাশ", "নগদ", "भुगतान"}); payEntry != nil {
			payContent = payEntry.Content
		}
		return pick(
			fmt.Sprintf("অগ্রিম পেমেন্ট সম্পর্কে: %s", payContent),
			fmt.Sprintf("Advance payment somporke: %s", payContent),
			fmt.Sprintf("About advance payment: %s", payContent),
			fmt.Sprintf("अग्रिम भुगतान के बारे में: %s", payContent),
			fmt.Sprintf("Advance payment ke baare mein: %s", payContent),
		)
	}

	// 1. Payment methods — before delivery, so "Can I pay cash on
	// delivery?" gets the payment answer, not the delivery template (W9/L5).
	rePayment := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(payment|pay|paid|bkash|nagad|rocket|cash on delivery|cod|upi|পেমেন্ট|পে|ক্যাশ অন ডেলিভারি|বিকাশ|নগদ|রকেট|भुगतान)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if rePayment.MatchString(text) {
		if entry := findKnowledge([]string{"bkash", "nagad", "payment", "পেমেন্ট", "cash on delivery", "cod", "rocket", "বিকাশ", "নগদ", "भुगतान", "upi"}); entry != nil {
			return pick(
				fmt.Sprintf("আমাদের পেমেন্ট তথ্য: %s", entry.Content),
				fmt.Sprintf("Amader payment info: %s", entry.Content),
				fmt.Sprintf("Our payment options: %s", entry.Content),
				fmt.Sprintf("हमारे भुगतान विकल्प: %s", entry.Content),
				fmt.Sprintf("Hamare payment options: %s", entry.Content),
			)
		}
		return pick(
			"আমরা bKash, Nagad, Rocket এবং ক্যাশ অন ডেলিভারি গ্রহণ করি।",
			"Amra bKash, Nagad, Rocket ebong Cash on Delivery accept kori.",
			"We accept bKash, Nagad, Rocket, and Cash on Delivery.",
			"हम bKash, Nagad, Rocket और Cash on Delivery स्वीकार करते हैं।",
			"Hum bKash, Nagad, Rocket aur Cash on Delivery accept karte hain.",
		)
	}

	// 2. Shop opening hours (W9/L2/L3/L5) — knowledge first, fallback
	// is the seeded 9am–9pm Sat–Thu hours.
	reHours := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(open|opening|opening hours|shop hours|store hours|shop open|khola|khula|খোলা|খুলা|खुला|खुलता|kokhon khola|dokan kokhon)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reHours.MatchString(text) {
		if entry := findKnowledge([]string{"open", "hours", "hour", "খোলা", "khola", "khula", "खुला", "9am", "9 am", "timing", "shop hours", "opening"}); entry != nil {
			return pick(
				fmt.Sprintf("আমাদের দোকানের সময়: %s", entry.Content),
				fmt.Sprintf("Amader dokaner somoy: %s", entry.Content),
				fmt.Sprintf("Our shop hours: %s", entry.Content),
				fmt.Sprintf("हमारी दुकान का समय: %s", entry.Content),
				fmt.Sprintf("Hamari dukaan ka samay: %s", entry.Content),
			)
		}
		return pick(
			"আমাদের দোকান শনিবার থেকে বৃহস্পতিবার, সকাল 9টা থেকে রাত 9টা পর্যন্ত খোলা থাকে।",
			"Amader dokan Shonibar theke Brihoshpotibar, shokal 9ta theke raat 9ta porjonto khola thake.",
			"Our shop is open Saturday to Thursday, 9am to 9pm.",
			"हमारी दुकान शनिवार से गुरुवार, सुबह 9 बजे से रात 9 बजे तक खुली रहती है।",
			"Hamari dukaan Shanivar se Guruvar, subah 9 baje se raat 9 baje tak khuli rehti hai.",
		)
	}

	// 3. Delivery / Shipping intent (checked first; using word boundaries so words like 'চার্জার' or 'charger' don't match)
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
					return pick(
						fmt.Sprintf("আমাদের ডেলিভারি তথ্য: %s", k.Content),
						fmt.Sprintf("Amader delivery info: %s", k.Content),
						fmt.Sprintf("Our delivery policy: %s", k.Content),
						fmt.Sprintf("हमारी डिलीवरी जानकारी: %s", k.Content),
						fmt.Sprintf("Hamari delivery jaankari: %s", k.Content),
					)
				}
			}
		}

		// Fallback to generic template only when no knowledge entry matches
		return pick(
			"আমাদের ডেলিভারি চার্জ ঢাকার ভেতরে ৬০ টাকা (২৪-৪৮ ঘণ্টা) এবং ঢাকার বাইরে ১২০ টাকা (২-৩ দিন)। ক্যাশ অন ডেলিভারি সুবিধা রয়েছে।",
			"Amader delivery charge Dhaka city-r bhitore 60 taka (24-48 hours) ebong Dhaka-r baire 120 taka (2-3 days). Cash on delivery available ache.",
			"Our delivery charge is 60 BDT inside Dhaka (24-48h) and 120 BDT outside Dhaka (2-3 days). Cash on Delivery is available.",
			"हमारा डिलीवरी चार्ज ढाका के अंदर 60 BDT (24-48 घंटे) और ढाका के बाहर 120 BDT (2-3 दिन) है। Cash on Delivery उपलब्ध है।",
			"Hamara delivery charge Dhaka ke andar 60 BDT (24-48 hours) aur Dhaka ke baahar 120 BDT (2-3 days) hai. Cash on Delivery available hai.",
		)
	}

	// 4. Stock questions (W6/L2/L7) — answer from the stock field, with
	// the price included so "টি-শার্ট কি স্টকে আছে?" gets its 599.
	reStock := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(stock|in stock|out of stock|available|availability|স্টক|স্টকে|स्टॉक|uplabdh|stock ache|stock e)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reStock.MatchString(text) {
		if matched := matchProduct(text); matched != nil {
			if matched.Stock <= 0 {
				return outOfStockReply(matched)
			}
			return pick(
				fmt.Sprintf("হ্যাঁ, %s স্টকে আছে — %dটি আছে। মূল্য %v টাকা।", matched.Name, matched.Stock, matched.PriceBDT),
				fmt.Sprintf("Hyaan, %s stock e ache — %dta available ache. Price %v BDT.", matched.Name, matched.Stock, matched.PriceBDT),
				fmt.Sprintf("Yes, %s is in stock — %d available. Price: %v BDT.", matched.Name, matched.Stock, matched.PriceBDT),
				fmt.Sprintf("हाँ, %s स्टॉक में है — %d उपलब्ध है। कीमत: %v BDT।", matched.Name, matched.Stock, matched.PriceBDT),
				fmt.Sprintf("Haan, %s stock mein hai — %d available hai. Keemat: %v BDT.", matched.Name, matched.Stock, matched.PriceBDT),
			)
		}
		var inStock []ProductItem
		for _, p := range products {
			if p.Stock > 0 {
				inStock = append(inStock, p)
			}
		}
		if len(inStock) > 0 && len(products) > 0 {
			var parts []string
			for _, p := range inStock {
				parts = append(parts, fmt.Sprintf("%s (%v BDT)", p.Name, p.PriceBDT))
			}
			list := strings.Join(parts, ", ")
			return pick(
				fmt.Sprintf("স্টকে থাকা প্রোডাক্টগুলো: %s। কোনটি সম্পর্কে জানতে চান?", list),
				fmt.Sprintf("Stock e thaka product-gulo: %s. Konti somporke jante chan?", list),
				fmt.Sprintf("These are in stock: %s. Which one would you like to know about?", list),
				fmt.Sprintf("स्टॉक में ये प्रोडक्ट हैं: %s। आप किसके बारे में जानना चाहेंगे?", list),
				fmt.Sprintf("Stock mein ye products hain: %s. Aap kiske baare mein jaanna chahenge?", list),
			)
		}
		return notFoundReply()
	}

	// 5. Policy questions (W10) — score entries by the SPECIFIC policy
	// type asked about; never return the wrong policy. "Broken / not
	// working" counts as a warranty question.
	rePolicy := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(return|refund|exchange|warranty|guarantee|ferot|change|policy|ফেরত|ওয়ারেন্টি|ওয়ারেন্টি|পলিসি|broken|not working|stopped working|damaged|নষ্ট|खराब|টাকা ফেরত)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if rePolicy.MatchString(text) && len(knowledge) > 0 {
		type wantedType struct{ keywords []string }
		var wanted []wantedType
		if regexp.MustCompile(`(?i)(warranty|guarantee|ওয়ারেন্টি|ওয়ারেন্টি|वारंटी|गारंटी|broken|not working|stopped working|damaged|নষ্ট|खराब)`).MatchString(text) {
			wanted = append(wanted, wantedType{[]string{"warranty", "guarantee", "ওয়ারেন্টি", "ওয়ারেন্টি", "वारंटी"}})
		}
		if regexp.MustCompile(`(?i)(refund|রিফান্ড|रिफंड|টাকা ফেরত)`).MatchString(text) {
			wanted = append(wanted, wantedType{[]string{"refund", "রিফান্ড", "रिफंड"}})
		}
		if regexp.MustCompile(`(?i)(return|exchange|ferot|ফেরত|वापसी|बदल|বদল)`).MatchString(text) {
			wanted = append(wanted, wantedType{[]string{"return", "exchange", "ferot", "ফেরত", "वापसी", "बदल", "বদল"}})
		}
		var best *KnowledgeItem
		bestScore := 0
		for i := range knowledge {
			combined := strings.ToLower(knowledge[i].Title + " " + knowledge[i].Content + " " + knowledge[i].Category)
			score := 0
			for _, w := range wanted {
				for _, kw := range w.keywords {
					if strings.Contains(combined, kw) {
						score += 3
					}
				}
			}
			if strings.Contains(combined, "policy") || strings.Contains(combined, "পলিসি") {
				score += 1
			}
			if score > bestScore {
				bestScore = score
				best = &knowledge[i]
			}
		}
		if best == nil {
			// No entry scored for the asked type: first entry with any policy word.
			for i := range knowledge {
				combined := strings.ToLower(knowledge[i].Title + " " + knowledge[i].Content + " " + knowledge[i].Category)
				if strings.Contains(combined, "return") || strings.Contains(combined, "refund") ||
					strings.Contains(combined, "policy") || strings.Contains(combined, "warranty") ||
					strings.Contains(combined, "ফেরত") || strings.Contains(combined, "পলিসি") {
					best = &knowledge[i]
					break
				}
			}
		}
		if best != nil {
			return pick(
				fmt.Sprintf("আমাদের পলিসি: %s। বিস্তারিত জানতে আমাদের জানাতে পারেন।", best.Content),
				fmt.Sprintf("Amader policy: %s. Kono query thakle janate paren.", best.Content),
				fmt.Sprintf("Our policy: %s.", best.Content),
				fmt.Sprintf("हमारी पॉलिसी: %s।", best.Content),
				fmt.Sprintf("Hamari policy: %s.", best.Content),
			)
		}
	}

	// 6. Compare two named products (W8): "Which is cheaper, the
	// earbuds or the speaker?" — answer with the cheaper of the two.
	reCompare := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(cheaper|compare|comparison|কম দাম|सस्ता)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reCompare.MatchString(text) {
		if matched := matchProducts(text); len(matched) >= 2 {
			a, b := matched[0], matched[1]
			cheaper, dearer := a, b
			if priceOf(b) < priceOf(a) {
				cheaper, dearer = b, a
			}
			return pick(
				fmt.Sprintf("%s সস্তা — %v টাকা, আর %s %v টাকা।", cheaper.Name, cheaper.PriceBDT, dearer.Name, dearer.PriceBDT),
				fmt.Sprintf("%s sosta — %v BDT, ar %s %v BDT.", cheaper.Name, cheaper.PriceBDT, dearer.Name, dearer.PriceBDT),
				fmt.Sprintf("%s is cheaper — %v BDT, while %s is %v BDT.", cheaper.Name, cheaper.PriceBDT, dearer.Name, dearer.PriceBDT),
				fmt.Sprintf("%s सस्ता है — %v BDT, जबकि %s %v BDT है।", cheaper.Name, cheaper.PriceBDT, dearer.Name, dearer.PriceBDT),
				fmt.Sprintf("%s sasta hai — %v BDT, jabki %s %v BDT hai.", cheaper.Name, cheaper.PriceBDT, dearer.Name, dearer.PriceBDT),
			)
		}
	}

	// 7. Cheapest product (W8): minimum price across the catalog.
	reCheapest := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(cheapest|lowest price|lowest|sobcheye kom|সবচেয়ে কম|সবচেয়ে কম|সবচেয়ে সস্তা|সবচেয়ে সস্তা|sabse sasta|sabse kam|sobcheye sosta|সস্তা|sasta)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reCheapest.MatchString(text) && len(products) > 0 {
		cheapest := products[0]
		for _, p := range products[1:] {
			if priceOf(p) < priceOf(cheapest) {
				cheapest = p
			}
		}
		return pick(
			fmt.Sprintf("আমাদের সবচেয়ে কম দামের প্রোডাক্ট %s — %v টাকা।", cheapest.Name, cheapest.PriceBDT),
			fmt.Sprintf("Amader sobcheye kom damer product %s — %v BDT.", cheapest.Name, cheapest.PriceBDT),
			fmt.Sprintf("Our cheapest product is %s — %v BDT.", cheapest.Name, cheapest.PriceBDT),
			fmt.Sprintf("हमारा सबसे सस्ता प्रोडक्ट %s है — %v BDT।", cheapest.Name, cheapest.PriceBDT),
			fmt.Sprintf("Hamara sabse sasta product %s hai — %v BDT.", cheapest.Name, cheapest.PriceBDT),
		)
	}

	// 8. Category listing (W8): a category label, or a list-all request.
	reCategoryList := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(what products|what do you have|list (your|all|the)? ?(products|items)?|all products|catalogue?|তালিকা|সব প্রোডাক্ট|show me (your|all|everything))(?:[^\p{L}\p{M}\p{N}_]|$)`)
	categoryLabel := ""
	for _, entry := range categoryLabels {
		if entry.re.MatchString(text) {
			categoryLabel = entry.label
			break
		}
	}
	if (categoryLabel != "" || reCategoryList.MatchString(text)) && len(products) > 0 {
		listed := products
		if categoryLabel != "" {
			keywords := categoryKeywords[categoryLabel]
			var filtered []ProductItem
			for _, p := range products {
				cat := strings.ToLower(p.Category)
				matchedCat := false
				if cat != "" {
					if strings.Contains(cat, categoryLabel) {
						matchedCat = true
					} else {
						for _, kw := range keywords {
							if strings.Contains(cat, kw) {
								matchedCat = true
								break
							}
						}
					}
				}
				if !matchedCat {
					for _, w := range productWords(p) {
						for _, kw := range keywords {
							if w == kw {
								matchedCat = true
								break
							}
						}
						if matchedCat {
							break
						}
					}
				}
				if matchedCat {
					filtered = append(filtered, p)
				}
			}
			listed = filtered
			if len(listed) == 0 {
				return pick(
					"দুঃখিত, এই ক্যাটাগরিতে আমাদের কাছে কোনো প্রোডাক্ট নেই।",
					"Dukkhito, ei category-te amader kache kono product nei.",
					"Sorry, we do not carry anything in that category.",
					"माफ़ कीजिए, इस कैटेगरी में हमारे पास कोई प्रोडक्ट नहीं है।",
					"Maaf kijiye, is category mein hamare paas koi product nahi hai.",
				)
			}
		}
		var parts []string
		for _, p := range listed {
			parts = append(parts, fmt.Sprintf("%s (%v BDT)", p.Name, p.PriceBDT))
		}
		list := strings.Join(parts, ", ")
		if categoryLabel != "" {
			return pick(
				fmt.Sprintf("এই ক্যাটাগরিতে আমাদের আছে: %s।", list),
				fmt.Sprintf("Ei category-te amader ache: %s.", list),
				fmt.Sprintf("In this category we have: %s.", list),
				fmt.Sprintf("इस कैटेगरी में हमारे पास है: %s।", list),
				fmt.Sprintf("Is category mein hamare paas hai: %s.", list),
			)
		}
		return pick(
			fmt.Sprintf("আমাদের প্রোডাক্টগুলো: %s।", list),
			fmt.Sprintf("Amader product-gulo: %s.", list),
			fmt.Sprintf("Our products: %s.", list),
			fmt.Sprintf("हमारे प्रोडक्ट: %s।", list),
			fmt.Sprintf("Hamare products: %s.", list),
		)
	}

	// 9. Order intent (with word boundaries and conversational memory
	// across turns). Uses details already given (W12) and refuses
	// out-of-stock items.
	reOrder := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(order|buy|purchase|kinte|nibo|nebo|lagbe|nite|chai|chaichi|haa|ha|yes|confirm|অর্ডার|কিনব|কিনতে|নিব|চাই|নিতে|চাচ্ছি|হাঁ|হ্যাঁ)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reOrder.MatchString(text) {
		matched := matchProduct(text)
		if matched == nil {
			for i := len(history) - 1; i >= 0; i-- {
				if m := matchProduct(history[i].Content); m != nil {
					matched = m
					break
				}
			}
		}

		if matched != nil && matched.Stock <= 0 {
			return outOfStockReply(matched)
		}

		details := ExtractCustomerDetails(text)
		for i := len(history) - 1; i >= 0; i-- {
			if details.Name != "" && details.Phone != "" && details.Address != "" {
				break
			}
			older := ExtractCustomerDetails(history[i].Content)
			if details.Name == "" && older.Name != "" {
				details.Name = older.Name
			}
			if details.Phone == "" && older.Phone != "" {
				details.Phone = older.Phone
			}
			if details.Address == "" && older.Address != "" {
				details.Address = older.Address
			}
		}

		prodLabel := ""
		if matched != nil {
			prodLabel = fmt.Sprintf(" (%s — %v BDT", matched.Name, matched.PriceBDT)
			if details.HasQty {
				prodLabel += fmt.Sprintf(" x %d", details.Quantity)
			}
			prodLabel += ")"
		}
		var missing []string
		if details.Name == "" {
			missing = append(missing, pick("নাম", "naam", "name", "नाम", "naam"))
		}
		if details.Phone == "" {
			missing = append(missing, pick("ফোন নম্বর", "phone number", "phone number", "फ़ोन नंबर", "phone number"))
		}
		if details.Address == "" {
			missing = append(missing, pick("ডেলিভারি ঠিকানা", "delivery address", "delivery address", "डिलीवरी पता", "delivery address"))
		}
		var givenBits []string
		if details.Name != "" {
			givenBits = append(givenBits, details.Name)
		}
		if details.Phone != "" {
			givenBits = append(givenBits, details.Phone)
		}
		if details.Address != "" {
			givenBits = append(givenBits, details.Address)
		}
		given := strings.Join(givenBits, ", ")
		detailsNote := ""
		if given != "" {
			detailsNote = pick(
				fmt.Sprintf(" বিস্তারিত: %s।", given),
				fmt.Sprintf(" Details: %s.", given),
				fmt.Sprintf(" Details on file: %s.", given),
				fmt.Sprintf(" विवरण: %s।", given),
				fmt.Sprintf(" Details: %s.", given),
			)
		}

		if len(missing) == 0 {
			nameBit := ""
			if details.Name != "" {
				nameBit = ", " + details.Name
			}
			return pick(
				fmt.Sprintf("ধন্যবাদ%s! আপনার অর্ডারটি%s কনফার্ম করতে \"confirm\" লিখে পাঠান।%s", nameBit, prodLabel, detailsNote),
				fmt.Sprintf("Dhonnobad%s! Apnar order%s confirm korte \"confirm\" likhe pathan.%s", nameBit, prodLabel, detailsNote),
				fmt.Sprintf("Thanks%s! I have your details for your order%s. Reply \"confirm\" to place it.%s", nameBit, prodLabel, detailsNote),
				fmt.Sprintf("धन्यवाद%s! आपका ऑर्डर%s कन्फर्म करने के लिए \"confirm\" लिखकर भेजें।%s", nameBit, prodLabel, detailsNote),
				fmt.Sprintf("Dhanyavaad%s! Aapka order%s confirm karne ke liye \"confirm\" likhkar bhejein.%s", nameBit, prodLabel, detailsNote),
			)
		}
		missingJoined := strings.Join(missing, ", ")
		givenSuffix := ""
		if given != "" {
			givenSuffix = pick(
				fmt.Sprintf(" আমরা পেয়েছি: %s।", given),
				fmt.Sprintf(" Amra peyechi: %s.", given),
				fmt.Sprintf(" We already have: %s.", given),
				fmt.Sprintf(" हमें मिल गया है: %s।", given),
				fmt.Sprintf(" Humein mil gaya hai: %s.", given),
			)
		}
		return pick(
			fmt.Sprintf("আপনার অর্ডারটি%s কনফার্ম করার জন্য অনুগ্রহ করে আপনার %s লিখে দিন।%s", prodLabel, missingJoined, givenSuffix),
			fmt.Sprintf("Apnar order%s confirm korte %s ta ekhane likhe din please.%s", prodLabel, missingJoined, givenSuffix),
			fmt.Sprintf("To confirm your order%s, please provide your %s.%s", prodLabel, missingJoined, givenSuffix),
			fmt.Sprintf("आपका ऑर्डर%s कन्फर्म करने के लिए कृपया अपना %s लिखकर भेजें।%s", prodLabel, missingJoined, givenSuffix),
			fmt.Sprintf("Aapka order%s confirm karne ke liye kripya apna %s likhkar bhejein.%s", prodLabel, missingJoined, givenSuffix),
		)
	}

	// 10. Price & Product inquiry with intelligent matching.
	// No products[0] fallback: an unmatched price question says the
	// product was not found instead of quoting the wrong product (W2/L1).
	rePrice := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(dam|daam|price|cost|koto|rate|দাম|মূল্য|কত|keemat|kimat|कीमत|कितने)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	matched := matchProduct(text)
	if rePrice.MatchString(text) || matched != nil {
		if matched != nil {
			if strings.Contains(strings.ToLower(text), "total") {
				all := matchProducts(text)
				if len(all) >= 2 {
					var parts []string
					total := 0.0
					for _, p := range all {
						parts = append(parts, fmt.Sprintf("%s (%v BDT)", p.Name, p.PriceBDT))
						total += priceOf(p)
					}
					lines := strings.Join(parts, " + ")
					totalStr := strconv.FormatFloat(total, 'f', -1, 64)
					return pick(
						fmt.Sprintf("%s = মোট %s টাকা।", lines, totalStr),
						fmt.Sprintf("%s = mot %s BDT.", lines, totalStr),
						fmt.Sprintf("%s = %s BDT in total.", lines, totalStr),
						fmt.Sprintf("%s = कुल %s BDT।", lines, totalStr),
						fmt.Sprintf("%s = kul %s BDT.", lines, totalStr),
					)
				}
			}
			return priceReply(matched)
		}
		if rePrice.MatchString(text) {
			return notFoundReply()
		}
	}

	// 11. Out-of-catalog product question (W7): "Do you have iPhone 15?"
	reProductQuestion := regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{M}\p{N}_])(do you (have|sell|carry|offer|stock)|have you got|is there|are there|do you have|আছে|ache|আছেন|है|sells?|carry)(?:[^\p{L}\p{M}\p{N}_]|$)`)
	if reProductQuestion.MatchString(text) && len(products) > 0 {
		return notFoundReply()
	}

	// 12. Greetings & general inquiry
	return pick(
		"ধন্যবাদ আমাদের সাথে যোগাযোগ করার জন্য! আমি আপনাকে কীভাবে সাহায্য করতে পারি?",
		"Message korar jonno dhonnobad! Apnake kivabe shahajjo korte pari?",
		"Thank you for reaching out to us! How can we assist you today?",
		"नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?",
		"Namaste! Main aapki kaise madad kar sakta hoon?",
	)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
