#!/usr/bin/env bash
set -euo pipefail

# Restores from the mirror, the latest dated snapshot, a specific
# archive, or one specific session. Always merges with --ignore-existing:
# an existing file at the target is never overwritten, only gaps are
# filled in — safe to run straight against the live ~/.claude/projects
# even while a Claude Code session is open and actively appending to its
# own file.
#
# IMPORTANT: rsync -a preserves the source file's mtime. A restored
# session with its original (already cleanup-eligible) mtime would just
# get deleted again by Claude Code's own cleanup on its next startup —
# confirmed with a real touch+rsync test. So when (and only when) the
# restore target is the live SOURCE_DIR, every file actually restored in
# this run gets its mtime reset to now. A --target override (restoring
# elsewhere to inspect/export) keeps original timestamps, which is what
# you'd want there.

SOURCE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
BACKUP_ROOT="${CLAUDE_SESSION_KEEPER_BACKUP_ROOT:-$HOME/claude-session-keeper-backups}"
MIRROR_DIR="$BACKUP_ROOT/mirror"
SNAPSHOT_DIR="$BACKUP_ROOT/snapshots"

usage() {
  echo "Usage:" >&2
  echo "  restore.sh --mirror [--target DIR]" >&2
  echo "  restore.sh --latest [--target DIR]" >&2
  echo "  restore.sh <archive-path> [--target DIR]" >&2
  echo "  restore.sh --session <session-id> --source (mirror|<archive-path>) [--target DIR]" >&2
  echo "  Default target: $SOURCE_DIR (live Claude Code sessions)." >&2
  exit 1
}

[ $# -ge 1 ] || usage

MODE="$1"
shift

SESSION_ID=""
if [ "$MODE" = "--session" ]; then
  [ $# -ge 1 ] || usage
  SESSION_ID="$1"
  shift
fi

TARGET="$SOURCE_DIR"
SOURCE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --source)
      SOURCE_ARG="$2"
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

  local itemized
  itemized="$(rsync -a --ignore-existing --itemize-changes "$src/" "$TARGET/")"
  echo "$itemized"

  if [ "$TARGET" = "$SOURCE_DIR" ]; then
    # >f+++++++ <path> = a file rsync actually transferred (as opposed to
    # one --ignore-existing skipped). Strip the itemize flags, keep the
    # path (which may itself contain spaces), touch just those.
    #
    # `grep '^>f' || true`: under `set -o pipefail` (on, see top of this
    # script), a pipeline's exit status is the rightmost non-zero exit
    # among its stages — and grep exits 1 when it finds no matches. That
    # makes "nothing needed restoring, everything already existed" (a
    # normal, common outcome, not a failure) abort the whole script
    # under `set -e`. Confirmed the hard way: a restore where every
    # session was already present exited 1. The `|| true` neutralizes
    # just that one stage's exit code without touching what it prints.
    echo "$itemized" | { grep '^>f' || true; } | sed -E 's/^[^ ]+ //' | while IFS= read -r relpath; do
      [ -n "$relpath" ] && touch "$TARGET/$relpath"
    done
  fi
}

restore_from_archive() {
  local archive="$1"
  RESTORE_TMP_DIR="$(mktemp -d)"
  tar -xzf "$archive" -C "$RESTORE_TMP_DIR"
  restore_from_dir "$RESTORE_TMP_DIR/projects"
}

# Copies just one session (its .jsonl plus a matching <session-id>/
# subdirectory, if the session spawned subagents) out of the mirror,
# preserving the encoded-project-dir structure, then reuses
# restore_from_dir so the mtime-touch logic above applies here too.
restore_session_from_mirror() {
  local session_id="$1"
  local match
  match="$(find "$MIRROR_DIR" -mindepth 2 -maxdepth 2 -name "${session_id}.jsonl" 2>/dev/null | head -n1 || true)"
  if [ -z "$match" ]; then
    echo "[$(date)] ERROR: Session $session_id not found in mirror" >&2
    exit 1
  fi
  local project_dir_name
  project_dir_name="$(basename "$(dirname "$match")")"

  RESTORE_TMP_DIR="$(mktemp -d)"
  mkdir -p "$RESTORE_TMP_DIR/$project_dir_name"
  cp "$match" "$RESTORE_TMP_DIR/$project_dir_name/"
  local session_subdir="$MIRROR_DIR/$project_dir_name/$session_id"
  if [ -d "$session_subdir" ]; then
    cp -R "$session_subdir" "$RESTORE_TMP_DIR/$project_dir_name/"
  fi
  restore_from_dir "$RESTORE_TMP_DIR"
}

# Same idea, but the source is a dated archive: list its members, filter
# to just this session's file + subdirectory, extract only those (exact
# paths, not glob patterns — behaves the same on GNU tar and macOS's
# bsdtar), then reuse restore_from_dir.
#
# `-T -` (read the member list from stdin) is a GNU tar-ism — macOS's
# bsdtar errors "Failed to open '-'" on it (confirmed) and needs an
# actual file path, so the matched member list is written to a real temp
# file first.
restore_session_from_archive() {
  local archive="$1" session_id="$2"
  RESTORE_TMP_DIR="$(mktemp -d)"

  local members_file="$RESTORE_TMP_DIR/.members"
  tar -tzf "$archive" | grep -E "/${session_id}\.jsonl\$|/${session_id}/" > "$members_file" || true
  if [ ! -s "$members_file" ]; then
    echo "[$(date)] ERROR: Session $session_id not found in $archive" >&2
    exit 1
  fi
  tar -xzf "$archive" -C "$RESTORE_TMP_DIR" -T "$members_file"
  restore_from_dir "$RESTORE_TMP_DIR/projects"
}

case "$MODE" in
  --session)
    [ -n "$SOURCE_ARG" ] || usage
    if [ "$SOURCE_ARG" = "mirror" ]; then
      restore_session_from_mirror "$SESSION_ID"
    else
      restore_session_from_archive "$SOURCE_ARG" "$SESSION_ID"
    fi
    ;;
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
