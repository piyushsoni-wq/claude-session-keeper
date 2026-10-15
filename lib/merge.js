'use strict';

// Restoring a session that already exists live is normally a no-op —
// restore.sh's rsync --ignore-existing skips the whole file untouched the
// moment it sees something already there at the target. That's the right
// default for "fill in what's missing," but it means a session that
// exists in BOTH live and mirror with genuinely different content (either
// copy could be ahead: Claude Code's own auto-compaction rewrites what
// the *next* API call sends but never deletes prior transcript lines, a
// stale mirror can lag behind live, or a live file can in principle lag
// behind an untouched mirror) never gets reconciled — whichever side has
// something the other doesn't just stays missing from the merged result.
//
// This does a real content-level union instead: every transcript line
// from both copies, deduplicated by its own `uuid` (every real Claude
// Code transcript line carries one), sorted back into chronological order
// by `timestamp`. The result is written back as the new live file, so
// nothing either copy had is ever lost regardless of which direction the
// two diverged.

const fs = require('fs');

const sessions = require('./sessions');
const backups = require('./backups');

// Matches the dashboard's existing "might be an open Claude Code session
// right now" heuristic (see deleteSession in dashboard/public/backups.js)
// — refuse to rewrite a live file that could still be mid-append.
const ACTIVE_SESSION_GUARD_MS = 5 * 60 * 1000;

// Exported separately from mergeSessionIntoLive so it's testable on plain
// strings/fixtures without touching any real file.
function mergeSessionContent(liveRaw, mirrorRaw) {
  const liveLines = parseLinesFromString(liveRaw);
  const mirrorLines = parseLinesFromString(mirrorRaw);

  const byUuid = new Map();
  const noUuid = []; // entries without a uuid can't be deduplicated — keep every one, both sides
  // Mirror first, live second: on a genuine uuid collision the two
  // copies should already be byte-identical (mirror is just an earlier
  // rsync of live), so which one wins doesn't matter — live is kept as
  // the nominal winner since it's the fresher source.
  for (const { raw, entry } of mirrorLines) {
    if (entry && typeof entry.uuid === 'string') byUuid.set(entry.uuid, { raw, entry });
    else noUuid.push({ raw, entry });
  }
  for (const { raw, entry } of liveLines) {
    if (entry && typeof entry.uuid === 'string') byUuid.set(entry.uuid, { raw, entry });
    else noUuid.push({ raw, entry });
  }

  const merged = [...byUuid.values(), ...noUuid];
  merged.sort((a, b) => {
    const ta = (a.entry && a.entry.timestamp) || '';
    const tb = (b.entry && b.entry.timestamp) || '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  const beforeLines = liveLines.length;
  const afterLines = merged.length;
  const content = merged.length > 0 ? `${merged.map((m) => m.raw).join('\n')}\n` : '';
  return { content, beforeLines, afterLines, addedLines: afterLines - beforeLines };
}

function parseLinesFromString(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    out.push({ raw: trimmed, entry });
  }
  return out;
}

// Merges a session's live and mirror copies and writes the result back to
// the live file (atomically: write to a temp path, then rename over it).
// The pre-merge live file is kept alongside it as a timestamped .bak, not
// deleted — this operation is meant to be safe to retry/undo, not a
// one-way door.
function mergeSessionIntoLive(backupRoot, sessionId) {
  if (!sessions.isSafeSessionId(sessionId)) {
    throw new Error('Invalid sessionId');
  }

  const liveFilePath = sessions.findSessionFile(sessionId);
  const mirrorFilePath = sessions.findSessionFileIn(backups.mirrorDir(backupRoot), sessionId);

  if (!liveFilePath) {
    throw new Error('No live copy of this session — use Restore instead of merge.');
  }
  if (!mirrorFilePath) {
    throw new Error('No mirror copy of this session — nothing to merge.');
  }

  const liveStat = fs.statSync(liveFilePath);
  if (Date.now() - liveStat.mtimeMs < ACTIVE_SESSION_GUARD_MS) {
    throw new Error(
      'This session was modified in the last 5 minutes — it may be an open Claude Code session right now. '
      + 'Merging would rewrite a file Claude Code could still be appending to. Wait a few minutes and try again.',
    );
  }

  const liveRaw = fs.readFileSync(liveFilePath, 'utf8');
  const mirrorRaw = fs.readFileSync(mirrorFilePath, 'utf8');
  const { content, beforeLines, afterLines, addedLines } = mergeSessionContent(liveRaw, mirrorRaw);

  if (addedLines <= 0) {
    return { beforeLines, afterLines, addedLines, backupPath: null, changed: false };
  }

  const backupPath = `${liveFilePath}.pre-merge-${Date.now()}.bak`;
  fs.copyFileSync(liveFilePath, backupPath);

  const tmpPath = `${liveFilePath}.merge-tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, liveFilePath);

  return { beforeLines, afterLines, addedLines, backupPath, changed: true };
}

module.exports = { mergeSessionContent, mergeSessionIntoLive, ACTIVE_SESSION_GUARD_MS };
