# Voice AI Medical Representative

Phone-call–based, fully voice-only, multilingual AI medical representative for HCPs.

## Architecture

```
Phone Call (Twilio)
  → Google Cloud Speech-to-Text  (mulaw 8kHz, auto language detect)
  → Google Cloud Translation     (to English, internal)
  → Gemini reasoning              (Vertex AI + injected product docs)
  → Google Cloud Translation     (to caller language)
  → Google Cloud Text-to-Speech  (mulaw 8kHz, multilingual voices)
  → Audio back to caller
  (loop)
```

## Prerequisites

| Tool | Purpose |
|------|---------|
| **Node.js 18+** | Runtime |
| **ngrok** | Tunnel for Twilio webhooks |
| **Twilio account** | Phone number + Media Streams |
| **Google Cloud project** | Speech-to-Text, Translation, Vertex AI (Gemini), Text-to-Speech |

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
GOOGLE_PROJECT_ID=my-gcp-project
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GOOGLE_LOCATION=us-central1   # Vertex AI region
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
PORT=3000
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
│   ├── audioUtils.js      # Mulaw codec, VAD energy detection, silence gen
│   ├── callSession.js     # Per-call state machine & voice pipeline
│   └── googleService.js   # Google Cloud API calls (STT, LLM, TTS, translate)
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

Voices are selected automatically per language in `lib/googleService.js` (the `VOICE_MAP` object). Edit the map to change voices for specific languages. See [Google Cloud TTS voices](https://cloud.google.com/text-to-speech/docs/voices).

### Add languages

No code change needed — Google Cloud Speech-to-Text auto-detects 20+ configured languages. To add more, update `STT_ALT_LANGS` in `lib/googleService.js` and add a voice entry to `VOICE_MAP`.

### Tune sensitivity

In `lib/callSession.js`, adjust:

| Constant | Default | Purpose |
|----------|---------|---------|
| `ENERGY_THRESHOLD` | 180 | Speech detection sensitivity |
| `SILENCE_TRIGGER_MS` | 1500 | Silence duration to end turn |
| `MIN_SPEECH_MS` | 400 | Ignore very short bursts |
| `THINKING_PAUSE_MS` | 400 | Pause before AI responds |

## Supported Languages

English, Hindi, Spanish, French, German, Portuguese, Chinese, Japanese, Korean, Arabic, Russian, Italian, Bengali, Tamil, Telugu, Gujarati, Marathi, Turkish, Polish, Dutch, Vietnamese, Thai — and more by adding to `STT_ALT_LANGS` and `VOICE_MAP` in `lib/googleService.js`.

## Failsafe Behavior

- If info is not in the product docs → "That isn't specified in the publicly available information."
- If audio glitches → graceful recovery with "Could you please repeat?"
- If caller interrupts → AI stops speaking and listens
- Never hallucinate. Never go off-label. Prefer saying less over saying wrong.

## Cost Estimate (per call)

| API | Cost |
|-----|------|
| Google Cloud STT | ~$0.024/min (enhanced phone model) |
| Gemini 2.0 Flash | ~$0.001/turn |
| Google Translation | ~$0.00002/char ($20/M chars) |
| Google Cloud TTS | ~$0.016/1K chars (Neural2) |
| Twilio | ~$0.0085/min inbound |
| **~5 min call** | **~$0.20–0.35** |
