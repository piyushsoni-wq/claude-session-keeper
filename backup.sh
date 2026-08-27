#!/usr/bin/env bash
set -euo pipefail

# Mirrors ~/.claude/projects every run, and cuts an immutable dated
# tar.gz snapshot once every `intervalDays` (config.json). The mirror
# gets deletions propagated too (rsync --delete) — real protection
# against Claude Code's cleanup comes from the dated snapshots, which
# are never touched once written, only pruned past keepCount.

SOURCE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$REPO_ROOT/config.json"
BACKUP_ROOT="${CLAUDE_SESSION_KEEPER_BACKUP_ROOT:-$HOME/claude-session-keeper-backups}"
MIRROR_DIR="$BACKUP_ROOT/mirror"
SNAPSHOT_DIR="$BACKUP_ROOT/snapshots"

# ISO 8601 UTC, not bash's default `date` locale string — that string
# (e.g. "Thu Aug 27 22:55:12 IST 2026") is not reliably parseable by
# `new Date()` (confirmed: IST is ambiguous between several timezones
# and V8 rejects it as Invalid Date). The dashboard's automation-status
# panel parses this log's timestamps to estimate the next run, so they
# need to actually parse.
now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

if [ ! -d "$SOURCE_DIR" ]; then
  echo "[$(now_iso)] ERROR: Source directory not found: $SOURCE_DIR" >&2
  exit 1
fi

read_config() {
  node -e "
    try {
      const c = require('$CONFIG_FILE');
      const v = c['$1'];
      console.log(v === undefined ? '$2' : v);
    } catch { console.log('$2'); }
  "
}

KEEP_COUNT="$(read_config keepCount 6)"
INTERVAL_DAYS="$(read_config intervalDays 15)"

mkdir -p "$MIRROR_DIR" "$SNAPSHOT_DIR"

echo "[$(now_iso)] Mirroring $SOURCE_DIR -> $MIRROR_DIR"
rsync -a --delete "$SOURCE_DIR/" "$MIRROR_DIR/"
echo "[$(now_iso)] Mirror sync complete."

LATEST_SNAPSHOT="$(ls -1t "$SNAPSHOT_DIR"/claude-sessions-*.tar.gz 2>/dev/null | head -n1 || true)"
CUT_SNAPSHOT=1
if [ -n "$LATEST_SNAPSHOT" ]; then
  LATEST_EPOCH="$(stat -f %m "$LATEST_SNAPSHOT" 2>/dev/null || stat -c %Y "$LATEST_SNAPSHOT")"
  NOW_EPOCH="$(date +%s)"
  AGE_DAYS=$(( (NOW_EPOCH - LATEST_EPOCH) / 86400 ))
  if [ "$AGE_DAYS" -lt "$INTERVAL_DAYS" ]; then
    CUT_SNAPSHOT=0
    echo "[$(now_iso)] Last snapshot is $AGE_DAYS day(s) old (< ${INTERVAL_DAYS}d) — skipping dated snapshot."
  fi
fi

if [ "$CUT_SNAPSHOT" -eq 1 ]; then
  TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
  ARCHIVE_PATH="$SNAPSHOT_DIR/claude-sessions-${TIMESTAMP}.tar.gz"
  echo "[$(now_iso)] Cutting dated snapshot -> $ARCHIVE_PATH"
  tar -czf "$ARCHIVE_PATH" -C "$(dirname "$SOURCE_DIR")" "$(basename "$SOURCE_DIR")"
  echo "[$(now_iso)] Snapshot complete: $ARCHIVE_PATH ($(du -h "$ARCHIVE_PATH" | cut -f1))"

  cd "$SNAPSHOT_DIR"
  ls -1t claude-sessions-*.tar.gz 2>/dev/null | tail -n +$((KEEP_COUNT + 1)) | while read -r old_file; do
    echo "[$(now_iso)] Removing old snapshot: $old_file"
    rm -f "$old_file"
  done
fi

echo "[$(now_iso)] Done."
