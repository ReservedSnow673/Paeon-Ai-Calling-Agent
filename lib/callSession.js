// ─────────────────────────────────────────────────────────────
// callSession.js — Per-call state machine & voice pipeline
// Production-ready: proper state transitions, deadlock prevention,
// first-turn question preservation, interruption safety
// ─────────────────────────────────────────────────────────────

'use strict';

const {
  calculateEnergy,
  generateSilence,
} = require('./audioUtils');

// Google Cloud services replace OpenAI for STT, LLM, TTS, and translation.
// See lib/googleService.js for implementation details.
const {
  transcribe,
  translate,
  reason,
  synthesize,
  getLanguageName,
} = require('./googleService');

// ── Tunables ─────────────────────────────────────────────────

const ENERGY_THRESHOLD      = 180;   // min RMS to count as speech
const SILENCE_TRIGGER_MS    = 1500;  // silence duration to trigger processing
const MIN_SPEECH_MS         = 400;   // ignore sub-400ms bursts
const MIN_AUDIO_BYTES       = 2400;  // ~0.3 s at 8 kHz mulaw
const THINKING_PAUSE_MS     = 350;   // pause before AI speaks
const SAMPLE_RATE           = 8000;
const CHUNK_DURATION_MS     = 20;    // 20 ms per outbound Twilio chunk
const CHUNK_SIZE            = (SAMPLE_RATE * CHUNK_DURATION_MS) / 1000; // 160 bytes
const MAX_HISTORY           = 20;    // max conversation turns to keep
const MAX_UTTERANCE_SECONDS = 30;    // cap single utterance recording
const MAX_UTTERANCE_BYTES   = MAX_UTTERANCE_SECONDS * SAMPLE_RATE; // mulaw bytes
const SILENCE_CHECK_INTERVAL = 100;  // ms between silence checks while recording

// ── State enum ───────────────────────────────────────────────

const S = Object.freeze({
  IDLE:       'IDLE',
  GREETING:   'GREETING',
  LISTENING:  'LISTENING',
  RECORDING:  'RECORDING',
  PROCESSING: 'PROCESSING',
  SPEAKING:   'SPEAKING',
});

// ─────────────────────────────────────────────────────────────
// CallSession
// ─────────────────────────────────────────────────────────────

class CallSession {
  constructor(ws, streamSid, callSid) {
    this.ws        = ws;
    this.streamSid = streamSid;
    this.callSid   = callSid;

    // State
    this.state       = S.IDLE;
    this.audioBuffer = [];
    this.audioBytes  = 0;       // running count for cap
    this.silenceAt   = null;
    this.speechAt    = null;

    // Language & conversation
    this.lang       = null;     // ISO-639-1 detected language
    this.history    = [];       // conversation turns (EN only for LLM)
    this.firstTurn  = true;
    this.turnCount  = 0;

    // Interruption handling
    this.interrupted   = false;
    this.speakingAbort = null;  // AbortController for current speak()

    // Timing
    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();

    // Silence check timer
    this._silenceTimer = null;

    this.log('Session created');
  }

  // ── Lifecycle ────────────────────────────────────────────

  async start() {
    this.state = S.GREETING;
    this.log('Sending greeting');

    try {
      await this.speak(
        'Hello! Welcome to the medical information service. '
        + 'Please go ahead, you may speak in any language you are comfortable with.',
      );
    } catch (e) {
      this.log(`Greeting error: ${e.message}`);
    }
    this._transitionTo(S.LISTENING);
  }

  stop() {
    this._transitionTo(S.IDLE);
    this.audioBuffer = [];
    this.history = [];
    this._clearSilenceTimer();
    if (this.speakingAbort) this.speakingAbort.abort();
    const durationSec = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.log(`Session ended after ${durationSec}s, ${this.turnCount} turns`);
  }

  // ── Inbound audio (from Twilio) ─────────────────────────

  handleAudio(base64) {
    if (this.state === S.IDLE || this.state === S.GREETING) return;
    this.lastActivityAt = Date.now();

    const chunk  = Buffer.from(base64, 'base64');
    const energy = calculateEnergy(chunk);

    // ── While AI is speaking: detect interruption ──
    if (this.state === S.SPEAKING) {
      if (energy > ENERGY_THRESHOLD * 1.5) {
        this.log('Caller interrupted AI');
        this._interruptSpeaking();
        this.state       = S.RECORDING;
        this.audioBuffer = [chunk];
        this.audioBytes  = chunk.length;
        this.speechAt    = Date.now();
        this.silenceAt   = null;
        this._startSilenceTimer();
      }
      return;
    }

    // ── While processing: stash overflow audio ──
    if (this.state === S.PROCESSING) {
      if (energy > ENERGY_THRESHOLD) {
        this.audioBuffer.push(chunk);
        this.audioBytes += chunk.length;
      }
      return;
    }

    // ── LISTENING / RECORDING ──────────────────────
    if (energy > ENERGY_THRESHOLD) {
      if (this.state === S.LISTENING) {
        this._transitionTo(S.RECORDING);
        this.audioBuffer = [];
        this.audioBytes  = 0;
        this.speechAt    = Date.now();
        this._startSilenceTimer();
        this.log('Speech start');
      }
      this.audioBuffer.push(chunk);
      this.audioBytes += chunk.length;
      this.silenceAt = null;

      // Safety: cap utterance length
      if (this.audioBytes > MAX_UTTERANCE_BYTES) {
        this.log('Utterance cap reached — processing');
        this._clearSilenceTimer();
        this._processUtterance();
      }
    } else if (this.state === S.RECORDING) {
      this.audioBuffer.push(chunk);
      this.audioBytes += chunk.length;
      if (!this.silenceAt) this.silenceAt = Date.now();
    }
  }

  // ── Mark callback (sent by Twilio when our audio finishes) ─

  handleMark(name) {
    this.log(`Mark: ${name}`);
    if (this.state === S.SPEAKING && !this.interrupted) {
      this._transitionTo(S.LISTENING);
      this.log('Playback done → listening');
    }
  }

  // ── Silence timer ────────────────────────────────────────

  _startSilenceTimer() {
    this._clearSilenceTimer();
    this._silenceTimer = setInterval(() => {
      if (this.state !== S.RECORDING) {
        this._clearSilenceTimer();
        return;
      }
      if (!this.silenceAt) return;

      const silenceMs = Date.now() - this.silenceAt;
      const speechMs  = Date.now() - this.speechAt;

      if (silenceMs >= SILENCE_TRIGGER_MS && speechMs >= MIN_SPEECH_MS) {
        this.log(`Turn end (${speechMs}ms speech, ${silenceMs}ms silence)`);
        this._clearSilenceTimer();
        this._processUtterance();
      }
    }, SILENCE_CHECK_INTERVAL);
  }

  _clearSilenceTimer() {
    if (this._silenceTimer) {
      clearInterval(this._silenceTimer);
      this._silenceTimer = null;
    }
  }

  // ── Core pipeline ────────────────────────────────────────

  async _processUtterance() {
    if (this.state === S.PROCESSING) return;
    this._transitionTo(S.PROCESSING);

    try {
      // Grab + reset buffer
      const raw = Buffer.concat(this.audioBuffer);
      this.audioBuffer = [];
      this.audioBytes  = 0;
      this.silenceAt   = null;

      if (raw.length < MIN_AUDIO_BYTES) {
        this.log(`Audio too short (${raw.length} bytes) — skipping`);
        this._transitionTo(S.LISTENING);
        return;
      }

      // 1. STT ───────────────────────────────────────────────
      // Google Cloud Speech accepts mulaw directly — no WAV conversion needed.
      this.log(`STT: ${raw.length} mulaw bytes`);

      const { text, detectedLang } = await transcribe(raw);

      if (!text) {
        this.log('Empty transcription — skipping');
        this._transitionTo(S.LISTENING);
        return;
      }
      this.log(`STT: "${text}" [${detectedLang}]`);

      // 2. Language detection (first turn) ───────────────────
      if (this.firstTurn) {
        this.lang = detectedLang || 'en';
        this.firstTurn = false;
        const langName = getLanguageName(this.lang);
        this.log(`Language locked: ${langName} (${this.lang})`);

        if (this.lang !== 'en') {
          // Confirm language to caller, BUT don't throw away their question.
          // We'll prepend the language confirmation and then answer the question.
          const confirmEN = `I will be speaking with you in ${langName}. Let me answer your question.`;
          // translate() now uses ISO-639-1 codes (e.g. 'en', 'hi')
          const confirmLocal = await translate(confirmEN, 'en', this.lang);
          await this.speak(confirmLocal);
          // Fall through to process their actual question below
        }
      }

      // 3. Translate query → English ─────────────────────────
      let queryEN = text;
      if (this.lang && this.lang !== 'en') {
        // Google Translation API uses ISO codes directly
        queryEN = await translate(text, this.lang, 'en');
        this.log(`Translated query: "${queryEN}"`);
      }

      // 4. LLM reasoning (always in English context) ─────────
      this.log('LLM reasoning...');
      const answerEN = await reason(queryEN, this.history);
      this.log(`LLM: "${answerEN.slice(0, 120)}${answerEN.length > 120 ? '...' : ''}"`);

      // 5. Save to conversation history
      this.history.push(
        { role: 'user',      content: queryEN },
        { role: 'assistant', content: answerEN },
      );
      if (this.history.length > MAX_HISTORY) {
        this.history = this.history.slice(-MAX_HISTORY);
      }

      // 6. Translate answer → caller language ────────────────
      let answerLocal = answerEN;
      if (this.lang && this.lang !== 'en') {
        // Google Translation API uses ISO codes directly
        answerLocal = await translate(answerEN, 'en', this.lang);
        this.log(`Translated answer: "${answerLocal.slice(0, 120)}..."`);
      }

      // 7. TTS → caller ─────────────────────────────────────
      this.turnCount++;
      await this.speak(answerLocal);

      // If not interrupted during speak, go back to listening
      if (this.state === S.SPEAKING) {
        this._transitionTo(S.LISTENING);
      }

    } catch (err) {
      this.log(`Pipeline error: ${err.message}`);
      await this._recoverGracefully();
    }
  }

  // ── TTS → Twilio output ──────────────────────────────────

  async speak(text) {
    if (!text || this.ws.readyState !== 1) return;

    const previousState = this.state;
    this.state       = S.SPEAKING;
    this.interrupted = false;

    // Create per-speak abort controller
    this.speakingAbort = new AbortController();
    const { signal } = this.speakingAbort;

    try {
      // Brief thinking pause (feels more human)
      const silence = generateSilence(THINKING_PAUSE_MS);
      this._sendMulawChunks(silence, signal);

      if (signal.aborted) return;

      // Generate speech audio — Google TTS returns mulaw 8kHz directly.
      // No resampling or format conversion needed.
      const mulaw = await synthesize(text, this.lang || 'en');
      if (signal.aborted || this.interrupted) {
        this.log('Speak aborted before send');
        return;
      }

      if (mulaw.length === 0) {
        this.log('TTS returned empty audio');
        return;
      }

      // Send mulaw chunks directly to Twilio
      this._sendMulawChunks(mulaw, signal);

      if (!signal.aborted && !this.interrupted) {
        // Send a mark so Twilio tells us when playback finishes
        this._sendMark(`end-${Date.now()}`);
        this.log(`Sent ${mulaw.length} bytes audio to caller`);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        this.log(`TTS/speak error: ${e.message}`);
      }
      // Ensure we revert to a sane state on error
      if (this.state === S.SPEAKING) {
        this._transitionTo(S.LISTENING);
      }
    } finally {
      this.speakingAbort = null;
    }
  }

  // ── Interruption ─────────────────────────────────────────

  _interruptSpeaking() {
    this.interrupted = true;
    this._clearTwilioQueue();
    if (this.speakingAbort) this.speakingAbort.abort();
  }

  // ── Twilio transport ─────────────────────────────────────

  _sendMulawChunks(buf, signal) {
    if (!buf || buf.length === 0) return;
    for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
      if ((signal && signal.aborted) || this.interrupted || this.ws.readyState !== 1) break;
      const end = Math.min(i + CHUNK_SIZE, buf.length);
      const payload = buf.slice(i, end).toString('base64');
      this.ws.send(JSON.stringify({
        event:     'media',
        streamSid: this.streamSid,
        media:     { payload },
      }));
    }
  }

  _sendMark(name) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({
      event:     'mark',
      streamSid: this.streamSid,
      mark:      { name },
    }));
  }

  _clearTwilioQueue() {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({
      event:     'clear',
      streamSid: this.streamSid,
    }));
    this.log('Cleared Twilio playback queue');
  }

  // ── Error recovery ───────────────────────────────────────

  async _recoverGracefully() {
    try {
      let msg = "I'm sorry, I didn't quite catch that. Could you please repeat your question?";
      if (this.lang && this.lang !== 'en') {
        msg = await translate(msg, 'en', this.lang);
      }
      await this.speak(msg);
    } catch (e) {
      this.log(`Recovery also failed: ${e.message}`);
    }
    // Always return to listening regardless of recovery outcome
    this._transitionTo(S.LISTENING);
  }

  // ── State helpers ────────────────────────────────────────

  _transitionTo(newState) {
    if (this.state !== newState) {
      this.state = newState;
    }
  }

  // ── Logging ──────────────────────────────────────────────

  log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    const id = this.callSid ? this.callSid.slice(-6) : '???';
    console.log(`[${ts}] [${id}] [${this.state}] ${msg}`);
  }
}

module.exports = { CallSession, STATES: S };
