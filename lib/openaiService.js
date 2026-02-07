// ─────────────────────────────────────────────────────────────
// openaiService.js — All OpenAI API calls (STT / LLM / TTS)
// Production-ready: retries, timeouts, proper Whisper lang mapping
// ─────────────────────────────────────────────────────────────

'use strict';

const OpenAI = require('openai');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Retry / timeout config ──────────────────────────────────

const MAX_RETRIES         = 2;
const RETRY_BASE_MS       = 600;
const STT_TIMEOUT_MS      = 15_000;
const LLM_TIMEOUT_MS      = 15_000;
const TTS_TIMEOUT_MS      = 20_000;
const TRANSLATE_TIMEOUT_MS = 10_000;

// ── Product context (injected into every LLM call) ──────────

let productInfo;
try {
  productInfo = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'product-info.txt'),
    'utf-8',
  );
  console.log(`[openai] Product info loaded (${productInfo.length} chars)`);
} catch (err) {
  console.error('FATAL: Cannot read data/product-info.txt —', err.message);
  process.exit(1);
}

const SYSTEM_PROMPT = `You are a medical information representative for a pharmaceutical product. You provide scientific and administrative information to healthcare professionals (HCPs) over the phone.

CRITICAL RULES — FOLLOW EVERY SINGLE ONE:
1. ONLY use information from the PRODUCT INFORMATION section below. If the answer is not there, say: "That information is not specified in the publicly available product information I have access to."
2. Keep responses to 1–3 short, natural sentences — you are speaking on a phone call.
3. Use a professional, warm, knowledgeable tone.
4. Ask a brief clarifying question when the query is ambiguous.
5. End your answer with a short follow-up, e.g. "Would you like more detail on that?" or "Is there anything else I can help with?"
6. ALWAYS keep drug names, mechanism names, clinical-trial names, dosages, and units in English regardless of conversation language.
7. NEVER mention AI, language models, prompts, translation, or any technology.
8. NEVER make claims not supported by the product documents.
9. NEVER discuss off-label uses or give patient-specific medical advice.
10. Prefer saying less over saying something wrong.
11. If asked who you are, say you are a medical information representative.
12. Do NOT use bullet points, numbered lists, markdown, asterisks, or any text formatting — speak naturally as a human on the phone.
13. Do NOT start responses with filler like "Great question!" — get to the point.

PRODUCT INFORMATION:
---
${productInfo}
---`;

// ──────────────────────────────────────────────────────────────
// Whisper language name → ISO-639-1 mapping
//
// IMPORTANT: Whisper's verbose_json response returns the FULL
// language name (e.g. "english", "hindi") — NOT ISO codes.
// We must map them to ISO-639-1 for consistent internal use.
// ──────────────────────────────────────────────────────────────

const WHISPER_LANG_TO_ISO = {
  english: 'en', hindi: 'hi', spanish: 'es', french: 'fr',
  german: 'de', portuguese: 'pt', chinese: 'zh', japanese: 'ja',
  korean: 'ko', arabic: 'ar', russian: 'ru', italian: 'it',
  dutch: 'nl', polish: 'pl', turkish: 'tr', vietnamese: 'vi',
  thai: 'th', bengali: 'bn', tamil: 'ta', telugu: 'te',
  marathi: 'mr', gujarati: 'gu', urdu: 'ur', punjabi: 'pa',
  indonesian: 'id', malay: 'ms', czech: 'cs', romanian: 'ro',
  hungarian: 'hu', greek: 'el', swedish: 'sv', danish: 'da',
  finnish: 'fi', norwegian: 'no', hebrew: 'he', persian: 'fa',
  ukrainian: 'uk', catalan: 'ca', slovak: 'sk', croatian: 'hr',
  serbian: 'sr', bulgarian: 'bg', slovenian: 'sl', latvian: 'lv',
  lithuanian: 'lt', estonian: 'et', swahili: 'sw', nepali: 'ne',
  sinhala: 'si', afrikaans: 'af', tagalog: 'tl', welsh: 'cy',
  macedonian: 'mk', icelandic: 'is', azerbaijani: 'az',
  kazakh: 'kk', uzbek: 'uz', georgian: 'ka', armenian: 'hy',
  albanian: 'sq', bosnian: 'bs', galician: 'gl', basque: 'eu',
  belarusian: 'be', mongolian: 'mn', burmese: 'my', lao: 'lo',
  khmer: 'km', amharic: 'am', yoruba: 'yo', somali: 'so',
  zulu: 'zu', javanese: 'jv', sundanese: 'su',
};

function whisperLangToIso(whisperLang) {
  if (!whisperLang) return 'en';
  const lower = whisperLang.toLowerCase().trim();
  // Whisper may occasionally return a bare ISO code
  if (lower.length <= 3 && !WHISPER_LANG_TO_ISO[lower]) return lower;
  return WHISPER_LANG_TO_ISO[lower] || 'en';
}

// ── ISO code → display name ─────────────────────────────────

const ISO_TO_NAME = Object.fromEntries(
  Object.entries(WHISPER_LANG_TO_ISO).map(([name, code]) => [
    code,
    name.charAt(0).toUpperCase() + name.slice(1),
  ]),
);

function getLanguageName(code) {
  return ISO_TO_NAME[code] || code;
}

// ── Retry + timeout helper ───────────────────────────────────

async function withRetry(fn, label, timeoutMs) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const isRetryable = status === 429 || (status && status >= 500) ||
                          err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
                          err.message?.includes('timed out');
      if (attempt < MAX_RETRIES && isRetryable) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[retry] ${label} attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

// ── Speech-to-Text (Whisper) ─────────────────────────────────

/**
 * Transcribe a WAV buffer.
 * Returns { text, detectedLang } where detectedLang is ISO-639-1.
 */
async function transcribe(wavBuffer) {
  if (!wavBuffer || wavBuffer.length < 100) {
    return { text: '', detectedLang: 'en' };
  }

  // Unique temp file per call to avoid race conditions
  const tmp = path.join(os.tmpdir(), `stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(tmp, wavBuffer);

  try {
    const result = await withRetry(() => {
      return openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: 'whisper-1',
        response_format: 'verbose_json',
      });
    }, 'STT', STT_TIMEOUT_MS);

    const detectedLang = whisperLangToIso(result.language);
    return { text: (result.text || '').trim(), detectedLang };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

// ── Translation ──────────────────────────────────────────────

async function translate(text, fromLang, toLang) {
  if (!text || !text.trim()) return '';
  if (fromLang === toLang) return text;

  const result = await withRetry(() => {
    return openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content: `You are a professional medical translator. Translate the following text from ${fromLang} to ${toLang}.
Rules:
- Keep drug names, mechanism names, clinical trial names, dosages, and units in English.
- Translate naturally, not literally.
- Maintain the professional medical tone.
- Output ONLY the translation — no explanation, no quotes, no extra text.`,
        },
        { role: 'user', content: text },
      ],
    });
  }, 'translate', TRANSLATE_TIMEOUT_MS);

  return result.choices[0].message.content.trim();
}

// ── LLM Reasoning ────────────────────────────────────────────

async function reason(query, conversationHistory = []) {
  if (!query || !query.trim()) return "I didn't catch that. Could you repeat your question?";

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversationHistory.slice(-20),
    { role: 'user', content: query },
  ];

  const result = await withRetry(() => {
    return openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 300,
      messages,
    });
  }, 'LLM', LLM_TIMEOUT_MS);

  return result.choices[0].message.content.trim();
}

// ── Text-to-Speech ───────────────────────────────────────────

const MAX_TTS_LENGTH = 4096;   // OpenAI TTS hard limit

/**
 * Synthesize text → raw PCM buffer (24 kHz, 16-bit LE, mono).
 */
async function synthesize(text, voice = 'nova') {
  if (!text || !text.trim()) return Buffer.alloc(0);

  const input = text.length > MAX_TTS_LENGTH
    ? text.slice(0, MAX_TTS_LENGTH - 3) + '...'
    : text;

  const response = await withRetry(() => {
    return openai.audio.speech.create({
      model: 'tts-1',
      voice,
      input,
      response_format: 'pcm',
    });
  }, 'TTS', TTS_TIMEOUT_MS);

  return Buffer.from(await response.arrayBuffer());
}

module.exports = {
  transcribe,
  translate,
  reason,
  synthesize,
  getLanguageName,
  whisperLangToIso,
};
