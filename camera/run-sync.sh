#!/bin/sh
# Find a node and run the card sync. Installed to /usr/local/lib/totem-camera/.
#
# This wrapper exists for one reason: node on this box is installed by nvm, under
# ~/.nvm/versions/node/<version>/bin/node. A systemd unit gets none of
# the shell profile that puts it on PATH, and the version in that path changes
# every time node is upgraded — so a unit with a hardcoded ExecStart works right
# up until an `nvm install`, then silently stops firing.
#
# Resolution order: an explicit override, then system-wide installs, then the
# newest nvm version. Configure NODE_BIN in /etc/default/totem-camera to pin it.
set -eu

REPO="__REPO__"
NVM_ROOT="__NVM_ROOT__"

if [ -z "${NODE_BIN:-}" ]; then
  for candidate in /usr/local/bin/node /usr/bin/node /snap/bin/node; do
    [ -x "$candidate" ] && { NODE_BIN="$candidate"; break; }
  done
fi

if [ -z "${NODE_BIN:-}" ] && [ -d "$NVM_ROOT" ]; then
  # sort -V so v22 beats v9, which a plain sort gets backwards.
  NODE_BIN=$(find "$NVM_ROOT" -mindepth 3 -maxdepth 3 -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -1)
fi

if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[camera-sync] no usable node found (looked in /usr/local/bin, /usr/bin, $NVM_ROOT)" >&2
  echo "[camera-sync] set NODE_BIN=/path/to/node in /etc/default/totem-camera" >&2
  exit 127
fi

# So the installer can report which interpreter this resolves to, and so the
# answer can be checked later without plugging a camera in.
if [ "${1:-}" = "--print-node" ]; then
  echo "$NODE_BIN"
  exit 0
fi

exec "$NODE_BIN" "$REPO/camera/sync.mjs" "$@"
