'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listUnifiedSessions } = require('../lib/unified-sessions');

function makeEnv() {
  const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-unified-live-'));
  fs.mkdirSync(path.join(claudeConfigDir, 'projects'), { recursive: true });
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-unified-backup-'));
  fs.mkdirSync(path.join(backupRoot, 'mirror'), { recursive: true });
  fs.mkdirSync(path.join(backupRoot, 'snapshots'), { recursive: true });
  return { claudeConfigDir, backupRoot };
}

function cleanupEnv(env) {
  fs.rmSync(env.claudeConfigDir, { recursive: true, force: true });
  fs.rmSync(env.backupRoot, { recursive: true, force: true });
}

function writeSessionFile(rootDir, sessionId, { cwd, customTitle }) {
  const projectDir = path.join(rootDir, '-Users-test-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })];
  if (customTitle) lines.push(JSON.stringify({ type: 'custom-title', customTitle, sessionId }));
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join('\n'));
}

function buildSnapshot(backupRoot, filename, sessionsSpec) {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-unified-archive-'));
  const projectDir = path.join(buildDir, 'projects', '-Users-test-project');
  fs.mkdirSync(projectDir, { recursive: true });
  for (const [sessionId, spec] of Object.entries(sessionsSpec)) {
    const lines = [JSON.stringify({ type: 'user', cwd: spec.cwd, message: { content: 'hi' } })];
    if (spec.customTitle) lines.push(JSON.stringify({ type: 'custom-title', customTitle: spec.customTitle, sessionId }));
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join('\n'));
  }
  const archivePath = path.join(backupRoot, 'snapshots', filename);
  execFileSync('tar', ['-czf', archivePath, '-C', buildDir, 'projects']);
  fs.rmSync(buildDir, { recursive: true, force: true });
}

function withEnv(fn) {
  const env = makeEnv();
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = env.claudeConfigDir;
  try {
    fn(env);
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    cleanupEnv(env);
  }
}

test('a live-only session is tagged inLive, not inMirror, no snapshots', () => {
  withEnv((env) => {
    writeSessionFile(path.join(env.claudeConfigDir, 'projects'), 'live-only', { cwd: '/tmp/a', customTitle: 'Live Title' });
    const rows = listUnifiedSessions(env.backupRoot);
    const row = rows.find((r) => r.sessionId === 'live-only');
    assert.ok(row);
    assert.equal(row.inLive, true);
    assert.equal(row.inMirror, false);
    assert.deepEqual(row.inSnapshots, []);
    assert.equal(row.title, 'Live Title');
    assert.equal(row.snapshotOnly, false);
  });
});

test('a mirror-only session is tagged inMirror, not inLive', () => {
  withEnv((env) => {
    writeSessionFile(path.join(env.backupRoot, 'mirror'), 'mirror-only', { cwd: '/tmp/b', customTitle: 'Mirror Title' });
    const rows = listUnifiedSessions(env.backupRoot);
    const row = rows.find((r) => r.sessionId === 'mirror-only');
    assert.ok(row);
    assert.equal(row.inLive, false);
    assert.equal(row.inMirror, true);
    assert.equal(row.title, 'Mirror Title');
  });
});

test('a snapshot-only session is extracted for title/cwd and marked snapshotOnly', () => {
  withEnv((env) => {
    buildSnapshot(env.backupRoot, 'claude-sessions-2026-01-01_00-00-00.tar.gz', {
      'snap-only': { cwd: '/tmp/c', customTitle: 'Snapshot Title' },
    });
    const rows = listUnifiedSessions(env.backupRoot);
    const row = rows.find((r) => r.sessionId === 'snap-only');
    assert.ok(row);
    assert.equal(row.inLive, false);
    assert.equal(row.inMirror, false);
    assert.deepEqual(row.inSnapshots, ['claude-sessions-2026-01-01_00-00-00.tar.gz']);
    assert.equal(row.snapshotOnly, true);
    assert.equal(row.title, 'Snapshot Title');
    assert.equal(row.cwd, '/tmp/c');
  });
});

test('same session in live AND mirror with different titles: live wins, but inMirror is still true', () => {
  withEnv((env) => {
    writeSessionFile(path.join(env.claudeConfigDir, 'projects'), 'dup-1', { cwd: '/tmp/live', customTitle: 'From Live' });
    writeSessionFile(path.join(env.backupRoot, 'mirror'), 'dup-1', { cwd: '/tmp/mirror', customTitle: 'From Mirror' });
    const rows = listUnifiedSessions(env.backupRoot);
    const matches = rows.filter((r) => r.sessionId === 'dup-1');
    assert.equal(matches.length, 1); // never duplicated into multiple rows
    const row = matches[0];
    assert.equal(row.title, 'From Live');
    assert.equal(row.cwd, '/tmp/live');
    assert.equal(row.inLive, true);
    assert.equal(row.inMirror, true);
  });
});

test('same session in mirror AND a snapshot (not live): mirror wins', () => {
  withEnv((env) => {
    writeSessionFile(path.join(env.backupRoot, 'mirror'), 'dup-2', { cwd: '/tmp/mirror', customTitle: 'From Mirror' });
    buildSnapshot(env.backupRoot, 'claude-sessions-2026-01-01_00-00-00.tar.gz', {
      'dup-2': { cwd: '/tmp/snap', customTitle: 'From Snapshot' },
    });
    const rows = listUnifiedSessions(env.backupRoot);
    const row = rows.find((r) => r.sessionId === 'dup-2');
    assert.equal(row.title, 'From Mirror');
    assert.equal(row.inMirror, true);
    assert.deepEqual(row.inSnapshots, ['claude-sessions-2026-01-01_00-00-00.tar.gz']);
  });
});

test('session in two snapshots only (no live/mirror): the newest snapshot wins', () => {
  withEnv((env) => {
    buildSnapshot(env.backupRoot, 'claude-sessions-2026-01-01_00-00-00.tar.gz', {
      'dup-3': { cwd: '/tmp/old', customTitle: 'Old Snapshot Title' },
    });
    buildSnapshot(env.backupRoot, 'claude-sessions-2026-02-01_00-00-00.tar.gz', {
      'dup-3': { cwd: '/tmp/new', customTitle: 'New Snapshot Title' },
    });
    const rows = listUnifiedSessions(env.backupRoot);
    const row = rows.find((r) => r.sessionId === 'dup-3');
    assert.equal(row.title, 'New Snapshot Title');
    assert.equal(row.inSnapshots.length, 2);
    assert.equal(row.inSnapshots[0], 'claude-sessions-2026-02-01_00-00-00.tar.gz'); // newest first
  });
});

test('returns [] when live/mirror/snapshots are all empty', () => {
  withEnv((env) => {
    assert.deepEqual(listUnifiedSessions(env.backupRoot), []);
  });
});
