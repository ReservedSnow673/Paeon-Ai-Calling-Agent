// ─────────────────────────────────────────────────────────────
// server.js — Express + Twilio webhook + WebSocket media stream
// Production-ready: graceful shutdown, health metrics, request
// validation, active call tracking, error handling
// ─────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const { CallSession } = require('./lib/callSession');

// ── Validate environment ─────────────────────────────────────

const REQUIRED_ENV = ['GOOGLE_PROJECT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing env var ${key} — copy .env.example → .env`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Active call tracking ─────────────────────────────────────

const activeSessions = new Map();   // streamSid → CallSession

// ── Express app ──────────────────────────────────────────────

const path = require('path');
const app  = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Request logging middleware
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    console.log(`→ ${req.method} ${req.path}`);
  }
  next();
});

/**
 * Browser test client — no Twilio needed.
 * Open http://localhost:3000/test in a browser, click the call button,
 * and speak into your mic.
 */
app.get('/test', (_req, res) => {
  res.sendFile(path.join(__dirname, 'test-client.html'));
});

/**
 * Health check — returns active call count and uptime.
 * Useful for monitoring and confirming the server is live.
 */
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'voice-ai-med-rep',
    activeCalls: activeSessions.size,
    uptime: Math.round(process.uptime()),
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    activeCalls: activeSessions.size,
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
  });
});

/**
 * Twilio webhook — called when an incoming phone call arrives.
 * Returns TwiML that:
 *   1. Connects a bidirectional media stream via <Connect><Stream>
 *
 * The <Connect><Stream> blocks TwiML execution until the WS closes
 * or the call ends, which is the correct pattern for bidirectional
 * real-time audio.
 */
app.post('/incoming-call', (req, res) => {
  const from = req.body?.From || 'unknown';
  const callSid = req.body?.CallSid || 'unknown';
  const host = req.headers.host;

  console.log(`\n═══ Incoming call ═══`);
  console.log(`  From:    ${from}`);
  console.log(`  CallSid: ${callSid}`);
  console.log(`  Stream:  wss://${host}/media-stream`);

  // Construct TwiML
  // <Connect><Stream> creates a BIDIRECTIONAL stream — we can
  // both receive caller audio AND send audio back.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="callerNumber" value="${escapeXml(from)}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

/**
 * Optional status callback endpoint.
 */
app.post('/call-status', (req, res) => {
  const status = req.body?.CallStatus || 'unknown';
  const callSid = req.body?.CallSid || '';
  console.log(`Call status: ${status} (${callSid.slice(-6)})`);
  res.sendStatus(204);
});

/**
 * 404 handler
 */
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/**
 * Express error handler
 */
app.use((err, _req, res, _next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── HTTP + WebSocket server ──────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws, req) => {
  const remoteAddr = req.socket.remoteAddress;
  console.log(`⚡ WebSocket connected from ${remoteAddr}`);

  let session = null;
  let streamSid = null;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || !data.event) return;

    switch (data.event) {

      // ── Twilio handshake ──
      case 'connected':
        console.log(`   Protocol: ${data.protocol || 'unknown'} v${data.version || '?'}`);
        break;

      // ── Stream metadata ──
      case 'start': {
        streamSid = data.start?.streamSid || data.streamSid;
        const callSid = data.start?.callSid;
        const customParams = data.start?.customParameters || {};
        console.log(`   Stream started  sid=${streamSid}  call=${callSid?.slice(-6) || '?'}`);
        console.log(`   Format: ${data.start?.mediaFormat?.encoding} @ ${data.start?.mediaFormat?.sampleRate}Hz`);
        if (customParams.callerNumber) {
          console.log(`   Caller: ${customParams.callerNumber}`);
        }

        session = new CallSession(ws, streamSid, callSid);
        activeSessions.set(streamSid, session);
        session.start();
        break;
      }

      // ── Audio data ──
      case 'media':
        if (session && data.media?.payload) {
          session.handleAudio(data.media.payload);
        }
        break;

      // ── Mark callback (audio playback completed) ──
      case 'mark':
        if (session && data.mark?.name) {
          session.handleMark(data.mark.name);
        }
        break;

      // ── DTMF (touch-tone digits) ──
      case 'dtmf':
        if (data.dtmf?.digit) {
          console.log(`   DTMF: ${data.dtmf.digit}`);
        }
        break;

      // ── Stream ended ──
      case 'stop':
        console.log(`   Stream stopped  sid=${streamSid}`);
        cleanupSession();
        break;

      default:
        // Ignore unknown events gracefully
        break;
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`⚡ WebSocket closed (code=${code})`);
    cleanupSession();
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`);
    cleanupSession();
  });

  function cleanupSession() {
    if (session) {
      session.stop();
      if (streamSid) activeSessions.delete(streamSid);
      session = null;
    }
  }
});

// ── Graceful shutdown ────────────────────────────────────────

let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('HTTP server closed');
  });

  // Close all active sessions
  for (const [sid, sess] of activeSessions) {
    try { sess.stop(); } catch (_) {}
    activeSessions.delete(sid);
  }

  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    try { ws.close(1000, 'Server shutting down'); } catch (_) {}
  });

  // Force exit after 5s if connections don't close
  setTimeout(() => {
    console.log('Force exit after timeout');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Catch unhandled errors — log but don't crash
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ── Helpers ──────────────────────────────────────────────────

function escapeXml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

// ── Start ────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Voice AI Medical Rep — PRODUCTION SERVER                ║
║  Port: ${String(PORT).padEnd(49)}║
║                                                          ║
║  Endpoints:                                              ║
║    GET  /           — Health check + call count           ║
║    GET  /health     — Detailed health metrics             ║
║    POST /incoming-call  — Twilio voice webhook            ║
║    WS   /media-stream   — Twilio bidirectional stream     ║
║                                                          ║
║  Setup:                                                  ║
║    1. Run:  ngrok http ${String(PORT).padEnd(35)}║
║    2. Set Twilio webhook: <ngrok>/incoming-call           ║
║    3. Call your Twilio number                             ║
╚══════════════════════════════════════════════════════════╝
`);
});
