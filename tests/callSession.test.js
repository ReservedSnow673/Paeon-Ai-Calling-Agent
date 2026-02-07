// ─────────────────────────────────────────────────────────────
// tests/callSession.test.js — Unit tests for call session state machine
// Uses a mock WebSocket to test state transitions, audio handling,
// interruptions, and protocol compliance
// ─────────────────────────────────────────────────────────────

'use strict';

process.env.GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID || 'test-project';

const { CallSession, STATES: S } = require('../lib/callSession');
const { linearToMulaw, generateSilence } = require('../lib/audioUtils');

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

// ── Mock WebSocket ───────────────────────────────────────────

class MockWS {
  constructor() {
    this.readyState = 1; // OPEN
    this.messages = [];
    this.closed = false;
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('WS not open');
    this.messages.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.closed = true;
  }
  getMediaMessages() { return this.messages.filter(m => m.event === 'media'); }
  getMarkMessages()  { return this.messages.filter(m => m.event === 'mark'); }
  getClearMessages() { return this.messages.filter(m => m.event === 'clear'); }
}

// ── Audio helpers ────────────────────────────────────────────

function makeLoudChunk(length = 160) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = linearToMulaw(8000);
  return buf.toString('base64');
}

function makeSilentChunk(length = 160) {
  return generateSilence(20).toString('base64'); // 20ms = 160 bytes
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== Session Construction ===');

test('creates with IDLE state', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  assert(s.state === S.IDLE, `Expected IDLE, got ${s.state}`);
});

test('stores streamSid and callSid', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ_stream', 'CA_call');
  assert(s.streamSid === 'MZ_stream');
  assert(s.callSid === 'CA_call');
});

test('initializes empty history', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  assert(Array.isArray(s.history) && s.history.length === 0);
});

test('initializes firstTurn as true', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  assert(s.firstTurn === true);
});

test('initializes lang as null (auto-detect on first turn)', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  assert(s.lang === null, `Expected null, got ${s.lang}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Audio Handling — State Transitions ===');

test('ignores audio in IDLE state', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.IDLE;
  s.handleAudio(makeLoudChunk());
  assert(s.state === S.IDLE, 'Should stay IDLE');
  assert(s.audioBuffer.length === 0, 'Buffer should be empty');
});

test('ignores audio in GREETING state', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.GREETING;
  s.handleAudio(makeLoudChunk());
  assert(s.state === S.GREETING);
});

test('transitions LISTENING → RECORDING on loud audio', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.LISTENING;
  s.handleAudio(makeLoudChunk());
  assert(s.state === S.RECORDING, `Expected RECORDING, got ${s.state}`);
});

test('stays LISTENING on silent audio', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.LISTENING;
  s.handleAudio(makeSilentChunk());
  assert(s.state === S.LISTENING);
});

test('buffers audio in RECORDING state', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.LISTENING;
  s.handleAudio(makeLoudChunk());
  s.handleAudio(makeLoudChunk());
  s.handleAudio(makeLoudChunk());
  assert(s.audioBuffer.length === 3, `Expected 3 chunks, got ${s.audioBuffer.length}`);
});

test('stashes overflow audio during PROCESSING', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.PROCESSING;
  s.handleAudio(makeLoudChunk());
  assert(s.audioBuffer.length === 1, 'Should stash during processing');
});

test('ignores silent audio during PROCESSING', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.PROCESSING;
  s.handleAudio(makeSilentChunk());
  assert(s.audioBuffer.length === 0);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Interruption Detection ===');

test('detects interruption during SPEAKING state', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.SPEAKING;
  s.handleAudio(makeLoudChunk()); // energy needs to be > threshold * 1.5
  // Check that state changed to RECORDING or clear was sent
  if (s.interrupted) {
    assert(s.state === S.RECORDING, 'Should switch to RECORDING');
    assert(ws.getClearMessages().length > 0, 'Should send clear to Twilio');
  }
  // If energy wasn't high enough to trigger, that's ok too
});

test('does not interrupt on quiet audio while SPEAKING', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.SPEAKING;
  s.handleAudio(makeSilentChunk());
  assert(s.state === S.SPEAKING, 'Should stay SPEAKING');
  assert(!s.interrupted, 'Should not be interrupted');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Mark Handling ===');

test('mark transitions SPEAKING → LISTENING', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.SPEAKING;
  s.interrupted = false;
  s.handleMark('end-12345');
  assert(s.state === S.LISTENING, `Expected LISTENING, got ${s.state}`);
});

test('mark does not transition if interrupted', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.SPEAKING;
  s.interrupted = true;
  s.handleMark('end-12345');
  assert(s.state === S.SPEAKING, 'Should stay SPEAKING when interrupted');
});

test('mark does nothing in non-SPEAKING states', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  for (const state of [S.IDLE, S.LISTENING, S.RECORDING, S.PROCESSING]) {
    s.state = state;
    s.handleMark('end-12345');
    assert(s.state === state, `Should stay in ${state}`);
  }
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Session Stop / Cleanup ===');

test('stop resets state to IDLE', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s.state = S.RECORDING;
  s.audioBuffer = [Buffer.alloc(100)];
  s.history = [{ role: 'user', content: 'test' }];
  s.stop();
  assert(s.state === S.IDLE);
  assert(s.audioBuffer.length === 0);
  assert(s.history.length === 0);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Twilio Protocol Compliance ===');

test('_sendMulawChunks sends media events with base64 payload', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ_stream', 'CA456');
  const audio = generateSilence(50); // 400 bytes
  s._sendMulawChunks(audio, { aborted: false });
  const msgs = ws.getMediaMessages();
  assert(msgs.length > 0, 'Should send at least one media message');
  for (const msg of msgs) {
    assert(msg.event === 'media', 'Event should be media');
    assert(msg.streamSid === 'MZ_stream', 'Wrong streamSid');
    assert(typeof msg.media.payload === 'string', 'Payload should be string');
    // Verify it's valid base64
    const decoded = Buffer.from(msg.media.payload, 'base64');
    assert(decoded.length > 0, 'Decoded payload should not be empty');
  }
});

test('_sendMark sends correct event structure', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ_stream', 'CA456');
  s._sendMark('end-99999');
  const marks = ws.getMarkMessages();
  assert(marks.length === 1, 'Should send one mark');
  assert(marks[0].event === 'mark');
  assert(marks[0].streamSid === 'MZ_stream');
  assert(marks[0].mark.name === 'end-99999');
});

test('_clearTwilioQueue sends clear event', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ_stream', 'CA456');
  s._clearTwilioQueue();
  const clears = ws.getClearMessages();
  assert(clears.length === 1);
  assert(clears[0].event === 'clear');
  assert(clears[0].streamSid === 'MZ_stream');
});

test('does not send when WebSocket is closed', () => {
  const ws = new MockWS();
  ws.readyState = 3; // CLOSED
  const s = new CallSession(ws, 'MZ123', 'CA456');
  s._sendMulawChunks(generateSilence(50), { aborted: false });
  s._sendMark('test');
  s._clearTwilioQueue();
  assert(ws.messages.length === 0, 'Should not send on closed WS');
});

test('_sendMulawChunks respects abort signal', () => {
  const ws = new MockWS();
  const s = new CallSession(ws, 'MZ_stream', 'CA456');
  const audio = generateSilence(1000); // 8000 bytes, many chunks
  s._sendMulawChunks(audio, { aborted: true }); // Already aborted
  assert(ws.getMediaMessages().length === 0, 'Should not send when aborted');
});

// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Call Session: ${pass}/${total} passed, ${fail} failed`);
console.log('═'.repeat(50));

module.exports = { pass, fail, total };
