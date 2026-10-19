// Language detection tests (2026-10-02): Banglish must never get a Hindi reply.
const { detectCustomerLanguage, languageDirective, hasDevanagari, buildSystemPrompt } = require('./src/ai.js');

const cases = [
  ['dam koto?', 'banglish'],
  ['Bhai, ei shirt tar dam koto? delivery charge koto dhakar baire?', 'banglish'],
  ['kivabe order korbo?', 'banglish'],
  ['price koto', 'banglish'],
  ['cod hobe?', 'banglish'],
  ['Apnar dokan kothay?', 'banglish'],
  ['thanks bhai', 'banglish'],
  ['Hello, what is the price of this shirt?', 'en'],
  ['What is the delivery charge?', 'en'],
  ['ok', 'en'],
  ['COD available?', 'en'],
  ['where is your shop located?', 'en'],
  ['দাম কত?', 'bn'],
  ['ডেলিভারি চার্জ কত ঢাকার বাইরে?', 'bn'],
  ['price কত?', 'bn'],
  ['कीमत क्या है?', 'hi'],
];
let fails = 0;
for (const [msg, want] of cases) {
  const got = detectCustomerLanguage(msg);
  if (got !== want) { fails++; console.log(`FAIL [${got}<-${want}] ${msg}`); }
}
const d = languageDirective('banglish');
if (!/NEVER reply in Hindi/i.test(d) || !/Devanagari/.test(d)) { fails++; console.log('FAIL banglish directive'); }
// Directive must actually land in the built system prompt.
const sys = buildSystemPrompt({ name: 'Test', business_type: 'physical', lead_fields: [] }, [], [], 4, languageDirective('banglish'));
if (!sys.includes('NON-NEGOTIABLE') || !/NOT Hindi/.test(sys)) { fails++; console.log('FAIL prompt missing directive'); }
// Old 4-arg call (tests/other callers) must still work.
buildSystemPrompt({ name: 'Test', business_type: 'physical', lead_fields: [] }, [], [], 4);
if (!hasDevanagari('आपका स्वागत है') || hasDevanagari('dam koto')) { fails++; console.log('FAIL hasDevanagari'); }
console.log(fails ? `${fails} FAILURES` : `ALL ${cases.length + 4} CHECKS PASS`);
process.exit(fails ? 1 : 0);
