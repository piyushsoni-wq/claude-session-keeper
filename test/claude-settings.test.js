'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readCleanupPeriodDays, writeCleanupPeriodDays, settingsPath } = require('../lib/claude-settings');

function withTmpClaudeDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-settings-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
  try {
    fn(tmpDir);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('readCleanupPeriodDays defaults to 30 when settings.json is absent', () => {
  withTmpClaudeDir(() => {
    assert.equal(readCleanupPeriodDays(), 30);
  });
});

test('readCleanupPeriodDays reads a configured value', () => {
  withTmpClaudeDir((tmpDir) => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
    assert.equal(readCleanupPeriodDays(), 90);
  });
});

test('writeCleanupPeriodDays updates only cleanupPeriodDays, preserving unrelated keys', () => {
  withTmpClaudeDir((tmpDir) => {
    const original = { cleanupPeriodDays: 30, model: 'sonnet', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    fs.writeFileSync(settingsPath(), JSON.stringify(original, null, 2));

    writeCleanupPeriodDays(45);

    const updated = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    assert.equal(updated.cleanupPeriodDays, 45);
    assert.equal(updated.model, 'sonnet');
    assert.deepEqual(updated.hooks, original.hooks);
  });
});

test('writeCleanupPeriodDays writes a timestamped backup of the previous content', () => {
  withTmpClaudeDir((tmpDir) => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ cleanupPeriodDays: 30 }));
    writeCleanupPeriodDays(60);

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.bak-'));
    assert.equal(backups.length, 1);
    const backupContent = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'));
    assert.equal(backupContent.cleanupPeriodDays, 30); // backup holds the PRE-write value
  });
});

test('writeCleanupPeriodDays prunes backups beyond the last 5', () => {
  withTmpClaudeDir((tmpDir) => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ cleanupPeriodDays: 30 }));
    for (let i = 0; i < 7; i++) {
      writeCleanupPeriodDays(30 + i);
    }
    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.bak-'));
    assert.ok(backups.length <= 5, `expected at most 5 backups, got ${backups.length}`);
  });
});

test('writeCleanupPeriodDays rejects a non-positive value', () => {
  withTmpClaudeDir(() => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ cleanupPeriodDays: 30 }));
    assert.throws(() => writeCleanupPeriodDays(0));
    assert.throws(() => writeCleanupPeriodDays(-5));
    assert.throws(() => writeCleanupPeriodDays('not-a-number'));
  });
});

test('writeCleanupPeriodDays throws (does not silently corrupt) when settings.json is malformed', () => {
  withTmpClaudeDir(() => {
    fs.writeFileSync(settingsPath(), '{not valid json');
    assert.throws(() => writeCleanupPeriodDays(30));
  });
});
