'use strict';

// Browsing and pruning what's actually in the backups: every dated
// snapshot (not just the latest), what sessions live inside one, and
// deleting a specific snapshot or mirror-session entry on request.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessions = require('./sessions');

const SNAPSHOT_NAME_RE = /^claude-sessions-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/;

function snapshotsDir(backupRoot) {
  return path.join(backupRoot, 'snapshots');
}

function mirrorDir(backupRoot) {
  return path.join(backupRoot, 'mirror');
}

function listSnapshots(backupRoot) {
  let files;
  try {
    files = fs.readdirSync(snapshotsDir(backupRoot)).filter((f) => SNAPSHOT_NAME_RE.test(f));
  } catch {
    return [];
  }
  const snapshots = files.map((f) => {
    const stat = fs.statSync(path.join(snapshotsDir(backupRoot), f));
    return { file: f, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  });
  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return snapshots;
}

// Lists what's inside one snapshot: `tar -tzf` for the cheap member
// list (no decompression), filtered to exactly "projects/<encoded
// dir>/<session-id>.jsonl" (excludes nested subagents/tool-results/
// memory members), then extracts just those matched members to a temp
// dir and runs them through the same single-pass analyzer used for
// live/mirror sessions, for title + cwd. Context-usage isn't computed
// here — an archived, presumably-finished session doesn't need it, and
// skipping it means only the matched .jsonl members get extracted.
// Returns null if the archive doesn't exist (caller maps that to 404).
function listSnapshotSessions(backupRoot, archiveFile, { contextWindowTokens } = {}) {
  if (!SNAPSHOT_NAME_RE.test(archiveFile)) return null;
  const archivePath = path.join(snapshotsDir(backupRoot), archiveFile);
  if (!fs.existsSync(archivePath)) return null;

  let listing;
  try {
    listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return [];
  }

  const sessionMembers = listing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^projects\/[^/]+\/[^/]+\.jsonl$/.test(l));

  if (sessionMembers.length === 0) return [];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-snapshot-'));
  try {
    const membersFile = path.join(tmpDir, '.members');
    fs.writeFileSync(membersFile, sessionMembers.join('\n'));
    // -T <file>, not -T - : bsdtar (macOS's tar) doesn't accept "-" for
    // stdin the way GNU tar does — confirmed the hard way in restore.sh.
    execFileSync('tar', ['-xzf', archivePath, '-C', tmpDir, '-T', membersFile], { stdio: 'ignore' });

    return sessionMembers.map((member) => {
      const parts = member.split('/'); // ["projects", "<encodedDir>", "<sessionId>.jsonl"]
      const encodedProjectDir = parts[1];
      const sessionId = path.basename(parts[2], '.jsonl');
      const analysis = sessions.analyzeSessionFile(path.join(tmpDir, member));
      return { sessionId, encodedProjectDir, cwd: analysis.cwd, title: analysis.title };
    });
  } catch {
    return [];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function deleteSnapshot(backupRoot, archiveFile) {
  if (!SNAPSHOT_NAME_RE.test(archiveFile)) {
    throw new Error('Invalid snapshot filename');
  }
  fs.unlinkSync(path.join(snapshotsDir(backupRoot), archiveFile));
}

function deleteMirrorSession(backupRoot, sessionId) {
  return sessions.deleteSessionIn(mirrorDir(backupRoot), sessionId);
}

module.exports = {
  snapshotsDir,
  mirrorDir,
  listSnapshots,
  listSnapshotSessions,
  deleteSnapshot,
  deleteMirrorSession,
  SNAPSHOT_NAME_RE,
};
