#!/usr/bin/env bash
set -euo pipefail

# Restores from the mirror, the latest dated snapshot, or a specific
# archive. Always merges with --ignore-existing: an existing file at the
# target is never overwritten, only gaps are filled in. That makes it
# safe to run straight against the live ~/.claude/projects even while a
# Claude Code session is open and actively appending to its own file.

SOURCE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
BACKUP_ROOT="${CLAUDE_SESSION_KEEPER_BACKUP_ROOT:-$HOME/claude-session-keeper-backups}"
MIRROR_DIR="$BACKUP_ROOT/mirror"
SNAPSHOT_DIR="$BACKUP_ROOT/snapshots"

usage() {
  echo "Usage: restore.sh (--mirror | --latest | <archive-path>) [--target DIR]" >&2
  echo "  Default target: $SOURCE_DIR (live Claude Code sessions)." >&2
  exit 1
}

[ $# -ge 1 ] || usage

MODE="$1"
shift
TARGET="$SOURCE_DIR"

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

mkdir -p "$TARGET"

# A trap set *inside* a function with a `local` tmp_dir fires at process
# exit, by which point that local has gone out of scope — under `set -u`
# that's an unbound-variable error, not a clean exit. Use one script-level
# variable and a single top-level trap instead.
RESTORE_TMP_DIR=""
cleanup() {
  if [ -n "$RESTORE_TMP_DIR" ] && [ -d "$RESTORE_TMP_DIR" ]; then
    rm -rf "$RESTORE_TMP_DIR"
  fi
}
trap cleanup EXIT

restore_from_dir() {
  local src="$1"
  echo "[$(date)] Restoring $src -> $TARGET (existing files kept as-is)"
  rsync -a --ignore-existing "$src/" "$TARGET/"
}

restore_from_archive() {
  local archive="$1"
  RESTORE_TMP_DIR="$(mktemp -d)"
  tar -xzf "$archive" -C "$RESTORE_TMP_DIR"
  restore_from_dir "$RESTORE_TMP_DIR/projects"
}

case "$MODE" in
  --mirror)
    if [ ! -d "$MIRROR_DIR" ]; then
      echo "[$(date)] ERROR: No mirror found at $MIRROR_DIR — run backup.sh first." >&2
      exit 1
    fi
    restore_from_dir "$MIRROR_DIR"
    ;;
  --latest)
    ARCHIVE="$(ls -1t "$SNAPSHOT_DIR"/claude-sessions-*.tar.gz 2>/dev/null | head -n1 || true)"
    if [ -z "$ARCHIVE" ]; then
      echo "[$(date)] ERROR: No dated snapshots found in $SNAPSHOT_DIR" >&2
      exit 1
    fi
    restore_from_archive "$ARCHIVE"
    ;;
  --*)
    usage
    ;;
  *)
    if [ ! -f "$MODE" ]; then
      echo "[$(date)] ERROR: Archive not found: $MODE" >&2
      exit 1
    fi
    restore_from_archive "$MODE"
    ;;
esac

echo "[$(date)] Restore complete."
