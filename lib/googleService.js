// ─────────────────────────────────────────────────────────────
// googleService.js — All Google Cloud API calls (STT / LLM / TTS / Translate)
//
// Replaces openaiService.js with Google Cloud equivalents:
//   • Speech-to-Text:  @google-cloud/speech
//     https://cloud.google.com/speech-to-text/docs
//   • Translation:     @google-cloud/translate (Basic v2)
//     https://cloud.google.com/translate/docs
//   • LLM reasoning:   Gemini via @google-cloud/vertexai
//     https://cloud.google.com/vertex-ai/docs/generative-ai
//   • Text-to-Speech:  @google-cloud/text-to-speech
//     https://cloud.google.com/text-to-speech/docs
//
// Auth: uses GOOGLE_APPLICATION_CREDENTIALS (service account JSON)
// or Application Default Credentials (ADC).
// https://cloud.google.com/docs/authentication/application-default-credentials
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Google Cloud SDKs ────────────────────────────────────────

// Speech-to-Text — batch recognition (accepts raw mulaw buffer)
// https://cloud.google.com/speech-to-text/docs/streaming-recognize
const speech = require('@google-cloud/speech');
const sttClient = new speech.SpeechClient();

// Translation — Basic (v2), uses ISO-639-1 codes natively
// https://cloud.google.com/translate/docs/advanced/translate-text
const { Translate } = require('@google-cloud/translate').v2;
const translateClient = new Translate({
  projectId: process.env.GOOGLE_PROJECT_ID,
});

// Text-to-Speech — returns mulaw 8kHz directly (no resampling needed)
// https://cloud.google.com/text-to-speech/docs
const tts = require('@google-cloud/text-to-speech');
const ttsClient = new tts.TextToSpeechClient();

// Gemini via Vertex AI — generative LLM reasoning
// https://cloud.google.com/vertex-ai/docs/generative-ai/model-reference
// https://cloud.google.com/vertex-ai/docs/start/client-libraries
const { VertexAI } = require('@google-cloud/vertexai');
const vertexAI = new VertexAI({
  project:  process.env.GOOGLE_PROJECT_ID,
  location: process.env.GOOGLE_LOCATION || 'us-central1',
});
const geminiModel = vertexAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  generationConfig: {
    temperature: 0.4,
    maxOutputTokens: 400,
  },
});

// ── Retry / timeout config ──────────────────────────────────

const MAX_RETRIES          = 2;
const RETRY_BASE_MS        = 600;
const STT_TIMEOUT_MS       = 15_000;
const LLM_TIMEOUT_MS       = 15_000;
const TTS_TIMEOUT_MS       = 20_000;
const TRANSLATE_TIMEOUT_MS = 10_000;

// ── Product context (injected into every LLM call) ──────────

let productInfo;
try {
  productInfo = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'product-info.txt'),
    'utf-8',
  );
  console.log(`[google] Product info loaded (${productInfo.length} chars)`);
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

// ── ISO code → display name ─────────────────────────────────
// Preserved from original codebase for getLanguageName() compatibility.

const ISO_TO_NAME = {
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French',
  de: 'German', pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', ar: 'Arabic', ru: 'Russian', it: 'Italian',
  nl: 'Dutch', pl: 'Polish', tr: 'Turkish', vi: 'Vietnamese',
  th: 'Thai', bn: 'Bengali', ta: 'Tamil', te: 'Telugu',
  mr: 'Marathi', gu: 'Gujarati', ur: 'Urdu', pa: 'Punjabi',
  id: 'Indonesian', ms: 'Malay', cs: 'Czech', ro: 'Romanian',
  hu: 'Hungarian', el: 'Greek', sv: 'Swedish', da: 'Danish',
  fi: 'Finnish', no: 'Norwegian', he: 'Hebrew', fa: 'Persian',
  uk: 'Ukrainian', ca: 'Catalan', sk: 'Slovak', hr: 'Croatian',
  sr: 'Serbian', bg: 'Bulgarian', sl: 'Slovenian', lv: 'Latvian',
  lt: 'Lithuanian', et: 'Estonian', sw: 'Swahili', ne: 'Nepali',
  si: 'Sinhala', af: 'Afrikaans', tl: 'Tagalog', cy: 'Welsh',
};

function getLanguageName(code) {
  return ISO_TO_NAME[code] || code;
}

// ── Google Cloud TTS voice map ───────────────────────────────
// Maps ISO-639-1 codes to Google Cloud TTS voice names.
// Using Neural2 / Studio voices for highest quality.
// Full voice list: https://cloud.google.com/text-to-speech/docs/voices

const VOICE_MAP = {
  en: { languageCode: 'en-US', name: 'en-US-Neural2-F',  ssmlGender: 'FEMALE' },
  hi: { languageCode: 'hi-IN', name: 'hi-IN-Neural2-A',  ssmlGender: 'FEMALE' },
  es: { languageCode: 'es-ES', name: 'es-ES-Neural2-A',  ssmlGender: 'FEMALE' },
  fr: { languageCode: 'fr-FR', name: 'fr-FR-Neural2-A',  ssmlGender: 'FEMALE' },
  de: { languageCode: 'de-DE', name: 'de-DE-Neural2-A',  ssmlGender: 'FEMALE' },
  pt: { languageCode: 'pt-BR', name: 'pt-BR-Neural2-A',  ssmlGender: 'FEMALE' },
  ja: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B',  ssmlGender: 'FEMALE' },
  ko: { languageCode: 'ko-KR', name: 'ko-KR-Neural2-A',  ssmlGender: 'FEMALE' },
  ar: { languageCode: 'ar-XA', name: 'ar-XA-Neural2-A',  ssmlGender: 'FEMALE' },
  zh: { languageCode: 'cmn-CN', name: 'cmn-CN-Neural2-A', ssmlGender: 'FEMALE' },
  ru: { languageCode: 'ru-RU', name: 'ru-RU-Neural2-A',  ssmlGender: 'FEMALE' },
  it: { languageCode: 'it-IT', name: 'it-IT-Neural2-A',  ssmlGender: 'FEMALE' },
  bn: { languageCode: 'bn-IN', name: 'bn-IN-Standard-A', ssmlGender: 'FEMALE' },
  ta: { languageCode: 'ta-IN', name: 'ta-IN-Standard-A', ssmlGender: 'FEMALE' },
  te: { languageCode: 'te-IN', name: 'te-IN-Standard-A', ssmlGender: 'FEMALE' },
  gu: { languageCode: 'gu-IN', name: 'gu-IN-Standard-A', ssmlGender: 'FEMALE' },
  mr: { languageCode: 'mr-IN', name: 'mr-IN-Standard-A', ssmlGender: 'FEMALE' },
  tr: { languageCode: 'tr-TR', name: 'tr-TR-Neural2-A',  ssmlGender: 'FEMALE' },
  pl: { languageCode: 'pl-PL', name: 'pl-PL-Neural2-A',  ssmlGender: 'FEMALE' },
  nl: { languageCode: 'nl-NL', name: 'nl-NL-Neural2-A',  ssmlGender: 'FEMALE' },
  vi: { languageCode: 'vi-VN', name: 'vi-VN-Neural2-A',  ssmlGender: 'FEMALE' },
  th: { languageCode: 'th-TH', name: 'th-TH-Neural2-C',  ssmlGender: 'FEMALE' },
};

// Fallback: English voice if language not in map
const DEFAULT_VOICE = VOICE_MAP.en;

// ── Google STT language config ───────────────────────────────
// Primary language + alternatives for auto-detection.
// Google STT uses BCP-47 codes (e.g. 'en-US', 'hi-IN').
// https://cloud.google.com/speech-to-text/docs/languages

const STT_PRIMARY_LANG = 'en-US';
const STT_ALT_LANGS = [
  'hi-IN', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR',
  'ja-JP', 'ko-KR', 'ar-SA', 'zh', 'ru-RU',
  'it-IT', 'ta-IN', 'te-IN', 'bn-IN', 'mr-IN',
  'gu-IN', 'ur-PK', 'pa-IN', 'tr-TR', 'vi-VN',
];

/**
 * Extract ISO-639-1 code from a BCP-47 language tag.
 * e.g. 'hi-IN' → 'hi', 'en-US' → 'en', 'zh' → 'zh'
 */
function bcp47ToIso(bcp47) {
  if (!bcp47) return 'en';
  // Handle special case: 'cmn-CN' → 'zh'
  if (bcp47.startsWith('cmn')) return 'zh';
  return bcp47.split('-')[0].toLowerCase();
}

// ── Retry + timeout helper ───────────────────────────────────
// Adapted for Google Cloud error codes (gRPC status codes).

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
      // Google Cloud gRPC error codes:
      // 8 = RESOURCE_EXHAUSTED (rate limit), 14 = UNAVAILABLE, 4 = DEADLINE_EXCEEDED
      const code = err?.code;
      const isRetryable = code === 8 || code === 14 || code === 4 ||
                          code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
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

// ── Speech-to-Text (Google Cloud Speech) ─────────────────────
// Accepts raw mulaw buffer directly — no temp files, no WAV conversion.
// https://cloud.google.com/speech-to-text/docs/sync-recognize

/**
 * Transcribe a mulaw audio buffer.
 * Returns { text, detectedLang } where detectedLang is ISO-639-1.
 *
 * Key difference from OpenAI Whisper:
 * - Accepts raw mulaw bytes (no WAV header needed)
 * - Uses alternative_language_codes for auto-detection
 * - Returns BCP-47 language code, converted to ISO-639-1
 */
async function transcribe(mulawBuffer) {
  if (!mulawBuffer || mulawBuffer.length < 100) {
    return { text: '', detectedLang: 'en' };
  }

  const result = await withRetry(async () => {
    const [response] = await sttClient.recognize({
      audio: {
        // Send raw mulaw bytes directly — no temp file needed
        content: mulawBuffer.toString('base64'),
      },
      config: {
        // Twilio sends mulaw 8kHz mono — match exactly
        encoding: 'MULAW',
        sampleRateHertz: 8000,
        languageCode: STT_PRIMARY_LANG,
        // Enable multi-language auto-detection
        // https://cloud.google.com/speech-to-text/docs/multiple-languages
        alternativeLanguageCodes: STT_ALT_LANGS,
        // Use 'latest_long' model — supports alternativeLanguageCodes
        // ('phone_call' enhanced model does NOT support multi-language)
        model: 'latest_long',
        // Return detected language per result
        enableAutomaticPunctuation: true,
      },
    });
    return response;
  }, 'STT', STT_TIMEOUT_MS);

  // Extract transcription text and detected language
  const firstResult = result.results?.[0];
  if (!firstResult || !firstResult.alternatives?.[0]) {
    return { text: '', detectedLang: 'en' };
  }

  const text = firstResult.alternatives[0].transcript?.trim() || '';
  // Google returns BCP-47 (e.g. 'hi-IN') in languageCode field
  const detectedBcp47 = firstResult.languageCode || STT_PRIMARY_LANG;
  const detectedLang = bcp47ToIso(detectedBcp47);

  return { text, detectedLang };
}

// ── Translation (Google Cloud Translation API v2) ────────────
// Uses ISO-639-1 codes directly (e.g. 'en', 'hi').
// Simpler and faster than LLM-based translation.
// https://cloud.google.com/translate/docs/basic/translating-text

/**
 * Translate text between languages.
 * @param {string} text — text to translate
 * @param {string} fromLang — ISO-639-1 source language code (e.g. 'en')
 * @param {string} toLang — ISO-639-1 target language code (e.g. 'hi')
 * @returns {string} translated text
 */
async function translate(text, fromLang, toLang) {
  if (!text || !text.trim()) return '';
  if (fromLang === toLang) return text;

  const result = await withRetry(async () => {
    const [translation] = await translateClient.translate(text, {
      from: fromLang,
      to: toLang,
    });
    return translation;
  }, 'translate', TRANSLATE_TIMEOUT_MS);

  return result;
}

// ── LLM Reasoning (Gemini via Vertex AI) ─────────────────────
// Uses Gemini 2.0 Flash for lowest latency in real-time voice.
// System prompt with injected product docs for grounded answers.
// https://cloud.google.com/vertex-ai/docs/generative-ai/model-reference

async function reason(query, conversationHistory = []) {
  if (!query || !query.trim()) return "I didn't catch that. Could you repeat your question?";

  // Build Gemini content array from conversation history.
  // Gemini uses 'user' and 'model' roles (not 'assistant').
  const contents = [];

  for (const msg of conversationHistory.slice(-20)) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  // Add current user query
  contents.push({
    role: 'user',
    parts: [{ text: query }],
  });

  const result = await withRetry(async () => {
    // Start chat with system instruction and history
    const chat = geminiModel.startChat({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      history: contents.slice(0, -1), // all except the last (current query)
    });

    const response = await chat.sendMessage(contents[contents.length - 1].parts);
    return response;
  }, 'LLM', LLM_TIMEOUT_MS);

  // Extract text from Gemini response
  const responseText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
  return (responseText || "I'm sorry, could you repeat that?").trim();
}

// ── Text-to-Speech (Google Cloud TTS) ────────────────────────
// Returns mulaw 8kHz audio directly — no resampling needed.
// This eliminates the 24kHz→8kHz conversion step entirely.
// https://cloud.google.com/text-to-speech/docs/create-audio

const MAX_TTS_LENGTH = 5000; // Google TTS limit per request

/**
 * Synthesize text → mulaw audio buffer (8 kHz, mono).
 * @param {string} text — text to speak
 * @param {string} langCode — ISO-639-1 language code (e.g. 'en', 'hi')
 * @returns {Buffer} mulaw audio buffer ready for Twilio
 */
async function synthesize(text, langCode = 'en') {
  if (!text || !text.trim()) return Buffer.alloc(0);

  const input = text.length > MAX_TTS_LENGTH
    ? text.slice(0, MAX_TTS_LENGTH - 3) + '...'
    : text;

  // Select voice for the caller's language
  const voiceConfig = VOICE_MAP[langCode] || DEFAULT_VOICE;

  const result = await withRetry(async () => {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text: input },
      voice: {
        languageCode: voiceConfig.languageCode,
        name: voiceConfig.name,
        ssmlGender: voiceConfig.ssmlGender,
      },
      audioConfig: {
        // Output mulaw 8kHz directly — matches Twilio's expected format.
        // No intermediate PCM conversion or resampling needed.
        audioEncoding: 'MULAW',
        sampleRateHertz: 8000,
        // Slight speed boost for more natural phone conversation pace
        speakingRate: 1.0,
      },
    });
    return response;
  }, 'TTS', TTS_TIMEOUT_MS);

  // Google TTS returns audioContent as a Buffer (or Uint8Array)
  if (!result.audioContent) return Buffer.alloc(0);
  return Buffer.from(result.audioContent);
}

// ── Exports ──────────────────────────────────────────────────
// Same public interface as the original openaiService.js:
//   transcribe, translate, reason, synthesize, getLanguageName
// Plus bcp47ToIso for testing.

module.exports = {
  transcribe,
  translate,
  reason,
  synthesize,
  getLanguageName,
  bcp47ToIso,
  VOICE_MAP,
};
