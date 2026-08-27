#!/usr/bin/env bash
set -euo pipefail

# Pauses the scheduled backup job (launchctl unload). The rendered plist
# file is left in place at ~/Library/LaunchAgents so `install-launchd.sh`
# can turn it back on later without needing to re-render anything — this
# is a pause, not an uninstall.

PLIST_LABEL="com.user.claudesessionkeeper"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

if [ "$(uname)" != "Darwin" ]; then
  echo "launchd is macOS-only." >&2
  exit 1
fi

if [ ! -f "$PLIST_DEST" ]; then
  echo "Nothing to stop — $PLIST_DEST doesn't exist (never installed)."
  exit 0
fi

if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  launchctl unload "$PLIST_DEST"
  echo "Stopped $PLIST_LABEL. Automatic backups will not run until you start it again."
else
  echo "$PLIST_LABEL was already stopped."
fi
