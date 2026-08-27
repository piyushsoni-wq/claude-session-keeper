'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backups = require('../lib/backups');

function tmpBackupRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csk-backups-'));
}

function buildFakeSnapshot(backupRoot, filename) {
  const snapshotsDir = path.join(backupRoot, 'snapshots');
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-archive-build-'));
  const projectDir = path.join(buildDir, 'projects', '-Users-test-project');
  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, 'session-a.jsonl'),
    '{"type":"user","cwd":"/Users/test/project","message":{"content":"first session"}}\n' +
      '{"type":"custom-title","customTitle":"TWP-1111","sessionId":"session-a"}\n',
  );
  fs.writeFileSync(
    path.join(projectDir, 'session-b.jsonl'),
    '{"type":"user","cwd":"/Users/test/project","message":{"content":"second session"}}\n',
  );
  // A nested subagent file under session-a's own directory — must NOT
  // show up as its own row in listSnapshotSessions.
  const subagentDir = path.join(projectDir, 'session-a', 'subagents');
  fs.mkdirSync(subagentDir, { recursive: true });
  fs.writeFileSync(path.join(subagentDir, 'agent-x.jsonl'), '{"type":"user","message":{"content":"nested"}}\n');

  const archivePath = path.join(snapshotsDir, filename);
  execFileSync('tar', ['-czf', archivePath, '-C', buildDir, 'projects']);
  fs.rmSync(buildDir, { recursive: true, force: true });
  return archivePath;
}

test('listSnapshots returns [] when the snapshots dir does not exist', () => {
  const backupRoot = tmpBackupRoot();
  assert.deepEqual(backups.listSnapshots(backupRoot), []);
  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('listSnapshots lists matching archives sorted newest first, ignoring non-matching files', () => {
  const backupRoot = tmpBackupRoot();
  const dir = path.join(backupRoot, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-sessions-2026-01-01_00-00-00.tar.gz'), 'a');
  fs.writeFileSync(path.join(dir, 'claude-sessions-2026-02-01_00-00-00.tar.gz'), 'bb');
  fs.writeFileSync(path.join(dir, 'not-a-snapshot.txt'), 'ignore me');
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-02-01T00:00:00Z');
  fs.utimesSync(path.join(dir, 'claude-sessions-2026-01-01_00-00-00.tar.gz'), older, older);
  fs.utimesSync(path.join(dir, 'claude-sessions-2026-02-01_00-00-00.tar.gz'), newer, newer);

  const list = backups.listSnapshots(backupRoot);
  assert.equal(list.length, 2);
  assert.equal(list[0].file, 'claude-sessions-2026-02-01_00-00-00.tar.gz');
  assert.equal(list[1].file, 'claude-sessions-2026-01-01_00-00-00.tar.gz');

  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('listSnapshotSessions lists exactly the top-level sessions, excluding nested subagent files', () => {
  const backupRoot = tmpBackupRoot();
  const filename = 'claude-sessions-2026-03-01_00-00-00.tar.gz';
  buildFakeSnapshot(backupRoot, filename);

  const result = backups.listSnapshotSessions(backupRoot, filename);
  assert.equal(result.length, 2);
  const ids = result.map((r) => r.sessionId).sort();
  assert.deepEqual(ids, ['session-a', 'session-b']);
  const a = result.find((r) => r.sessionId === 'session-a');
  assert.equal(a.title, 'TWP-1111');
  assert.equal(a.cwd, '/Users/test/project');
  assert.equal(a.encodedProjectDir, '-Users-test-project');

  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('listSnapshotSessions returns null for a missing archive', () => {
  const backupRoot = tmpBackupRoot();
  fs.mkdirSync(path.join(backupRoot, 'snapshots'), { recursive: true });
  assert.equal(backups.listSnapshotSessions(backupRoot, 'claude-sessions-2026-01-01_00-00-00.tar.gz'), null);
  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('listSnapshotSessions rejects a filename outside the expected pattern (path traversal guard)', () => {
  const backupRoot = tmpBackupRoot();
  assert.equal(backups.listSnapshotSessions(backupRoot, '../../../etc/passwd'), null);
  assert.equal(backups.listSnapshotSessions(backupRoot, 'not-a-real-snapshot.tar.gz'), null);
  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('deleteSnapshot removes the archive file', () => {
  const backupRoot = tmpBackupRoot();
  const filename = 'claude-sessions-2026-04-01_00-00-00.tar.gz';
  const archivePath = buildFakeSnapshot(backupRoot, filename);
  assert.ok(fs.existsSync(archivePath));

  backups.deleteSnapshot(backupRoot, filename);
  assert.equal(fs.existsSync(archivePath), false);

  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('deleteSnapshot throws (does not touch the filesystem) for a path-traversal-shaped filename', () => {
  const backupRoot = tmpBackupRoot();
  assert.throws(() => backups.deleteSnapshot(backupRoot, '../../../etc/passwd'));
  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('deleteMirrorSession removes the session file and its subdirectory from the mirror', () => {
  const backupRoot = tmpBackupRoot();
  const projectDir = path.join(backupRoot, 'mirror', '-Users-test-project');
  fs.mkdirSync(path.join(projectDir, 'session-c', 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session-c.jsonl'), '{}');
  fs.writeFileSync(path.join(projectDir, 'session-c', 'tool-results', 'out.txt'), 'x');

  backups.deleteMirrorSession(backupRoot, 'session-c');

  assert.equal(fs.existsSync(path.join(projectDir, 'session-c.jsonl')), false);
  assert.equal(fs.existsSync(path.join(projectDir, 'session-c')), false);

  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('deleteMirrorSession throws for a session that does not exist', () => {
  const backupRoot = tmpBackupRoot();
  fs.mkdirSync(path.join(backupRoot, 'mirror'), { recursive: true });
  assert.throws(() => backups.deleteMirrorSession(backupRoot, 'does-not-exist'));
  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('deleteMirrorSession refuses a path-traversal-shaped session id', () => {
  const backupRoot = tmpBackupRoot();
  fs.mkdirSync(path.join(backupRoot, 'mirror'), { recursive: true });
  assert.throws(() => backups.deleteMirrorSession(backupRoot, '../../../etc/passwd'));
  fs.rmSync(backupRoot, { recursive: true, force: true });
});
