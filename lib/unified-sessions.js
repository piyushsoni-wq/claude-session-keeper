'use strict';

// Merges live + mirror + every snapshot's session listing into one row
// per session id — never duplicated across sources. Priority when the
// same session exists in more than one place (confirmed with the user):
// Live > Mirror > the newest snapshot that has it. Live is the freshest
// possible copy of the truth; Mirror can lag by up to one backup cycle;
// a snapshot is a frozen point-in-time copy, so it's the last resort,
// and among snapshots the newest is the best guess at the session's
// last-known state.

const sessions = require('./sessions');
const backups = require('./backups');

function listUnifiedSessions(backupRoot, { contextWindowTokens } = {}) {
  const liveList = sessions.listLiveSessions(contextWindowTokens);
  const mirrorList = sessions.listSessionsInDir(backups.mirrorDir(backupRoot), { contextWindowTokens });
  const snapshotList = backups.listSnapshots(backupRoot); // already newest-first

  const liveById = new Map(liveList.map((s) => [s.sessionId, s]));
  const mirrorById = new Map(mirrorList.map((s) => [s.sessionId, s]));

  // sessionId -> [snapshot filenames containing it], newest-first (since
  // snapshotList itself is newest-first and we push in that order).
  const snapshotFilesById = new Map();
  for (const snap of snapshotList) {
    for (const id of backups.listSnapshotSessionIds(backupRoot, snap.file)) {
      if (!snapshotFilesById.has(id)) snapshotFilesById.set(id, []);
      snapshotFilesById.get(id).push(snap.file);
    }
  }
  const snapshotMtimeByFile = new Map(snapshotList.map((s) => [s.file, s.mtimeMs]));

  // Only sessions with NO live/mirror copy need real data extracted from
  // a snapshot. Group those by which snapshot file will supply it, so a
  // given archive is extracted at most once total, regardless of how
  // many snapshot-only sessions it needs to supply data for.
  const idsNeedingExtraction = new Map(); // snapshotFile -> Set<sessionId>
  for (const [id, files] of snapshotFilesById) {
    if (liveById.has(id) || mirrorById.has(id)) continue;
    const newestFile = files[0];
    if (!idsNeedingExtraction.has(newestFile)) idsNeedingExtraction.set(newestFile, new Set());
    idsNeedingExtraction.get(newestFile).add(id);
  }
  const extractedById = new Map();
  for (const [file, idSet] of idsNeedingExtraction) {
    const extracted = backups.listSnapshotSessions(backupRoot, file) || [];
    for (const s of extracted) {
      if (idSet.has(s.sessionId)) extractedById.set(s.sessionId, s);
    }
  }

  const allIds = new Set([...liveById.keys(), ...mirrorById.keys(), ...snapshotFilesById.keys()]);

  const rows = [];
  for (const id of allIds) {
    const live = liveById.get(id);
    const mirror = mirrorById.get(id);
    const snapshotFiles = snapshotFilesById.get(id) || [];
    const isSnapshotOnly = !live && !mirror;
    const base = live || mirror || extractedById.get(id) || { cwd: null, title: null, encodedProjectDir: null };

    rows.push({
      sessionId: id,
      title: base.title,
      cwd: base.cwd,
      encodedProjectDir: base.encodedProjectDir,
      inLive: !!live,
      inMirror: !!mirror,
      inSnapshots: snapshotFiles,
      snapshotOnly: isSnapshotOnly,
      // For a snapshot-only row, "last active" isn't a live signal — it's
      // the archive's own cut date. Flagged via snapshotOnly so the UI
      // can label it "as of snapshot from <date>" instead of implying
      // the session itself was touched then.
      mtimeMs: live ? live.mtimeMs : mirror ? mirror.mtimeMs : (snapshotMtimeByFile.get(snapshotFiles[0]) ?? null),
      sizeBytes: live ? live.sizeBytes : mirror ? mirror.sizeBytes : null,
      contextTokens: live ? live.contextTokens : mirror ? mirror.contextTokens : null,
      contextRatio: live ? live.contextRatio : mirror ? mirror.contextRatio : null,
      contextUnknown: live ? live.contextUnknown : mirror ? mirror.contextUnknown : true,
    });
  }

  rows.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return rows;
}

module.exports = { listUnifiedSessions };
