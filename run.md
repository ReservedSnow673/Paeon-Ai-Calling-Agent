# Run Guide — Voice AI Medical Representative

## Prerequisites

| Tool | Install | Purpose |
|------|---------|---------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) | Runtime |
| **ngrok** | `brew install ngrok` or [ngrok.com](https://ngrok.com/download) | Exposes local server to the internet |
| **Twilio account** | [twilio.com/try-twilio](https://www.twilio.com/try-twilio) | Phone number + media streams |
| **Google Cloud project** | [console.cloud.google.com](https://console.cloud.google.com) | STT, Translation, Vertex AI (Gemini), TTS |

---

## Step 1 — Install Dependencies

```bash
cd "Voice AI"
npm install
```

---

## Step 2 — Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in your keys:

```
GOOGLE_PROJECT_ID=my-gcp-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
GOOGLE_LOCATION=us-central1
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PORT=3000
```

> **Google Cloud setup:** Create a service account with roles for Speech-to-Text, Translation, Text-to-Speech, and Vertex AI. Download the JSON key and set the path in `GOOGLE_APPLICATION_CREDENTIALS`.

---

## Step 3 — Start the Server

```bash
npm start
```

You should see:

```
[google] Product info loaded (XXXX chars)

╔══════════════════════════════════════════════════════════╗
║  Voice AI Medical Rep — PRODUCTION SERVER                ║
║  Port: 3000                                              ║
║  ...                                                     ║
╚══════════════════════════════════════════════════════════╝
```

---

## Step 4 — Start ngrok Tunnel

Open a **second terminal**:

```bash
ngrok http 3000
```

You'll see output like:

```
Forwarding   https://a1b2c3d4.ngrok-free.app -> http://localhost:3000
```

**Copy the `https://` URL.** You need it for the next step.

> **Tip:** If you have a paid ngrok plan, use a fixed subdomain:
> `ngrok http 3000 --domain=your-name.ngrok-free.app`

---

## Step 5 — Configure Twilio

### 5a. Get a Phone Number

1. Go to [Twilio Console → Buy a Number](https://console.twilio.com/us1/develop/phone-numbers/manage/search)
2. Buy a number with **Voice** capability (free trial includes one number)

### 5b. Set the Webhook

1. Go to [Twilio Console → Phone Numbers → Active Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
2. Click your phone number
3. Scroll to **Voice Configuration**
4. Under **"A call comes in"**:
   - Set to **Webhook**
   - URL: `https://a1b2c3d4.ngrok-free.app/incoming-call`
   - Method: **HTTP POST**
5. Click **Save configuration**

### 5c. (Optional) Status Callback

Under **"Call status changes"**:
- URL: `https://a1b2c3d4.ngrok-free.app/call-status`
- Method: **HTTP POST**

---

## Step 6 — Make a Test Call

1. **Call your Twilio number** from any phone
2. You'll hear: *"Hello! Welcome to the medical information service..."*
3. **Speak naturally** — ask about the drug, mechanism, dosing, insurance, etc.
4. The AI will respond in your language

### Example Questions to Try

| Language | Question |
|----------|----------|
| English | "What is the mechanism of action of Nexavir?" |
| English | "What were the clinical trial results?" |
| English | "Is Nexavir covered by insurance?" |
| English | "Tell me about the patient support program" |
| Hindi | "Nexavir kaise kaam karta hai?" |
| Hindi | "Insurance mein cover hota hai kya?" |
| Spanish | "¿Cuál es el mecanismo de acción?" |

---

## Verify It's Running

### Health Check

```bash
curl http://localhost:3000/
```

Expected:
```json
{"status":"ok","service":"voice-ai-med-rep","activeCalls":0,"uptime":42}
```

### Detailed Health

```bash
curl http://localhost:3000/health
```

Expected:
```json
{"status":"ok","activeCalls":0,"uptime":42,"memory":"25MB"}
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No sound after connecting | ngrok URL not set in Twilio | Check webhook URL matches ngrok output |
| "Missing env var" on start | `.env` not configured | Run `cp .env.example .env` and fill in keys |
| Call connects but AI doesn't respond | Google Cloud credentials invalid | Verify service account key and project ID |
| Audio is choppy/garbled | Network latency to Google Cloud | Ensure stable internet; try wired connection |
| "Stream started" but no audio events | Twilio trial limitations | Verify your Twilio number is voice-enabled |
| ngrok shows 502 errors | Server not running | Start server first (`npm start`), then ngrok |
| Caller hears silence for 5+ seconds | First TTS generation is slow (cold start) | Normal on first call — subsequent turns are faster |

### View Logs

The server logs everything to stdout. You'll see:

```
═══ Incoming call ═══
  From:    +1234567890
  CallSid: CAxxxxxxxx
⚡ WebSocket connected
   Stream started  sid=MZxxxxxxxx
[12:34:56.789] [xxxxxx] [GREETING] Sending greeting
[12:34:58.123] [xxxxxx] [LISTENING] Listening
[12:35:02.456] [xxxxxx] [RECORDING] Speech start
[12:35:04.789] [xxxxxx] [PROCESSING] STT: "What is the mechanism of action?" [en]
[12:35:05.012] [xxxxxx] [PROCESSING] LLM reasoning...
[12:35:06.345] [xxxxxx] [SPEAKING] Sent 24000 bytes audio to caller
```

---

## Hosting in Production

### Option A — Railway (Recommended, Free Tier)

1. Push code to GitHub
2. Go to [railway.app](https://railway.app)
3. New Project → Deploy from GitHub
4. Add environment variables (same as `.env`)
5. Railway gives you a public URL — use that in Twilio webhook
6. No ngrok needed

### Option B — Render

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add env vars
6. Use the Render URL in Twilio webhook

### Option C — Fly.io

```bash
# Install flyctl
brew install flyctl

# Launch
fly launch --name voice-ai-med-rep
fly secrets set GOOGLE_PROJECT_ID=my-project GOOGLE_APPLICATION_CREDENTIALS=/app/service-account.json
fly deploy
```

Use `https://voice-ai-med-rep.fly.dev/incoming-call` as your Twilio webhook.

### Option D — VPS (DigitalOcean / AWS EC2)

```bash
# On the server
git clone <your-repo>
cd voice-ai-med-rep
npm install
cp .env.example .env
# Edit .env with your keys

# Run with process manager
npm install -g pm2
pm2 start server.js --name voice-ai
pm2 save
pm2 startup
```

Set Twilio webhook to `https://your-server-ip:3000/incoming-call` (use a reverse proxy like nginx + certbot for HTTPS).

---

## Architecture Recap

```
Phone Call (Twilio)
  └→ Twilio <Connect><Stream> → WebSocket (bidirectional)
       └→ Inbound mulaw audio (8kHz, 8-bit)
            └→ VAD silence detection (1.5s threshold)
                 └→ Google Cloud Speech-to-Text (mulaw, auto language detect)
                      └→ Google Cloud Translation → English
                           └→ Gemini 2.0 Flash reasoning (grounded in product docs)
                                └→ Google Cloud Translation → caller language
                                     └→ Google Cloud TTS (mulaw 8kHz)
                                          └→ mulaw chunks → Twilio → Caller
```

---

## Cost per Call

| Component | Rate | ~5 min call |
|-----------|------|-------------|
| Google Cloud STT | $0.024/min (enhanced) | $0.12 |
| Gemini 2.0 Flash | ~$0.001/turn | $0.005 |
| Google Translation | $20/M chars | $0.005 |
| Google Cloud TTS | $0.016/1K chars (Neural2) | $0.08 |
| Twilio | $0.0085/min inbound | $0.04 |
| **Total** | | **~$0.20–0.35** |
