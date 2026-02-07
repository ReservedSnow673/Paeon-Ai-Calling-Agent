// ─────────────────────────────────────────────────────────────
// audioUtils.js — Mulaw ↔ PCM ↔ WAV conversion + VAD helpers
// Production-ready with proper resampling (low-pass + decimation)
// ─────────────────────────────────────────────────────────────

'use strict';

const MULAW_BIAS = 0x84;
const MULAW_MAX  = 32635;

// ── Mulaw codec ──────────────────────────────────────────────

/** Encode a signed 16-bit linear PCM sample → 8-bit mu-law byte */
function linearToMulaw(sample) {
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;

  let exponent = 7;
  let mask = 0x4000;
  while (!(sample & mask) && exponent > 0) { exponent--; mask >>= 1; }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode an 8-bit mu-law byte → signed 16-bit linear PCM sample */
function mulawToLinear(mulawByte) {
  mulawByte = ~mulawByte & 0xff;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

// ── Buffer conversions ───────────────────────────────────────

/** Mulaw buffer → 16-bit PCM buffer (little-endian) */
function mulawToPcm(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(mulawToLinear(mulawBuf[i]), i * 2);
  }
  return pcm;
}

/** 16-bit PCM buffer → Mulaw buffer */
function pcmToMulaw(pcmBuf) {
  const samples = pcmBuf.length / 2;
  const mulaw = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    mulaw[i] = linearToMulaw(pcmBuf.readInt16LE(i * 2));
  }
  return mulaw;
}

// ── WAV creation ─────────────────────────────────────────────

/** Wrap raw 16-bit PCM in a minimal WAV header */
function createWavBuffer(pcmBuf, sampleRate = 8000) {
  const ch = 1, bits = 16;
  const byteRate   = sampleRate * ch * (bits / 8);
  const blockAlign = ch * (bits / 8);
  const dataSize   = pcmBuf.length;

  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);           // PCM format
  wav.writeUInt16LE(ch, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bits, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuf.copy(wav, 44);
  return wav;
}

// ── TTS → Twilio conversion (24 kHz → 8 kHz with low-pass) ─

/**
 * Simple 3-tap averaging low-pass filter + 3:1 decimation.
 * Converts OpenAI TTS output (24 kHz 16-bit PCM) to Twilio mulaw (8 kHz).
 * The filter prevents aliasing artifacts during downsampling.
 */
function ttsToTwilio(pcm24k) {
  if (!pcm24k || pcm24k.length < 6) return Buffer.alloc(0);

  const inSamples  = pcm24k.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  const mulaw      = Buffer.alloc(outSamples);

  for (let i = 0; i < outSamples; i++) {
    const base = i * 3;
    // Read 3 neighboring samples and average (simple box filter)
    const s0 = pcm24k.readInt16LE(base * 2);
    const s1 = (base + 1) < inSamples ? pcm24k.readInt16LE((base + 1) * 2) : s0;
    const s2 = (base + 2) < inSamples ? pcm24k.readInt16LE((base + 2) * 2) : s1;
    const avg = Math.round((s0 + s1 + s2) / 3);
    // Clamp to 16-bit range
    const clamped = Math.max(-32768, Math.min(32767, avg));
    mulaw[i] = linearToMulaw(clamped);
  }
  return mulaw;
}

// ── VAD / energy ─────────────────────────────────────────────

/** RMS energy of a mulaw buffer (linear domain) */
function calculateEnergy(mulawBuf) {
  if (!mulawBuf || mulawBuf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < mulawBuf.length; i++) {
    const s = mulawToLinear(mulawBuf[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / mulawBuf.length);
}

/** Generate N ms of mulaw silence at given sample rate */
function generateSilence(ms, sampleRate = 8000) {
  const n = Math.floor((ms / 1000) * sampleRate);
  const silenceValue = linearToMulaw(0);
  const buf = Buffer.alloc(n);
  buf.fill(silenceValue);
  return buf;
}

module.exports = {
  linearToMulaw,
  mulawToLinear,
  mulawToPcm,
  pcmToMulaw,
  createWavBuffer,
  ttsToTwilio,
  calculateEnergy,
  generateSilence,
};
