'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeSessionContent, mergeSessionIntoLive, ACTIVE_SESSION_GUARD_MS } = require('../lib/merge');

function line(uuid, timestamp, text) {
  return JSON.stringify({ type: 'user', uuid, timestamp, message: { content: text } });
}

test('mergeSessionContent unions disjoint lines from both sides, sorted by timestamp', () => {
  const live = [
    line('a', '2026-01-01T00:00:00Z', 'first'),
    line('c', '2026-01-01T00:00:02Z', 'third'),
  ].join('\n');
  const mirror = [
    line('a', '2026-01-01T00:00:00Z', 'first'),
    line('b', '2026-01-01T00:00:01Z', 'second — only in mirror'),
  ].join('\n');

  const result = mergeSessionContent(live, mirror);
  assert.equal(result.beforeLines, 2);
  assert.equal(result.afterLines, 3);
  assert.equal(result.addedLines, 1);

  const uuids = result.content.trim().split('\n').map((l) => JSON.parse(l).uuid);
  assert.deepEqual(uuids, ['a', 'b', 'c']); // recovered "b" slotted back into chronological order
});

test('mergeSessionContent is a no-op when live already has everything mirror has', () => {
  const live = [line('a', '2026-01-01T00:00:00Z', 'x'), line('b', '2026-01-01T00:00:01Z', 'y')].join('\n');
  const mirror = [line('a', '2026-01-01T00:00:00Z', 'x')].join('\n');

  const result = mergeSessionContent(live, mirror);
  assert.equal(result.addedLines, 0);
  assert.equal(result.afterLines, 2);
});

test('mergeSessionContent keeps entries with no uuid from both sides (never silently dropped)', () => {
  const noUuidLine = JSON.stringify({ type: 'system', message: { content: 'no uuid here' } });
  const live = [noUuidLine].join('\n');
  const mirror = [noUuidLine].join('\n');

  const result = mergeSessionContent(live, mirror);
  assert.equal(result.afterLines, 2); // can't dedupe without a uuid — both kept, matching the fail-soft convention
});

test('mergeSessionContent skips malformed lines but keeps the valid ones', () => {
  const live = ['not json', line('a', '2026-01-01T00:00:00Z', 'ok')].join('\n');
  const mirror = '';

  const result = mergeSessionContent(live, mirror);
  assert.equal(result.beforeLines, 1);
  assert.equal(result.afterLines, 1);
});

test('mergeSessionIntoLive refuses to touch a session modified in the last 5 minutes', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-merge-test-'));
  const claudeDir = path.join(tmpRoot, 'claude');
  const projectsDir = path.join(claudeDir, 'projects', 'proj');
  const backupRoot = path.join(tmpRoot, 'backups');
  const mirrorDir = path.join(backupRoot, 'mirror', 'proj');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(mirrorDir, { recursive: true });

  const sessionId = '11111111-1111-1111-1111-111111111111';
  fs.writeFileSync(path.join(projectsDir, `${sessionId}.jsonl`), line('a', '2026-01-01T00:00:00Z', 'live'));
  fs.writeFileSync(path.join(mirrorDir, `${sessionId}.jsonl`), line('b', '2026-01-01T00:00:01Z', 'mirror-only'));

  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    assert.throws(() => mergeSessionIntoLive(backupRoot, sessionId), /modified in the last 5 minutes/);
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('mergeSessionIntoLive merges an older-than-guard live file and backs up the pre-merge copy', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-merge-test-'));
  const claudeDir = path.join(tmpRoot, 'claude');
  const projectsDir = path.join(claudeDir, 'projects', 'proj');
  const backupRoot = path.join(tmpRoot, 'backups');
  const mirrorDir = path.join(backupRoot, 'mirror', 'proj');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(mirrorDir, { recursive: true });

  const sessionId = '22222222-2222-2222-2222-222222222222';
  const liveFilePath = path.join(projectsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(liveFilePath, line('a', '2026-01-01T00:00:00Z', 'live'));
  fs.writeFileSync(path.join(mirrorDir, `${sessionId}.jsonl`), [
    line('a', '2026-01-01T00:00:00Z', 'live'),
    line('b', '2026-01-01T00:00:01Z', 'mirror-only'),
  ].join('\n'));

  const oldMtime = new Date(Date.now() - ACTIVE_SESSION_GUARD_MS - 60000);
  fs.utimesSync(liveFilePath, oldMtime, oldMtime);

  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    const result = mergeSessionIntoLive(backupRoot, sessionId);
    assert.equal(result.changed, true);
    assert.equal(result.addedLines, 1);
    assert.ok(fs.existsSync(result.backupPath));

    const mergedUuids = fs.readFileSync(liveFilePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).uuid);
    assert.deepEqual(mergedUuids, ['a', 'b']);
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
