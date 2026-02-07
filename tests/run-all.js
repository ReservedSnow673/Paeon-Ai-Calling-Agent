#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// tests/run-all.js — Run all test suites and report results
// ─────────────────────────────────────────────────────────────

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const suites = [
  { name: 'Audio Utilities', file: 'audioUtils.test.js' },
  { name: 'Google Service',  file: 'googleService.test.js' },
  { name: 'Call Session',    file: 'callSession.test.js' },
  { name: 'Server (HTTP+WS)', file: 'server.test.js' },
];

let totalPass = 0, totalFail = 0, totalTests = 0;
const results = [];

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║            Voice AI — Production Test Suite              ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

for (const suite of suites) {
  const filePath = path.join(__dirname, suite.file);
  console.log(`\n━━━ ${suite.name} ━━━`);

  try {
    const output = execSync(`node "${filePath}"`, {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, GOOGLE_PROJECT_ID: process.env.GOOGLE_PROJECT_ID || 'test-project' },
    });
    console.log(output);

    // Parse results from output
    const match = output.match(/(\d+)\/(\d+) passed, (\d+) failed/);
    if (match) {
      const p = parseInt(match[1]);
      const t = parseInt(match[2]);
      const f = parseInt(match[3]);
      totalPass += p;
      totalFail += f;
      totalTests += t;
      results.push({ name: suite.name, pass: p, fail: f, total: t });
    }
  } catch (e) {
    console.log(e.stdout || '');
    console.log(e.stderr || '');
    const match = (e.stdout || '').match(/(\d+)\/(\d+) passed, (\d+) failed/);
    if (match) {
      const p = parseInt(match[1]);
      const t = parseInt(match[2]);
      const f = parseInt(match[3]);
      totalPass += p;
      totalFail += f;
      totalTests += t;
      results.push({ name: suite.name, pass: p, fail: f, total: t });
    } else {
      totalFail++;
      totalTests++;
      results.push({ name: suite.name, pass: 0, fail: 1, total: 1, error: e.message });
    }
  }
}

// ── Summary ────────────────────────────────────────────────

console.log('\n\n╔══════════════════════════════════════════════════════════╗');
console.log('║                    TEST RESULTS SUMMARY                  ║');
console.log('╠══════════════════════════════════════════════════════════╣');

for (const r of results) {
  const status = r.fail === 0 ? '✓ PASS' : '✗ FAIL';
  const line = `║  ${status}  ${r.name.padEnd(30)} ${r.pass}/${r.total}`.padEnd(59) + '║';
  console.log(line);
}

console.log('╠══════════════════════════════════════════════════════════╣');
const totalLine = `║  TOTAL: ${totalPass}/${totalTests} passed, ${totalFail} failed`.padEnd(59) + '║';
console.log(totalLine);
const verdict = totalFail === 0 ? '✓ ALL TESTS PASSED — PRODUCTION READY' : '✗ SOME TESTS FAILED';
const verdictLine = `║  ${verdict}`.padEnd(59) + '║';
console.log(verdictLine);
console.log('╚══════════════════════════════════════════════════════════╝\n');

process.exit(totalFail > 0 ? 1 : 0);
