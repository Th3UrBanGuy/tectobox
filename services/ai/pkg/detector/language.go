package detector

import (
	"strings"
	"unicode"
)

type Language string

const (
	LangBangla   Language = "bn"
	LangBanglish Language = "banglish"
	LangEnglish  Language = "en"
	LangHindi    Language = "hi"
)

// Distinctive Banglish function and grammatical words (never standard English)
var banglishGrammarWords = map[string]struct{}{
	"dam": {}, "damta": {}, "damadami": {}, "koto": {}, "kotokhon": {}, "kotogulo": {}, "ki": {}, "keno": {},
	"kivabe": {}, "kibhabe": {}, "kemne": {}, "chai": {}, "chay": {}, "chaichi": {}, "lagbe": {}, "lagbo": {},
	"diben": {}, "dibo": {}, "debo": {}, "nibo": {}, "nebo": {}, "pathan": {}, "pathabo": {}, "pathate": {},
	"pathiye": {}, "apni": {}, "apnar": {}, "apnake": {}, "apnader": {}, "tumi": {}, "tomar": {}, "tomake": {},
	"tomader": {}, "ami": {}, "amar": {}, "amake": {}, "amader": {}, "kore": {}, "koren": {}, "korbo": {},
	"korben": {}, "korle": {}, "korchi": {}, "hobe": {}, "hoben": {}, "hobena": {}, "hoyni": {}, "ache": {},
	"achen": {}, "achhen": {}, "nei": {}, "nai": {}, "kothay": {}, "kothai": {}, "kotha": {}, "kothata": {},
	"bolen": {}, "bolun": {}, "bolbo": {}, "bolte": {}, "bolben": {}, "janen": {}, "jante": {}, "janan": {},
	"dekhte": {}, "nite": {}, "kinte": {}, "kinbo": {}, "asbe": {}, "ashte": {}, "ashbo": {}, "jabe": {},
	"jaben": {}, "jabo": {}, "thakbe": {}, "thakben": {}, "thakbo": {}, "cholbe": {}, "cholte": {}, "rokom": {},
	"moto": {}, "moton": {}, "shathe": {}, "sathe": {}, "jonno": {}, "jonne": {}, "theke": {}, "diye": {},
	"niye": {}, "bhabe": {}, "bhai": {}, "bhaiya": {}, "vai": {}, "vaia": {}, "vaiya": {}, "bro": {}, "apu": {}, "dada": {}, "didi": {}, "salam": {},
	"dhonnobad": {}, "bhalo": {}, "kharap": {}, "sundor": {}, "shundor": {}, "notun": {}, "purono": {},
	"puran": {}, "komano": {}, "komate": {}, "kombe": {}, "kom": {}, "beshi": {}, "onek": {}, "ektu": {},
	"ekta": {}, "duita": {}, "tinta": {}, "koyta": {}, "koyekta": {}, "prothom": {}, "shesh": {}, "ajke": {},
	"kalke": {}, "porshu": {}, "ekhon": {}, "ekhono": {}, "tokhon": {}, "agey": {}, "porey": {}, "pore": {},
	"age": {}, "shob": {}, "shobai": {}, "shobgulo": {}, "kichu": {}, "kichui": {}, "kono": {}, "konota": {},
	"keu": {}, "kake": {}, "kader": {}, "kar": {}, "karo": {}, "jara": {}, "jader": {}, "she": {}, "shey": {},
	"tara": {}, "tader": {}, "ora": {}, "oder": {}, "eta": {}, "ota": {}, "eita": {}, "oita": {}, "egulo": {}, "ogulo": {}, "ekhane": {},
	"okhane": {}, "shekhane": {}, "bashay": {}, "dokan": {}, "dokane": {}, "bazar": {}, "bazare": {},
	"jinish": {}, "jinishta": {}, "mal": {}, "maal": {}, "khabar": {}, "bujhi": {}, "bujhlam": {}, "bujhte": {},
	"parchi": {}, "parbo": {}, "parben": {}, "pari": {}, "paren": {}, "korte": {}, "kortei": {}, "hote": {},
	"holo": {}, "hoyeche": {}, "hoyechhe": {}, "naa": {}, "haa": {}, "haan": {}, "thikache": {}, "thik": {},
	"shomossha": {}, "somossha": {}, "somossa": {}, "mushkil": {}, "jhamela": {}, "dorkar": {}, "proyojon": {},
	"kobe": {}, "kokhon": {}, "pabo": {}, "paben": {}, "pelam": {}, "peyechi": {}, "somoy": {}, "shomoy": {},
	"taratari": {}, "druto": {}, "daam": {}, "rate": {}, "chaichilam": {}, "rakha": {}, "rakhben": {},
}

// Distinctive English function words (never standard Banglish grammar)
var englishGrammarWords = map[string]struct{}{
	"what": {}, "is": {}, "the": {}, "are": {}, "how": {}, "much": {}, "does": {}, "do": {}, "did": {},
	"can": {}, "could": {}, "would": {}, "should": {}, "will": {}, "shall": {}, "and": {}, "or": {},
	"for": {}, "with": {}, "from": {}, "about": {}, "your": {}, "my": {}, "our": {}, "their": {},
	"this": {}, "that": {}, "these": {}, "those": {}, "when": {}, "where": {}, "why": {}, "who": {},
	"whom": {}, "which": {}, "please": {}, "tell": {}, "show": {}, "give": {}, "help": {}, "hello": {},
	"hi": {}, "hey": {}, "thanks": {}, "thank": {}, "you": {}, "they": {}, "them": {}, "we": {}, "us": {},
	"it": {}, "its": {}, "have": {}, "has": {}, "had": {}, "fee": {}, "fees": {}, "policy": {}, "days": {},
	"hours": {}, "time": {}, "take": {}, "takes": {}, "long": {}, "fast": {}, "inside": {}, "outside": {},
	"available": {}, "want": {}, "like": {}, "need": {}, "buy": {}, "purchase": {}, "good": {}, "great": {},
}

// DetectLanguage inspects text and accurately determines user language intent:
// 1. Pure Bengali script (বাংলা লিপি) -> LangBangla
// 2. Hindi Devanagari script -> LangHindi
// 3. Banglish (Romanized Bengali) -> LangBanglish
// 4. English -> LangEnglish
func DetectLanguage(rawText string) Language {
	text := strings.TrimSpace(rawText)
	if text == "" {
		return LangEnglish
	}

	var hasBangla, hasDevanagari bool
	for _, r := range text {
		if r >= 0x0980 && r <= 0x09FF {
			hasBangla = true
			break
		}
		if r >= 0x0900 && r <= 0x097F {
			hasDevanagari = true
			break
		}
	}

	if hasBangla {
		return LangBangla
	}
	if hasDevanagari {
		return LangHindi
	}

	// Tokenize words
	var words []string
	var current strings.Builder
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) {
			current.WriteRune(r)
		} else if current.Len() > 0 {
			words = append(words, current.String())
			current.Reset()
		}
	}
	if current.Len() > 0 {
		words = append(words, current.String())
	}

	if len(words) == 0 {
		return LangEnglish
	}

	var banglishScore, englishScore int
	for _, w := range words {
		if _, ok := banglishGrammarWords[w]; ok {
			banglishScore += 2
			continue
		}
		if _, ok := englishGrammarWords[w]; ok {
			englishScore += 2
			continue
		}

		// Suffix matching for Bengali morphology (e.g. jinishta, phoneta, pathalen)
		if len(w) > 4 {
			if strings.HasSuffix(w, "ta") || strings.HasSuffix(w, "gulo") ||
				strings.HasSuffix(w, "er") || strings.HasSuffix(w, "te") ||
				strings.HasSuffix(w, "ben") || strings.HasSuffix(w, "bo") {
				base := w
				if strings.HasSuffix(w, "gulo") {
					base = w[:len(w)-4]
				} else if strings.HasSuffix(w, "ben") {
					base = w[:len(w)-3]
				} else {
					base = w[:len(w)-2]
				}
				if _, ok := banglishGrammarWords[base]; ok {
					banglishScore += 2
				}
			}
		}
	}

	if banglishScore > englishScore && banglishScore > 0 {
		return LangBanglish
	}
	if englishScore > banglishScore && englishScore > 0 {
		return LangEnglish
	}
	if banglishScore > 0 {
		return LangBanglish
	}

	return LangEnglish
}

// LanguageDirective returns iron-clad, strict instructions for LLM completion
func LanguageDirective(lang Language) string {
	switch lang {
	case LangBangla:
		return `[CRITICAL LANGUAGE MANDATE - STRICT]
The customer has spoken in Bengali script (বাংলা লিপি).
Your ENTIRE response MUST be 100% written in fluent, polite, grammatically correct Bengali script (বাংলা লিপি).
DO NOT use English words or Banglish under any circumstances.
Example tone: "ধন্যবাদ আমাদের সাথে যোগাযোগ করার জন্য! আমাদের ডেলিভারি চার্জ ঢাকার ভেতরে ৬০ টাকা এবং ঢাকার বাইরে ১২০ টাকা।"`

	case LangBanglish:
		return `[CRITICAL LANGUAGE MANDATE - STRICT]
The customer has spoken in Banglish (Bengali words written with English alphabets, e.g. 'dam koto', 'delivery charge koto?').
Your ENTIRE response MUST be 100% written in natural, friendly Banglish (Romanized Bengali).
DO NOT respond in Hindi, Devanagari script, or pure English.
DO NOT translate into pure English.
Example tone: "Amader delivery charge Dhaka city-r bhitore 60 taka ebong Dhaka-r baire 120 taka. Cash on delivery available ache."`

	case LangEnglish:
		return `[CRITICAL LANGUAGE MANDATE - STRICT]
The customer has spoken in English.
Your ENTIRE response MUST be 100% in clean, professional, courteous English.
DO NOT respond in Bengali or Banglish.`

	default:
		return `[CRITICAL LANGUAGE MANDATE]
Respond politely in the exact same language and script used by the customer.`
	}
}
