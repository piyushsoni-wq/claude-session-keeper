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

// `tar -tzf` for the cheap member list (no decompression of contents),
// filtered to exactly "projects/<encoded dir>/<session-id>.jsonl"
// (excludes nested subagents/tool-results/memory members). Shared by
// listSnapshotSessions (full extraction) and listSnapshotSessionIds
// (just the ids, no extraction at all).
function listSnapshotSessionMembers(archivePath) {
  let listing;
  try {
    listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return [];
  }
  return listing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^projects\/[^/]+\/[^/]+\.jsonl$/.test(l));
}

// Just which session ids a snapshot contains — no extraction, no
// decompression of file contents, just the archive's member listing.
// Used by the unified-sessions merge to attach "in snapshot X" badges
// cheaply: a session's actual title/cwd/etc. only ever needs extracting
// from a snapshot when it exists in no live or mirror copy (rare) — for
// everyone else this is all a snapshot needs to contribute.
function listSnapshotSessionIds(backupRoot, archiveFile) {
  if (!SNAPSHOT_NAME_RE.test(archiveFile)) return [];
  const archivePath = path.join(snapshotsDir(backupRoot), archiveFile);
  if (!fs.existsSync(archivePath)) return [];
  return listSnapshotSessionMembers(archivePath).map((member) => path.basename(member, '.jsonl'));
}

// Lists what's inside one snapshot with full title/cwd, by extracting
// just the matched members to a temp dir and running them through the
// same single-pass analyzer used for live/mirror sessions. Context-usage
// isn't computed here — an archived, presumably-finished session doesn't
// need it. Returns null if the archive doesn't exist (caller maps that
// to 404).
function listSnapshotSessions(backupRoot, archiveFile, { contextWindowTokens } = {}) {
  if (!SNAPSHOT_NAME_RE.test(archiveFile)) return null;
  const archivePath = path.join(snapshotsDir(backupRoot), archiveFile);
  if (!fs.existsSync(archivePath)) return null;

  const sessionMembers = listSnapshotSessionMembers(archivePath);
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

// Extracts one session's .jsonl (plus its <session-id>/ subdirectory —
// subagents/tool-results — if the archive has one) from a specific
// snapshot into a fresh temp directory, for operations (generating a
// resume-brief) that need a real file on disk without touching the live
// directory or the mirror. Caller owns the returned tmpDir and must
// remove it when done. Returns null if the archive/session doesn't
// resolve to anything extractable.
function extractSessionFromSnapshot(backupRoot, archiveFile, sessionId) {
  if (!SNAPSHOT_NAME_RE.test(archiveFile) || !sessions.isSafeSessionId(sessionId)) return null;
  const archivePath = path.join(snapshotsDir(backupRoot), archiveFile);
  if (!fs.existsSync(archivePath)) return null;

  let listing;
  try {
    listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return null;
  }
  const allMembers = listing.split('\n').map((l) => l.trim()).filter(Boolean);
  const jsonlMember = allMembers.find(
    (m) => /^projects\/[^/]+\/[^/]+\.jsonl$/.test(m) && path.basename(m, '.jsonl') === sessionId,
  );
  if (!jsonlMember) return null;
  const subdirMembers = allMembers.filter((m) => m.includes(`/${sessionId}/`));
  const wanted = [jsonlMember, ...subdirMembers];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-extract-'));
  try {
    const membersFile = path.join(tmpDir, '.members');
    fs.writeFileSync(membersFile, wanted.join('\n'));
    execFileSync('tar', ['-xzf', archivePath, '-C', tmpDir, '-T', membersFile], { stdio: 'ignore' });
    return { filePath: path.join(tmpDir, jsonlMember), tmpDir };
  } catch {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return null;
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
  listSnapshotSessionIds,
  listSnapshotSessions,
  extractSessionFromSnapshot,
  deleteSnapshot,
  deleteMirrorSession,
  SNAPSHOT_NAME_RE,
};
