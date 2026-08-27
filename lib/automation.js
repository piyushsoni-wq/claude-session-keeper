'use strict';

// Status for the launchd-scheduled backup job. launchd's own
// introspection (`launchctl print`) was checked directly against the
// real loaded job — it exposes state/runs/last-exit-code/run-interval
// but NO next-scheduled-fire time for a StartInterval job. "Next run"
// here is therefore computed (last completed run + interval) and must
// be presented as an estimate, not a guarantee — sleep/wake and system
// load affect launchd's actual timing.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LABEL = 'com.user.claudesessionkeeper';
// Matches scripts/com.user.claudesessionkeeper.plist.template's
// StartInterval — the mirror-sync cadence (separate from intervalDays,
// which governs the dated-snapshot cadence).
const MIRROR_RUN_INTERVAL_SECONDS = 86400;

function parsePrintOutput(output) {
  const stateMatch = output.match(/^\s*state = (.+)$/m);
  const runsMatch = output.match(/^\s*runs = (\d+)/m);
  const exitMatch = output.match(/^\s*last exit code = (-?\d+)/m);
  return {
    state: stateMatch ? stateMatch[1].trim() : null,
    runs: runsMatch ? Number(runsMatch[1]) : null,
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
  };
}

function getLaunchdStatus() {
  let output;
  try {
    output = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { installed: false, state: null, runs: null, lastExitCode: null };
  }
  return { installed: true, ...parsePrintOutput(output) };
}

// backup.sh logs "[<ISO 8601 timestamp>] Done." as its last line on
// every successful run. Scans from the end so the newest valid entry
// wins even if older log lines predate the ISO-timestamp fix (bash's
// default `date` locale string, e.g. "Thu Aug 27 22:55:12 IST 2026", is
// not reliably parseable by `new Date()` — confirmed, "IST" alone is
// ambiguous across timezones and V8 rejects it as Invalid Date).
function lastCompletedRunAt(backupRoot) {
  let content;
  try {
    content = fs.readFileSync(path.join(backupRoot, 'backup.log'), 'utf8');
  } catch {
    return null;
  }
  const lines = content.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^\[(.+?)\] Done\.$/);
    if (!match) continue;
    const d = new Date(match[1]);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function latestSnapshotAt(backupRoot) {
  const snapshotDir = path.join(backupRoot, 'snapshots');
  let files;
  try {
    files = fs.readdirSync(snapshotDir).filter((f) => f.startsWith('claude-sessions-') && f.endsWith('.tar.gz'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const mtimes = files.map((f) => fs.statSync(path.join(snapshotDir, f)).mtimeMs);
  return new Date(Math.max(...mtimes));
}

function getAutomationStatus(backupRoot, intervalDays) {
  const launchd = getLaunchdStatus();
  const lastMirrorRunAt = lastCompletedRunAt(backupRoot);
  const lastSnapshotAt = latestSnapshotAt(backupRoot);

  return {
    ...launchd,
    mirrorRunIntervalSeconds: MIRROR_RUN_INTERVAL_SECONDS,
    lastMirrorRunAt: lastMirrorRunAt ? lastMirrorRunAt.toISOString() : null,
    estimatedNextMirrorRunAt: lastMirrorRunAt
      ? new Date(lastMirrorRunAt.getTime() + MIRROR_RUN_INTERVAL_SECONDS * 1000).toISOString()
      : null,
    intervalDays,
    lastSnapshotAt: lastSnapshotAt ? lastSnapshotAt.toISOString() : null,
    estimatedNextSnapshotAt: lastSnapshotAt
      ? new Date(lastSnapshotAt.getTime() + intervalDays * 86400000).toISOString()
      : null,
  };
}

module.exports = { getAutomationStatus, LABEL, MIRROR_RUN_INTERVAL_SECONDS };
