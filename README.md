# Voice AI Medical Representative

Phone-call–based, fully voice-only, multilingual AI medical representative for HCPs.

## Architecture

```
Phone Call (Twilio)
  → Streaming Speech-to-Text  (OpenAI Whisper, auto language detect)
  → Translate to English       (GPT-4o-mini)
  → LLM reasoning              (GPT-4o-mini + injected product docs)
  → Translate to caller lang   (GPT-4o-mini)
  → Text-to-Speech             (OpenAI TTS)
  → Audio back to caller
  (loop)
```

## Prerequisites

| Tool | Purpose |
|------|---------|
| **Node.js 18+** | Runtime |
| **ngrok** | Tunnel for Twilio webhooks |
| **Twilio account** | Phone number + Media Streams |
| **OpenAI API key** | Whisper, GPT-4o-mini, TTS |

## Quick Start (5 minutes)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=AC...      # optional, for reference
TWILIO_AUTH_TOKEN=...          # optional, for reference
PORT=3000
TTS_VOICE=nova                 # nova, alloy, shimmer, echo, onyx, fable
```

### 3. Start the server

```bash
npm start
```

### 4. Expose with ngrok

In a second terminal:

```bash
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL.

### 5. Configure Twilio

1. Go to [Twilio Console → Phone Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
2. Select your phone number
3. Under **Voice & Fax → A Call Comes In**:
   - Set to **Webhook**
   - URL: `https://xxxx.ngrok-free.app/incoming-call`
   - Method: **HTTP POST**
4. Save

### 6. Call your Twilio number!

- Speak in any language — the AI will auto-detect and respond in that language
- Drug names, dosages, and medical terms stay in English
- Ask about mechanism of action, clinical data, insurance, patient support, etc.

## Project Structure

```
├── server.js              # Express + WebSocket entry point
├── lib/
│   ├── audioUtils.js      # Mulaw ↔ PCM ↔ WAV conversion, VAD
│   ├── callSession.js     # Per-call state machine & voice pipeline
│   └── openaiService.js   # OpenAI API calls (STT, LLM, TTS, translate)
├── data/
│   └── product-info.txt   # Product information (injected into LLM context)
├── package.json
├── .env.example
└── README.md
```

## Customization

### Change the product

Edit `data/product-info.txt` with your own publicly available product information. The LLM will ONLY reference data from this file.

### Change the voice

Set `TTS_VOICE` in `.env`. Options: `nova`, `alloy`, `shimmer`, `echo`, `onyx`, `fable`.

### Add languages

No code change needed — Whisper auto-detects 50+ languages. Translation and TTS are multilingual out of the box.

### Tune sensitivity

In `lib/callSession.js`, adjust:

| Constant | Default | Purpose |
|----------|---------|---------|
| `ENERGY_THRESHOLD` | 180 | Speech detection sensitivity |
| `SILENCE_TRIGGER_MS` | 1500 | Silence duration to end turn |
| `MIN_SPEECH_MS` | 400 | Ignore very short bursts |
| `THINKING_PAUSE_MS` | 400 | Pause before AI responds |

## Supported Languages

English, Hindi, Spanish, French, German, Portuguese, Chinese, Japanese, Korean, Arabic, Russian, Italian, Dutch, Polish, Turkish, Vietnamese, Thai, Bengali, Tamil, Telugu, Marathi, Gujarati, Urdu, Punjabi — and any other language Whisper supports.

## Failsafe Behavior

- If info is not in the product docs → "That isn't specified in the publicly available information."
- If audio glitches → graceful recovery with "Could you please repeat?"
- If caller interrupts → AI stops speaking and listens
- Never hallucinate. Never go off-label. Prefer saying less over saying wrong.

## Cost Estimate (per call)

| API | Cost |
|-----|------|
| Whisper | ~$0.006/min |
| GPT-4o-mini | ~$0.001/turn |
| TTS | ~$0.015/1K chars |
| **~5 min call** | **~$0.15–0.25** |
