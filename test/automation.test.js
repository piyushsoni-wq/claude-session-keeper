'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAutomationStatus } = require('../lib/automation');

function tmpBackupRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csk-automation-'));
}

test('getAutomationStatus parses the last ISO-timestamped "Done." line from backup.log', () => {
  const backupRoot = tmpBackupRoot();
  const log = [
    '[Thu Aug 27 22:55:12 IST 2026] Done.', // pre-fix, unparseable — must be skipped, not crash
    '[2026-08-27T18:15:54Z] Mirroring ...',
    '[2026-08-27T18:15:54Z] Done.',
  ].join('\n');
  fs.writeFileSync(path.join(backupRoot, 'backup.log'), log);

  const status = getAutomationStatus(backupRoot, 15);
  assert.equal(status.lastMirrorRunAt, '2026-08-27T18:15:54.000Z');
  assert.equal(status.estimatedNextMirrorRunAt, '2026-08-28T18:15:54.000Z');

  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('getAutomationStatus fails soft when backup.log is missing', () => {
  const backupRoot = tmpBackupRoot();
  const status = getAutomationStatus(backupRoot, 15);
  assert.equal(status.lastMirrorRunAt, null);
  assert.equal(status.estimatedNextMirrorRunAt, null);
  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('getAutomationStatus computes estimatedNextSnapshotAt from the newest snapshot file\'s mtime + intervalDays', () => {
  const backupRoot = tmpBackupRoot();
  const snapshotDir = path.join(backupRoot, 'snapshots');
  fs.mkdirSync(snapshotDir);
  fs.writeFileSync(path.join(snapshotDir, 'claude-sessions-2026-01-01_00-00-00.tar.gz'), '');
  const fixedTime = new Date('2026-01-01T00:00:00.000Z');
  fs.utimesSync(path.join(snapshotDir, 'claude-sessions-2026-01-01_00-00-00.tar.gz'), fixedTime, fixedTime);

  const status = getAutomationStatus(backupRoot, 15);
  assert.equal(status.lastSnapshotAt, '2026-01-01T00:00:00.000Z');
  assert.equal(status.estimatedNextSnapshotAt, '2026-01-16T00:00:00.000Z');

  fs.rmSync(backupRoot, { recursive: true, force: true });
});

test('getAutomationStatus never throws regardless of real launchd state on the machine running the test', () => {
  // Whether com.user.claudesessionkeeper happens to be loaded is real,
  // machine-specific state this test doesn't control (it IS loaded on
  // the dev machine this was built on) — so this only asserts the shape
  // holds together, not a specific installed value. The "not installed"
  // path itself was verified manually against the real job (temporarily
  // unloaded, checked, reloaded).
  const backupRoot = tmpBackupRoot();
  const status = getAutomationStatus(backupRoot, 15);
  assert.equal(typeof status.installed, 'boolean');
  if (!status.installed) {
    assert.equal(status.state, null);
    assert.equal(status.runs, null);
  }
  fs.rmSync(backupRoot, { recursive: true, force: true });
});
