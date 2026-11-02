#!/bin/bash
# StudioOps uninstall helper.
#
# Default behavior:
#   1. export config/data to ~/Downloads
#   2. stop the desktop app and its agent
#   3. boot out and remove every com.studioops.* LaunchAgent
#   4. keep services.yaml, SQLite, logs, PIDs and backups
#
# Optional:
#   --purge-data   delete the StudioOps data directory after exporting
#   --remove-app   delete /Applications/StudioOps.app
#   --yes          skip the confirmation prompt
set -euo pipefail
shopt -s nullglob

DATA_DIR="${STUDIOOPS_DATA_DIR:-$HOME/Library/Application Support/com.studioops.desktop}"
APP_PATH="${STUDIOOPS_APP:-/Applications/StudioOps.app}"
PURGE_DATA=0
REMOVE_APP=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: uninstall-studioops.sh [--purge-data] [--remove-app] [--yes]

  --purge-data   Export first, then delete the StudioOps data directory.
  --remove-app   Delete the StudioOps.app bundle from /Applications.
  --yes          Do not ask for confirmation.
EOF
}

for argument in "$@"; do
  case "$argument" in
    --purge-data) PURGE_DATA=1 ;;
    --remove-app) REMOVE_APP=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $argument" >&2; usage >&2; exit 2 ;;
  esac
done

case "$DATA_DIR" in
  ""|/|"$HOME") echo "Refusing unsafe data directory: $DATA_DIR" >&2; exit 1 ;;
esac
case "$APP_PATH" in
  ""|/|"$HOME") echo "Refusing unsafe app path: $APP_PATH" >&2; exit 1 ;;
esac

if [[ $ASSUME_YES -eq 0 ]]; then
  echo "StudioOps will stop, and all com.studioops.* LaunchAgents will be removed."
  echo "Data directory: $DATA_DIR"
  if [[ $PURGE_DATA -eq 1 ]]; then
    echo "The data directory will be DELETED after export."
  fi
  if [[ $REMOVE_APP -eq 1 ]]; then
    echo "The app bundle will be DELETED: $APP_PATH"
  fi
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" == [yY]* ]] || exit 0
fi

backup=""
if [[ -d "$DATA_DIR" ]]; then
  mkdir -p "$HOME/Downloads"
  backup="$HOME/Downloads/StudioOps-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
  tar -czf "$backup" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
  echo "Exported: $backup"
else
  echo "No data directory found at $DATA_DIR"
fi

osascript -e 'tell application id "com.studioops.desktop" to quit' >/dev/null 2>&1 || true
sleep 2
pkill -f "$APP_PATH/Contents/Resources/agent.cjs" >/dev/null 2>&1 || true

for plist in "$HOME/Library/LaunchAgents"/com.studioops.*.plist; do
  label="$(basename "$plist" .plist)"
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  rm -f "$plist"
  echo "Removed LaunchAgent: $label"
done

if [[ $REMOVE_APP -eq 1 ]]; then
  case "$APP_PATH" in
    /Applications/*.app|"$HOME"/Applications/*.app)
      if [[ -d "$APP_PATH" ]]; then
        rm -rf "$APP_PATH"
        echo "Removed app: $APP_PATH"
      fi
      ;;
    *) echo "Refusing to remove non-standard app path: $APP_PATH" >&2 ;;
  esac
fi

if [[ $PURGE_DATA -eq 1 ]]; then
  rm -rf "$DATA_DIR"
  echo "Removed data directory: $DATA_DIR"
fi

if [[ $PURGE_DATA -eq 1 ]]; then
  echo "StudioOps uninstalled; the data directory was removed."
else
  echo "StudioOps uninstalled; configuration and data were kept."
fi
if [[ -n "$backup" ]]; then
  echo "Backup archive: $backup"
fi
