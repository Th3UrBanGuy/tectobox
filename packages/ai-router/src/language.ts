/**
 * Language detection — @tectonic/ai-router (Phase 4 of the modular
 * restructure). The api and the workers each had their own copy of the
 * ai router (api/src/ai/router.ts vs workers/src/ai/); this package is
 * the one implementation both import. Code moved verbatim from the
 * workers split; no behaviour change.
 */

const BN_WORDS = new Set(
  ('dam damta damadami koto kotokhon kotogulo ki keno kivabe kibhabe kemne ' +
   'chai chay chaichi lagbe lagbo diben dibo debo nibo nebo pathan pathabo pathate pathiye ' +
   'apni apnar apnake apnader tumi tomar tomake tomader ami amar amake amader ' +
   'kore koren korbo korben korle korchi hobe hoben hobena hoyni ache achen achhen nei nai ' +
   'kothay kothai kotha kothata bolen bolun bolbo bolte bolben janen jante janan ' +
   'dekhte nite kinte kinbo nite asbe ashte ashbo jabe jaben jabo ' +
   'thakbe thakben thakbo cholbe cholte rokom moto moton shathe sathe jonno jonne theke ' +
   'diye niye bhabe bhai bhaiya apu dada didi salam assalamu alaikum walaikum ' +
   'dhonnobad bhalo kharap sundor shundor notun purono puran komano komate kombe kom ' +
   'beshi onek ektu ekta duita tinta koyta koyekta prothom shesh ajke kalke porshu ' +
   'ekhon ekhono tokhon agey porey pore age shob shobai shobgulo kichu kichui kono konota ' +
   'keu kake kader kar karo jara jader she shey tara tader ora oder eta ota egulo ogulo ' +
   'ekhane okhane shekhane bashay dokan dokane bazar bazare dhaka dhakar dhakay dhakate ' +
   'taka takay takar poisha poishay cash bikash bkash nagad rocket ' +
   'order orderta orderti deliveryta productta productgulo jinish jinishta mal maal dam ' +
   'khabar item items price pricegulo discount offerta offer cholche ' +
   'ache achen nei nai hobe hoben hobena korchi korchen korlam dilam nilam pelam ' +
   'bujhi bujhlam bujhte parchi parbo parben pari paren korte kortei hote ' +
   'holo hoyeche hoyechhe holo hoy hoy na hyna na naa haa haan ha ji accha achha ' +
   'thik thik ache thikache okhay okey shomossha somossha somossa mushkil jhamela ' +
   'dorkar proyojon lagbe chai chay kori koro koren ' +
   'dekhun dekhbo ashun ashbo boshun bolun bolen shunun koren janun nin nen din den ' +
   'kothay kobe kokhon kikore ki kore kisher keno kisher jonno kar jonno').split(/\s+/)
);

export function detectCustomerLanguage(rawText: string): 'bn' | 'banglish' | 'en' | 'hi' {
  const t = String(rawText || '');
  if (/[\u0980-\u09FF]/.test(t)) return 'bn'; // Bangla script
  if (/[\u0900-\u097F]/.test(t)) return 'hi'; // Devanagari script
  const words = t.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!words.length) return 'en';
  let hits = 0;
  for (const w of words) if (BN_WORDS.has(w)) hits++;
  if (hits >= 2 || (words.length <= 6 && hits >= 1)) return 'banglish';
  return 'en';
}

export function languageDirective(lang: 'bn' | 'banglish' | 'en' | 'hi'): string {
  const base = `LANGUAGE (NON-NEGOTIABLE): the customer is writing in ${
    lang === 'bn' ? 'Bangla (বাংলা হরফে লিখুন)' :
    lang === 'banglish' ? 'Banglish (Bengali in English/Latin letters, e.g. "dam koto", "kivabe nibo")' :
    lang === 'hi' ? 'Hindi' : 'English'
  }. Your reply MUST be written in exactly that language.`;
  if (lang === 'banglish') {
    return base + ' Banglish is Bengali written in Latin letters — it is NOT Hindi. NEVER reply in Hindi. NEVER use Devanagari script (अ-হ) under any circumstances. If you feel tempted to write Hindi, write Banglish instead.';
  }
  if (lang === 'bn') {
    return base + ' Write ONLY in Bangla script (বাংলা হরফ). NEVER use Devanagari script (अ-হ) or Hindi.';
  }
  return base;
}

