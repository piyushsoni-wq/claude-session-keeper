'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  resolveSessionCwd,
  estimateContextUsage,
  readCleanupPeriodDays,
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

test('readCleanupPeriodDays defaults to 30 when settings.json is absent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-settings-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
  try {
    assert.equal(readCleanupPeriodDays(), 30);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readCleanupPeriodDays reads a configured value', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-settings-'));
  fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
  try {
    assert.equal(readCleanupPeriodDays(), 90);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
