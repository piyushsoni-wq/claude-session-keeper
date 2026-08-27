'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  resolveSessionCwd,
  resolveSessionTitle,
  estimateContextUsage,
  listSessionsInDir,
} = require('../lib/sessions');

const FIXTURES = path.join(__dirname, 'fixtures');

test('resolveSessionCwd reads cwd from first valid line', () => {
  const cwd = resolveSessionCwd(path.join(FIXTURES, 'valid-session.jsonl'));
  assert.equal(cwd, '/Users/test/project');
});

test('resolveSessionCwd fails soft on malformed/missing lines', () => {
  const cwd = resolveSessionCwd(path.join(FIXTURES, 'broken.jsonl'));
  assert.equal(cwd, null);
});

test('resolveSessionCwd fails soft on empty file', () => {
  const cwd = resolveSessionCwd(path.join(FIXTURES, 'empty.jsonl'));
  assert.equal(cwd, null);
});

test('resolveSessionCwd fails soft on missing file', () => {
  const cwd = resolveSessionCwd(path.join(FIXTURES, 'does-not-exist.jsonl'));
  assert.equal(cwd, null);
});

test('estimateContextUsage skips trailing placeholder and finds the real total scanning backward', () => {
  // valid-session.jsonl's last line has input_tokens:1 (a streaming
  // placeholder) — the real total is on the line before it.
  const { tokens, ratio, unknown } = estimateContextUsage(
    path.join(FIXTURES, 'valid-session.jsonl'),
    200000,
  );
  assert.equal(unknown, false);
  assert.equal(tokens, 15000 + 200 + 500);
  assert.equal(ratio, tokens / 200000);
});

test('estimateContextUsage reports unknown when nothing clears the noise threshold', () => {
  const { tokens, unknown } = estimateContextUsage(path.join(FIXTURES, 'unknown-usage.jsonl'), 200000);
  assert.equal(unknown, true);
  assert.equal(tokens, null);
});

test('estimateContextUsage fails soft on broken/missing files', () => {
  assert.deepEqual(estimateContextUsage(path.join(FIXTURES, 'broken.jsonl'), 200000), {
    tokens: null,
    ratio: null,
    unknown: true,
  });
  assert.deepEqual(estimateContextUsage(path.join(FIXTURES, 'does-not-exist.jsonl'), 200000), {
    tokens: null,
    ratio: null,
    unknown: true,
  });
});

test('resolveSessionTitle prefers customTitle over aiTitle', () => {
  const title = resolveSessionTitle(path.join(FIXTURES, 'titled-session.jsonl'));
  assert.equal(title, 'TWP-9999');
});

test('resolveSessionTitle prefers the custom-title.json side-car file over an inline custom-title entry', () => {
  const title = resolveSessionTitle(path.join(FIXTURES, 'sidecar-session.jsonl'));
  assert.equal(title, 'TWP-4242');
});

test('resolveSessionTitle falls back to aiTitle when no customTitle', () => {
  const title = resolveSessionTitle(path.join(FIXTURES, 'ai-title-only-session.jsonl'));
  assert.equal(title, 'Fix the widget bug');
});

test('resolveSessionTitle falls back to a truncated first user message when no title entries exist', () => {
  const title = resolveSessionTitle(path.join(FIXTURES, 'valid-session.jsonl'));
  assert.equal(title, 'hi');
});

test('resolveSessionTitle returns null when nothing usable exists', () => {
  const title = resolveSessionTitle(path.join(FIXTURES, 'empty.jsonl'));
  assert.equal(title, null);
});

test('listSessionsInDir enumerates sessions from an arbitrary root (e.g. a mirror dir), sorted newest first', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-listdir-'));
  const projectDir = path.join(tmpDir, '-Users-test-project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'valid-session.jsonl'), path.join(projectDir, 'session-a.jsonl'));
  fs.copyFileSync(path.join(FIXTURES, 'titled-session.jsonl'), path.join(projectDir, 'session-b.jsonl'));
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(projectDir, 'session-a.jsonl'), past, past);

  const sessions = listSessionsInDir(tmpDir, { contextWindowTokens: 200000 });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 'session-b'); // newer mtime first
  assert.equal(sessions[0].encodedProjectDir, '-Users-test-project');
  assert.equal(sessions[1].sessionId, 'session-a');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('listSessionsInDir returns an empty list for a missing root', () => {
  assert.deepEqual(listSessionsInDir(path.join(FIXTURES, 'does-not-exist-dir')), []);
});
