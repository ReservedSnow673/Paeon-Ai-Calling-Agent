// ─────────────────────────────────────────────────────────────
// tests/openaiService.test.js — Unit tests for OpenAI service
// Tests the language mapping, input validation, and module exports
// (API calls are tested in integration tests)
// ─────────────────────────────────────────────────────────────

'use strict';

// Must set env before requiring module
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-placeholder';

const {
  getLanguageName,
  whisperLangToIso,
} = require('../lib/openaiService');

let pass = 0, fail = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== Whisper Language → ISO Mapping ===');

test('maps "english" → "en"', () => {
  assert(whisperLangToIso('english') === 'en');
});

test('maps "hindi" → "hi"', () => {
  assert(whisperLangToIso('hindi') === 'hi');
});

test('maps "spanish" → "es"', () => {
  assert(whisperLangToIso('spanish') === 'es');
});

test('maps "french" → "fr"', () => {
  assert(whisperLangToIso('french') === 'fr');
});

test('maps "chinese" → "zh"', () => {
  assert(whisperLangToIso('chinese') === 'zh');
});

test('maps "japanese" → "ja"', () => {
  assert(whisperLangToIso('japanese') === 'ja');
});

test('maps "arabic" → "ar"', () => {
  assert(whisperLangToIso('arabic') === 'ar');
});

test('maps "bengali" → "bn"', () => {
  assert(whisperLangToIso('bengali') === 'bn');
});

test('maps "tamil" → "ta"', () => {
  assert(whisperLangToIso('tamil') === 'ta');
});

test('maps "urdu" → "ur"', () => {
  assert(whisperLangToIso('urdu') === 'ur');
});

test('is case-insensitive', () => {
  assert(whisperLangToIso('ENGLISH') === 'en');
  assert(whisperLangToIso('Hindi') === 'hi');
  assert(whisperLangToIso('SPANISH') === 'es');
});

test('handles leading/trailing whitespace', () => {
  assert(whisperLangToIso('  english  ') === 'en');
  assert(whisperLangToIso('hindi ') === 'hi');
});

test('falls back to "en" for null/undefined', () => {
  assert(whisperLangToIso(null) === 'en');
  assert(whisperLangToIso(undefined) === 'en');
  assert(whisperLangToIso('') === 'en');
});

test('passes through bare ISO codes (2-char)', () => {
  assert(whisperLangToIso('en') === 'en');
  assert(whisperLangToIso('hi') === 'hi');
  assert(whisperLangToIso('fr') === 'fr');
});

test('falls back to "en" for unknown language', () => {
  assert(whisperLangToIso('klingon') === 'en');
  assert(whisperLangToIso('gibberish') === 'en');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== ISO → Language Name ===');

test('"en" → "English"', () => {
  assert(getLanguageName('en') === 'English');
});

test('"hi" → "Hindi"', () => {
  assert(getLanguageName('hi') === 'Hindi');
});

test('"es" → "Spanish"', () => {
  assert(getLanguageName('es') === 'Spanish');
});

test('"zh" → "Chinese"', () => {
  assert(getLanguageName('zh') === 'Chinese');
});

test('"ja" → "Japanese"', () => {
  assert(getLanguageName('ja') === 'Japanese');
});

test('unknown code returns the code itself', () => {
  assert(getLanguageName('xx') === 'xx');
  assert(getLanguageName('zzz') === 'zzz');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Module Exports ===');

test('transcribe is exported as function', () => {
  const mod = require('../lib/openaiService');
  assert(typeof mod.transcribe === 'function');
});

test('translate is exported as function', () => {
  const mod = require('../lib/openaiService');
  assert(typeof mod.translate === 'function');
});

test('reason is exported as function', () => {
  const mod = require('../lib/openaiService');
  assert(typeof mod.reason === 'function');
});

test('synthesize is exported as function', () => {
  const mod = require('../lib/openaiService');
  assert(typeof mod.synthesize === 'function');
});

// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`OpenAI Service: ${pass}/${total} passed, ${fail} failed`);
console.log('═'.repeat(50));

module.exports = { pass, fail, total };
