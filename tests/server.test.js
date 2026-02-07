// ─────────────────────────────────────────────────────────────
// tests/server.test.js — Integration tests for Express routes
// and WebSocket server protocol
// ─────────────────────────────────────────────────────────────

'use strict';

process.env.GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID || 'test-project';
process.env.PORT = '0'; // Let OS pick a free port

const http = require('http');
const WebSocket = require('ws');

let pass = 0, fail = 0, total = 0;

function test(name, fn) {
  total++;
  return fn()
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ── HTTP request helper ──────────────────────────────────────

function request(baseUrl, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// Start server and run tests
// ─────────────────────────────────────────────────────────────

async function run() {
  // Dynamically require server to pick up PORT=0
  // We need to intercept the listen call
  const express = require('express');
  const WebSocketServer = require('ws').Server;

  // Load server module which starts listening
  // Since server.js calls listen(), we need to get the server instance
  // We'll directly require and get the address
  const originalListen = http.Server.prototype.listen;
  let serverInstance;
  let serverPort;

  // Patch listen to capture port
  http.Server.prototype.listen = function (...args) {
    serverInstance = this;
    // Override port to 0 for test
    if (typeof args[0] === 'number') args[0] = 0;
    const result = originalListen.apply(this, args);
    return result;
  };

  require('../server');

  http.Server.prototype.listen = originalListen;

  // Wait for server to be ready
  await new Promise((resolve) => {
    if (serverInstance.listening) return resolve();
    serverInstance.on('listening', resolve);
  });

  const addr = serverInstance.address();
  serverPort = addr.port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}/media-stream`;

  console.log(`\n  Test server running on port ${serverPort}\n`);

  // ── HTTP Route Tests ───────────────────────────────────

  console.log('=== HTTP Routes ===');

  await test('GET / returns health check JSON', async () => {
    const res = await request(baseUrl, 'GET', '/');
    assert(res.status === 200, `Status ${res.status}`);
    const json = JSON.parse(res.body);
    assert(json.status === 'ok');
    assert(json.service === 'voice-ai-med-rep');
    assert(typeof json.activeCalls === 'number');
    assert(typeof json.uptime === 'number');
  });

  await test('GET /health returns detailed metrics', async () => {
    const res = await request(baseUrl, 'GET', '/health');
    assert(res.status === 200);
    const json = JSON.parse(res.body);
    assert(json.status === 'ok');
    assert(typeof json.memory === 'string');
    assert(json.memory.includes('MB'));
  });

  await test('POST /incoming-call returns valid TwiML', async () => {
    const body = 'From=%2B1234567890&CallSid=CA_test_123';
    const res = await request(baseUrl, 'POST', '/incoming-call', body);
    assert(res.status === 200, `Status ${res.status}`);
    assert(res.headers['content-type'].includes('text/xml'), 'Should be XML');
    assert(res.body.includes('<?xml'), 'Missing XML declaration');
    assert(res.body.includes('<Response>'), 'Missing Response tag');
    assert(res.body.includes('<Connect>'), 'Missing Connect tag');
    assert(res.body.includes('<Stream'), 'Missing Stream tag');
    assert(res.body.includes('wss://'), 'Missing WSS URL');
    assert(res.body.includes('/media-stream'), 'Missing media-stream path');
  });

  await test('POST /incoming-call TwiML has correct structure for bidirectional stream', async () => {
    const body = 'From=%2B1234567890&CallSid=CA_test_456';
    const res = await request(baseUrl, 'POST', '/incoming-call', body);
    // <Connect><Stream> is the correct TwiML for bidirectional streams
    assert(res.body.includes('<Connect>'), 'Need <Connect> for bidirectional');
    assert(res.body.includes('</Connect>'), 'Need closing </Connect>');
    assert(res.body.includes('</Response>'), 'Need closing </Response>');
    // Should NOT use <Start><Stream> (that's unidirectional)
    assert(!res.body.includes('<Start>'), 'Should NOT use <Start> for bidirectional');
  });

  await test('POST /incoming-call escapes XML in caller number', async () => {
    const body = 'From=%3Cscript%3Ealert%3C/script%3E&CallSid=CA_xss';
    const res = await request(baseUrl, 'POST', '/incoming-call', body);
    assert(!res.body.includes('<script>'), 'XSS should be escaped');
    assert(res.body.includes('&lt;'), 'Should use XML entities');
  });

  await test('POST /call-status returns 204', async () => {
    const body = 'CallStatus=completed&CallSid=CA_test_789';
    const res = await request(baseUrl, 'POST', '/call-status', body);
    assert(res.status === 204, `Expected 204, got ${res.status}`);
  });

  await test('GET /nonexistent returns 404', async () => {
    const res = await request(baseUrl, 'GET', '/nonexistent');
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // ── WebSocket Protocol Tests ───────────────────────────

  console.log('\n=== WebSocket Protocol ===');

  await test('WebSocket connects to /media-stream', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), 3000);
    });
    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  await test('handles connected + start events without error', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Send connected event (Twilio sends this first)
    ws.send(JSON.stringify({
      event: 'connected',
      protocol: 'Call',
      version: '1.0.0',
    }));

    // Send start event
    ws.send(JSON.stringify({
      event: 'start',
      sequenceNumber: '1',
      start: {
        streamSid: 'MZ_test_stream_001',
        accountSid: 'AC_test',
        callSid: 'CA_test_ws_001',
        tracks: ['inbound'],
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
        customParameters: { callerNumber: '+1234567890' },
      },
      streamSid: 'MZ_test_stream_001',
    }));

    // Wait a moment for processing
    await new Promise(r => setTimeout(r, 500));

    // Server should have created a session and started greeting
    // We can verify by checking if we receive media messages back (TTS audio)
    // But since OpenAI key might be fake, we just check no crash
    ws.close();
    await new Promise(r => setTimeout(r, 200));
  });

  await test('handles stop event gracefully', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.send(JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZ_test_002', callSid: 'CA_test_002', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } },
      streamSid: 'MZ_test_002',
    }));

    await new Promise(r => setTimeout(r, 300));

    ws.send(JSON.stringify({
      event: 'stop',
      sequenceNumber: '99',
      stop: { accountSid: 'AC_test', callSid: 'CA_test_002' },
      streamSid: 'MZ_test_002',
    }));

    await new Promise(r => setTimeout(r, 200));
    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  await test('handles invalid JSON gracefully', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.send('this is not json {{{');
    ws.send('');
    ws.send('null');

    // Should not crash
    await new Promise(r => setTimeout(r, 300));
    assert(ws.readyState === WebSocket.OPEN, 'WS should still be open');
    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  await test('handles unknown events gracefully', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.send(JSON.stringify({ event: 'unknown_event', data: 'test' }));
    ws.send(JSON.stringify({ event: 'dtmf', streamSid: 'MZ_x', dtmf: { track: 'inbound_track', digit: '5' } }));

    await new Promise(r => setTimeout(r, 200));
    assert(ws.readyState === WebSocket.OPEN, 'WS should still be open');
    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  // ── Report ─────────────────────────────────────────────

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Server Tests: ${pass}/${total} passed, ${fail} failed`);
  console.log('═'.repeat(50));

  // Cleanup
  serverInstance.close();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
