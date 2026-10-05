#!/bin/sh
# Run a repo script under whichever node this box has. `with-node.sh camera/ack.mjs`
#
# A non-interactive ssh session — which is how the MacBook reaches this box —
# runs a non-login shell, so ~/.zshrc never runs, so nvm never initialises, so
# there is no `node` on PATH. Every remote invocation goes through here.
#
# The udev path has the same problem for a different reason and solves it
# differently: see run-sync.sh, which needs paths baked in at install time
# because it runs as root with no HOME at all.
set -eu

if [ -z "${NODE_BIN:-}" ]; then
  # /opt/homebrew is Apple Silicon; /usr/local covers Intel Homebrew and Linux.
  # A launchd agent gets PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else, so
  # Homebrew's node is no more on PATH here than nvm's is under systemd.
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /snap/bin/node; do
    [ -x "$candidate" ] && { NODE_BIN="$candidate"; break; }
  done
fi

if [ -z "${NODE_BIN:-}" ] && [ -d "${HOME:-/nonexistent}/.nvm/versions/node" ]; then
  NODE_BIN=$(find "$HOME/.nvm/versions/node" -mindepth 3 -maxdepth 3 -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -1)
fi

if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "with-node.sh: no node found; set NODE_BIN" >&2
  exit 127
fi

exec "$NODE_BIN" "$@"
