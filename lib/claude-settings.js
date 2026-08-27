'use strict';

// Reads and writes ~/.claude/settings.json's `cleanupPeriodDays` — this
// is Claude Code's OWN settings file, shared with hooks/model/etc.
// config that this tool has nothing to do with, so every write here:
//   - only ever touches the cleanupPeriodDays key, nothing else
//   - keeps a timestamped backup copy before writing (pruned to the
//     last 5) so a bad write is always recoverable
//   - writes to a temp file and renames over the original (atomic — no
//     window where the file is half-written)

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BACKUPS = 5;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}

function readCleanupPeriodDays() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const settings = JSON.parse(raw);
    const value = settings.cleanupPeriodDays;
    if (typeof value === 'number' && value > 0) return value;
  } catch {
    // missing/unreadable/invalid settings.json — fall through to default
  }
  return 30;
}

function pruneOldBackups(dir, prefix) {
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }
  for (const { f } of files.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      // best effort — a leftover backup file is harmless
    }
  }
}

function writeCleanupPeriodDays(days) {
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('cleanupPeriodDays must be a positive number');
  }

  const target = settingsPath();
  const dir = path.dirname(target);
  const raw = fs.readFileSync(target, 'utf8');
  const settings = JSON.parse(raw); // let a malformed settings.json throw — refuse to guess its shape

  const backupPath = path.join(dir, `settings.json.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.writeFileSync(backupPath, raw, 'utf8');
  pruneOldBackups(dir, 'settings.json.bak-');

  settings.cleanupPeriodDays = value;
  const tmpPath = path.join(dir, `.settings.json.tmp-${process.pid}`);
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmpPath, target);

  return value;
}

module.exports = {
  claudeDir,
  settingsPath,
  readCleanupPeriodDays,
  writeCleanupPeriodDays,
};
