// ─────────────────────────────────────────────────────────────
// tests/audioUtils.test.js — Unit tests for audio codec & helpers
// ─────────────────────────────────────────────────────────────

'use strict';

const {
  linearToMulaw, mulawToLinear,
  mulawToPcm, pcmToMulaw,
  createWavBuffer, ttsToTwilio,
  calculateEnergy, generateSilence,
} = require('../lib/audioUtils');

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
console.log('\n=== Mulaw Codec ===');

test('encode/decode 0 is lossless', () => {
  assert(mulawToLinear(linearToMulaw(0)) === 0);
});

test('encode/decode positive sample within tolerance', () => {
  const vals = [100, 500, 1000, 5000, 10000, 20000, 32000];
  for (const v of vals) {
    const rt = mulawToLinear(linearToMulaw(v));
    const err = Math.abs(rt - v) / v;
    assert(err < 0.1, `${v} round-trip error ${(err * 100).toFixed(1)}% > 10%`);
  }
});

test('encode/decode negative sample within tolerance', () => {
  const vals = [-100, -1000, -10000, -30000];
  for (const v of vals) {
    const rt = mulawToLinear(linearToMulaw(v));
    const err = Math.abs(rt - v) / Math.abs(v);
    assert(err < 0.1, `${v} round-trip error ${(err * 100).toFixed(1)}% > 10%`);
  }
});

test('mulaw byte range is 0–255', () => {
  const samples = [-32768, -10000, -1, 0, 1, 10000, 32767];
  for (const s of samples) {
    const b = linearToMulaw(s);
    assert(b >= 0 && b <= 255, `Out of range: ${b}`);
  }
});

test('clips samples above MULAW_MAX gracefully', () => {
  const a = linearToMulaw(32635);
  const b = linearToMulaw(40000);
  assert(a === b, 'Clipping should produce same result');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Buffer Conversions ===');

test('mulawToPcm output is 2x input length', () => {
  const m = Buffer.alloc(100, linearToMulaw(500));
  const p = mulawToPcm(m);
  assert(p.length === 200, `Expected 200, got ${p.length}`);
});

test('pcmToMulaw output is 0.5x input length', () => {
  const p = Buffer.alloc(200);
  for (let i = 0; i < 100; i++) p.writeInt16LE(1000, i * 2);
  const m = pcmToMulaw(p);
  assert(m.length === 100, `Expected 100, got ${m.length}`);
});

test('mulawToPcm → pcmToMulaw round-trip preserves data', () => {
  const original = Buffer.alloc(50);
  for (let i = 0; i < 50; i++) original[i] = linearToMulaw(i * 100);
  const pcm = mulawToPcm(original);
  const back = pcmToMulaw(pcm);
  for (let i = 0; i < 50; i++) {
    assert(original[i] === back[i], `Byte ${i} mismatch: ${original[i]} vs ${back[i]}`);
  }
});

test('empty buffer conversions are safe', () => {
  assert(mulawToPcm(Buffer.alloc(0)).length === 0);
  assert(pcmToMulaw(Buffer.alloc(0)).length === 0);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== WAV Creation ===');

test('WAV header is valid RIFF/WAVE', () => {
  const pcm = Buffer.alloc(320);
  const wav = createWavBuffer(pcm, 8000);
  assert(wav.slice(0, 4).toString() === 'RIFF', 'Missing RIFF');
  assert(wav.slice(8, 12).toString() === 'WAVE', 'Missing WAVE');
  assert(wav.slice(12, 16).toString() === 'fmt ', 'Missing fmt');
  assert(wav.slice(36, 40).toString() === 'data', 'Missing data');
});

test('WAV total size = 44 header + PCM data', () => {
  const sizes = [0, 160, 320, 8000, 16000];
  for (const s of sizes) {
    const pcm = Buffer.alloc(s);
    const wav = createWavBuffer(pcm, 8000);
    assert(wav.length === 44 + s, `Size ${s}: expected ${44 + s}, got ${wav.length}`);
  }
});

test('WAV encodes correct sample rate', () => {
  for (const rate of [8000, 16000, 44100]) {
    const wav = createWavBuffer(Buffer.alloc(100), rate);
    assert(wav.readUInt32LE(24) === rate, `Rate mismatch for ${rate}`);
  }
});

test('WAV encodes PCM format (1) and mono (1 channel)', () => {
  const wav = createWavBuffer(Buffer.alloc(100), 8000);
  assert(wav.readUInt16LE(20) === 1, 'Format not PCM');
  assert(wav.readUInt16LE(22) === 1, 'Not mono');
});

test('WAV encodes 16-bit depth', () => {
  const wav = createWavBuffer(Buffer.alloc(100), 8000);
  assert(wav.readUInt16LE(34) === 16, 'Not 16-bit');
});

test('WAV data chunk size matches PCM length', () => {
  const pcm = Buffer.alloc(5000);
  const wav = createWavBuffer(pcm, 8000);
  assert(wav.readUInt32LE(40) === 5000, 'Data size mismatch');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== TTS → Twilio Resampling ===');

test('24kHz → 8kHz is 3:1 ratio', () => {
  const pcm24 = Buffer.alloc(7200 * 2); // 7200 samples at 24kHz = 0.3s
  for (let i = 0; i < 7200; i++) pcm24.writeInt16LE(1000, i * 2);
  const mulaw = ttsToTwilio(pcm24);
  assert(mulaw.length === 2400, `Expected 2400, got ${mulaw.length}`);
});

test('empty input returns empty buffer', () => {
  assert(ttsToTwilio(Buffer.alloc(0)).length === 0);
  assert(ttsToTwilio(Buffer.alloc(4)).length === 0);  // < 6 bytes
});

test('resampled audio is valid mulaw (0–255)', () => {
  const pcm24 = Buffer.alloc(240 * 2);
  for (let i = 0; i < 240; i++) pcm24.writeInt16LE(Math.round(Math.sin(i * 0.1) * 10000), i * 2);
  const mulaw = ttsToTwilio(pcm24);
  for (let i = 0; i < mulaw.length; i++) {
    assert(mulaw[i] >= 0 && mulaw[i] <= 255, `Byte ${i} out of range`);
  }
});

test('low-pass filter reduces aliasing (averaged output)', () => {
  // Create a signal and verify the output is averaged, not just decimated
  const pcm24 = Buffer.alloc(9 * 2);
  pcm24.writeInt16LE(300, 0);
  pcm24.writeInt16LE(600, 2);
  pcm24.writeInt16LE(900, 4);
  pcm24.writeInt16LE(1200, 6);
  pcm24.writeInt16LE(1500, 8);
  pcm24.writeInt16LE(1800, 10);
  pcm24.writeInt16LE(2100, 12);
  pcm24.writeInt16LE(2400, 14);
  pcm24.writeInt16LE(2700, 16);
  const mulaw = ttsToTwilio(pcm24);
  assert(mulaw.length === 3, `Expected 3 output samples, got ${mulaw.length}`);
  // First output = avg(300,600,900) = 600 → should decode close to 600
  const decoded = mulawToLinear(mulaw[0]);
  assert(Math.abs(decoded - 600) < 100, `Expected ~600, got ${decoded}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Energy / VAD ===');

test('silence has near-zero energy', () => {
  const s = generateSilence(100);
  assert(calculateEnergy(s) < 5, 'Silence should have near-zero energy');
});

test('loud signal has high energy', () => {
  const buf = Buffer.alloc(160);
  for (let i = 0; i < 160; i++) buf[i] = linearToMulaw(10000);
  assert(calculateEnergy(buf) > 5000, 'Should be high energy');
});

test('empty buffer reports 0 energy', () => {
  assert(calculateEnergy(Buffer.alloc(0)) === 0);
});

test('energy scales with amplitude', () => {
  const quiet = Buffer.alloc(100);
  const loud  = Buffer.alloc(100);
  for (let i = 0; i < 100; i++) {
    quiet[i] = linearToMulaw(500);
    loud[i]  = linearToMulaw(15000);
  }
  assert(calculateEnergy(loud) > calculateEnergy(quiet), 'Loud should have more energy');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Silence Generation ===');

test('100ms at 8kHz = 800 bytes', () => {
  assert(generateSilence(100).length === 800);
});

test('0ms generates empty buffer', () => {
  assert(generateSilence(0).length === 0);
});

test('1000ms at 8kHz = 8000 bytes', () => {
  assert(generateSilence(1000).length === 8000);
});

test('silence bytes are consistent', () => {
  const s = generateSilence(50);
  const expected = linearToMulaw(0);
  for (let i = 0; i < s.length; i++) {
    assert(s[i] === expected, `Byte ${i} is ${s[i]}, expected ${expected}`);
  }
});

// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Audio Utils: ${pass}/${total} passed, ${fail} failed`);
console.log('═'.repeat(50));

module.exports = { pass, fail, total };
