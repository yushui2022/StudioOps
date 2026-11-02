#!/bin/bash
# Install Warpgate's SSH client public key into the compute user's
# authorized_keys. Run once with sudo after Warpgate is running.
set -euo pipefail

USER_NAME="${COMPUTE_USER:-compute}"
CONTAINER="${WARPGATE_CONTAINER:-studioops-warpgate}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash scripts/install-warpgate-key.sh" >&2
  exit 1
fi

if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "User $USER_NAME does not exist" >&2
  exit 1
fi

DOCKER_CMD=(docker)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  DOCKER_CMD=(sudo -u "$SUDO_USER" docker)
fi
KEY_LINE="$("${DOCKER_CMD[@]}" exec "$CONTAINER" warpgate --config /data/warpgate.yaml client-keys 2>/dev/null | awk '/client-ed25519/ {print $1" "$2; exit}')"
if [ -z "$KEY_LINE" ]; then
  echo "Could not read Warpgate client key from container $CONTAINER" >&2
  exit 1
fi

HOME_DIR="$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory | awk '{print $2}')"
if [ -z "$HOME_DIR" ]; then
  echo "Could not resolve home directory for $USER_NAME" >&2
  exit 1
fi

mkdir -p "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
if ! grep -qxF "$KEY_LINE" "$HOME_DIR/.ssh/authorized_keys"; then
  printf '%s\n' "$KEY_LINE" >> "$HOME_DIR/.ssh/authorized_keys"
fi
chown -R "$USER_NAME":staff "$HOME_DIR/.ssh"
chmod 700 "$HOME_DIR/.ssh"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"

echo "Installed Warpgate public key for $USER_NAME"
echo "Test from this Mac:"
echo "  ssh -p 2222 compute-guest:mac-compute@127.0.0.1"
