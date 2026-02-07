// ─────────────────────────────────────────────────────────────
// tests/googleService.test.js — Unit tests for Google Cloud service
// Tests language mapping, BCP-47 conversion, voice map coverage,
// input validation, and module exports.
// (API calls are tested in integration tests)
// ─────────────────────────────────────────────────────────────

'use strict';

// Must set env before requiring module (prevents fatal exit)
process.env.GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID || 'test-project';

const {
  getLanguageName,
  bcp47ToIso,
  VOICE_MAP,
} = require('../lib/googleService');

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
console.log('\n=== BCP-47 → ISO-639-1 Conversion ===');

test('converts "en-US" → "en"', () => {
  assert(bcp47ToIso('en-US') === 'en');
});

test('converts "hi-IN" → "hi"', () => {
  assert(bcp47ToIso('hi-IN') === 'hi');
});

test('converts "es-ES" → "es"', () => {
  assert(bcp47ToIso('es-ES') === 'es');
});

test('converts "fr-FR" → "fr"', () => {
  assert(bcp47ToIso('fr-FR') === 'fr');
});

test('converts "pt-BR" → "pt"', () => {
  assert(bcp47ToIso('pt-BR') === 'pt');
});

test('converts "ja-JP" → "ja"', () => {
  assert(bcp47ToIso('ja-JP') === 'ja');
});

test('converts "ar-SA" → "ar"', () => {
  assert(bcp47ToIso('ar-SA') === 'ar');
});

test('converts bare code "zh" → "zh"', () => {
  assert(bcp47ToIso('zh') === 'zh');
});

test('converts "cmn-CN" → "zh" (Mandarin special case)', () => {
  assert(bcp47ToIso('cmn-CN') === 'zh');
});

test('converts "cmn-TW" → "zh"', () => {
  assert(bcp47ToIso('cmn-TW') === 'zh');
});

test('falls back to "en" for null/undefined', () => {
  assert(bcp47ToIso(null) === 'en');
  assert(bcp47ToIso(undefined) === 'en');
  assert(bcp47ToIso('') === 'en');
});

test('handles complex BCP-47 tags', () => {
  assert(bcp47ToIso('en-US-x-custom') === 'en');
  assert(bcp47ToIso('de-DE') === 'de');
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

test('"fr" → "French"', () => {
  assert(getLanguageName('fr') === 'French');
});

test('"ta" → "Tamil"', () => {
  assert(getLanguageName('ta') === 'Tamil');
});

test('"bn" → "Bengali"', () => {
  assert(getLanguageName('bn') === 'Bengali');
});

test('unknown code returns the code itself', () => {
  assert(getLanguageName('xx') === 'xx');
  assert(getLanguageName('zzz') === 'zzz');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Voice Map Coverage ===');

test('English voice is configured', () => {
  assert(VOICE_MAP.en, 'Missing English voice');
  assert(VOICE_MAP.en.languageCode === 'en-US');
  assert(VOICE_MAP.en.name.startsWith('en-US'));
});

test('Hindi voice is configured', () => {
  assert(VOICE_MAP.hi, 'Missing Hindi voice');
  assert(VOICE_MAP.hi.languageCode === 'hi-IN');
  assert(VOICE_MAP.hi.name.startsWith('hi-IN'));
});

test('Spanish voice is configured', () => {
  assert(VOICE_MAP.es, 'Missing Spanish voice');
  assert(VOICE_MAP.es.languageCode === 'es-ES');
});

test('All voice entries have required fields', () => {
  for (const [code, config] of Object.entries(VOICE_MAP)) {
    assert(config.languageCode, `${code}: missing languageCode`);
    assert(config.name, `${code}: missing name`);
    assert(config.ssmlGender, `${code}: missing ssmlGender`);
  }
});

test('At least 10 languages have voices', () => {
  const count = Object.keys(VOICE_MAP).length;
  assert(count >= 10, `Only ${count} voices configured, need at least 10`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Module Exports ===');

test('transcribe is exported as function', () => {
  const mod = require('../lib/googleService');
  assert(typeof mod.transcribe === 'function');
});

test('translate is exported as function', () => {
  const mod = require('../lib/googleService');
  assert(typeof mod.translate === 'function');
});

test('reason is exported as function', () => {
  const mod = require('../lib/googleService');
  assert(typeof mod.reason === 'function');
});

test('synthesize is exported as function', () => {
  const mod = require('../lib/googleService');
  assert(typeof mod.synthesize === 'function');
});

test('getLanguageName is exported as function', () => {
  const mod = require('../lib/googleService');
  assert(typeof mod.getLanguageName === 'function');
});

test('bcp47ToIso is exported as function', () => {
  const mod = require('../lib/googleService');
  assert(typeof mod.bcp47ToIso === 'function');
});

// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Google Service: ${pass}/${total} passed, ${fail} failed`);
console.log('═'.repeat(50));

module.exports = { pass, fail, total };
