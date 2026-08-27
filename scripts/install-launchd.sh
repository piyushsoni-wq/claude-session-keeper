#!/usr/bin/env bash
set -euo pipefail

# Renders the plist template with this repo's absolute path and loads it.
# Safe to re-run: unloads any existing job with the same label first.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${CLAUDE_SESSION_KEEPER_BACKUP_ROOT:-$HOME/claude-session-keeper-backups}"
TEMPLATE="$REPO_ROOT/scripts/com.user.claudesessionkeeper.plist.template"
PLIST_LABEL="com.user.claudesessionkeeper"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

if [ "$(uname)" != "Darwin" ]; then
  echo "launchd is macOS-only. Set up a cron/systemd-timer equivalent that runs backup.sh instead." >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT" "$HOME/Library/LaunchAgents"

# launchd jobs run with a minimal PATH (no nvm/homebrew dirs) — backup.sh
# shells out to `node` to read config.json, so without this it fails
# silently under launchd even though it works fine interactively. Bake in
# this shell's actual PATH at install time.
sed -e "s#__REPO_ROOT__#${REPO_ROOT}#g" -e "s#__BACKUP_ROOT__#${BACKUP_ROOT}#g" -e "s#__PATH__#${PATH}#g" "$TEMPLATE" > "$PLIST_DEST"
echo "Wrote $PLIST_DEST"

if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  echo "Unloading existing $PLIST_LABEL before reload…"
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

launchctl load "$PLIST_DEST"
echo "Loaded $PLIST_LABEL. Forcing one run to verify…"
launchctl start "$PLIST_LABEL"

echo ""
echo "Check logs at:"
echo "  $BACKUP_ROOT/backup.log"
echo "  $BACKUP_ROOT/backup-error.log"
echo ""
echo "Once you've confirmed that run succeeded, if you have an older ad hoc"
echo "backup job, unload it so it doesn't run alongside this one, e.g.:"
echo "  launchctl unload ~/Library/LaunchAgents/<old-label>.plist"
