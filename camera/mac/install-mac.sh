#!/bin/bash
# Install the macOS side of the camera sync. Run this ON THE MAC.
#
#   ./install-mac.sh              # both halves
#   ./install-mac.sh --local-only # cards plugged into this Mac; ignore the Linux box
#   ./install-mac.sh --uninstall
#
# Installs two launchd agents:
#   com.totem.camera-pull   fires on volume mount — a card plugged in HERE
#   com.totem.photo-import  every 15 min — imports whatever is staged, from
#                            either machine, into Photos
#
# No root needed. Passwordless ssh to the Linux box is set up if it isn't already
# and you didn't pass --local-only.
set -uo pipefail

LABEL_IMPORT=com.totem.photo-import
LABEL_PULL=com.totem.camera-pull
AGENT_DIR="$HOME/Library/LaunchAgents"
BIN_DIR="$HOME/.local/bin"
LIB_DIR="$HOME/.local/lib/totem-camera"
LOG="$HOME/Library/Logs/totem-photo-import.log"
CONF="$HOME/.config/totem-photo-import.conf"

# The Linux box: its tailnet hostname, and the account that owns the Totem
# checkout there. A reinstall keeps whatever the existing config already names;
# a first install needs REMOTE_HOST set (or --local-only).
for saved_conf in "$CONF" "$HOME/.config/vesper-photo-import.conf"; do
  [[ -f "$saved_conf" ]] || continue
  REMOTE_HOST=${REMOTE_HOST:-$(. "$saved_conf" >/dev/null 2>&1; echo "${REMOTE_HOST:-}")}
  REMOTE_USER=${REMOTE_USER:-$(. "$saved_conf" >/dev/null 2>&1; echo "${REMOTE_USER:-}")}
  break
done
REMOTE_HOST=${REMOTE_HOST:-}
REMOTE_USER=${REMOTE_USER:-$(id -un)}
REMOTE_STAGING=${REMOTE_STAGING:-/home/$REMOTE_USER/Pictures/camera-inbox}
REMOTE_REPO=${REMOTE_REPO:-/home/$REMOTE_USER/projects/totem}
REMOTE="$REMOTE_USER@$REMOTE_HOST"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warning:\033[0m %s\n' "$*"; }

[[ "$(uname -s)" == "Darwin" ]] || { echo "this is the macOS half — run it on the Mac" >&2; exit 1; }

# ---- legacy (pre-2026-10-02 rename) ------------------------------------------
# A Mac that ran this as Vesper still has com.vesper.* agents loaded, with their
# own ledgers under the old names — left alone, both pairs run and every photo
# imports twice. Unload the old agents and carry the state, config and inbox over
# under the new names. Drop once every Mac has been reinstalled as Totem.
LEGACY_LABELS=(com.vesper.camera-pull com.vesper.photo-import)
remove_legacy_agents() {
  local label
  for label in "${LEGACY_LABELS[@]}"; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null \
      || launchctl unload "$AGENT_DIR/$label.plist" 2>/dev/null
    [[ -f "$AGENT_DIR/$label.plist" ]] && rm -fv "$AGENT_DIR/$label.plist"
  done
  rm -f "$BIN_DIR/vesper-photo-import.sh" "$BIN_DIR/vesper-camera-pull.sh"
}
move_legacy() {
  local from="$1" to="$2"
  [[ -e "$from" && ! -e "$to" ]] || return 1
  mv "$from" "$to" && say "moved $from -> $to"
}
migrate_legacy() {
  remove_legacy_agents
  move_legacy "$HOME/.local/state/vesper-camera" "$HOME/.local/state/totem-camera"
  move_legacy "$HOME/.local/state/vesper-photo-import" "$HOME/.local/state/totem-photo-import"
  move_legacy "$HOME/.local/lib/vesper-camera" "$LIB_DIR"
  move_legacy "$HOME/Pictures/VesperCameraInbox" "$HOME/Pictures/TotemCameraInbox"
  move_legacy "$HOME/Library/Logs/vesper-photo-import.log" "$LOG"
  if move_legacy "$HOME/.config/vesper-photo-import.conf" "$CONF"; then
    # The old conf spells out the old paths; point it at the moved ones.
    sed -i '' -e 's|/vesper-camera|/totem-camera|g' -e 's|VesperCameraInbox|TotemCameraInbox|g' "$CONF"
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  say "removing both agents"
  remove_legacy_agents
  for label in "$LABEL_PULL" "$LABEL_IMPORT"; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null \
      || launchctl unload "$AGENT_DIR/$label.plist" 2>/dev/null
    rm -fv "$AGENT_DIR/$label.plist"
  done
  rm -fv "$BIN_DIR/totem-photo-import.sh" "$BIN_DIR/totem-camera-pull.sh"
  rm -rfv "$LIB_DIR" "$HOME/.local/lib/vesper-camera"
  say "left alone: your Photos library, and the staged copies in ~/Pictures"
  exit 0
fi

LOCAL_ONLY=false
[[ "${1:-}" == "--local-only" ]] && LOCAL_ONLY=true

if [[ "$LOCAL_ONLY" != "true" && -z "$REMOTE_HOST" ]]; then
  echo "set REMOTE_HOST to the Linux box's hostname on your tailnet, e.g." >&2
  echo "  REMOTE_HOST=my-box.tailnet-name.ts.net $0" >&2
  echo "or pass --local-only to handle cards plugged into this Mac only." >&2
  exit 1
fi

# Must run before anything below creates the new dirs, or the moves are skipped.
migrate_legacy

# ---- node --------------------------------------------------------------------
# The engine — dedupe ledger, EXIF date parsing, archiving — is the same Node
# code the Linux box runs. A launchd agent's PATH is /usr/bin:/bin:/usr/sbin:/sbin,
# so Homebrew's node is no more visible there than nvm's is under systemd; the
# with-node.sh wrapper is what bridges that, and this proves it works now rather
# than the first time a card goes in.
mkdir -p "$LIB_DIR"
install -m 755 "$REPO/camera/with-node.sh" "$LIB_DIR/with-node.sh"
if ! resolved_node="$(env -i HOME="$HOME" "$LIB_DIR/with-node.sh" --version 2>/dev/null)"; then
  echo "no node found." >&2
  echo "  Install it:  brew install node" >&2
  echo "  Or point at one: NODE_BIN=/path/to/node $0" >&2
  exit 1
fi
say "node:    $resolved_node"

# ---- the engine --------------------------------------------------------------
# Copied rather than referenced, so the agents don't break if this checkout is
# moved or deleted.
for module in paths.mjs exif.mjs ledger.mjs volumes.mjs sync.mjs ack.mjs; do
  install -m 644 "$REPO/camera/$module" "$LIB_DIR/$module"
done
chmod 755 "$LIB_DIR/sync.mjs" "$LIB_DIR/ack.mjs" "$LIB_DIR/volumes.mjs"
say "engine:  $LIB_DIR"

mkdir -p "$BIN_DIR" "$AGENT_DIR" "$(dirname "$LOG")" \
  "$HOME/Pictures/camera-inbox" "$HOME/Pictures/TotemCameraInbox"
install -m 755 "$HERE/totem-photo-import.sh" "$BIN_DIR/totem-photo-import.sh"
install -m 755 "$HERE/totem-camera-pull.sh" "$BIN_DIR/totem-camera-pull.sh"
say "scripts: $BIN_DIR"

# ---- ssh to the Linux box ----------------------------------------------------
if [[ "$LOCAL_ONLY" == "true" ]]; then
  say "--local-only: skipping the Linux box entirely"
elif ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" true 2>/dev/null; then
  warn "cannot ssh to $REMOTE without a password yet"
  [[ -f "$HOME/.ssh/id_ed25519" ]] || ssh-keygen -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519"
  say "copying your key over — this asks for the Linux box's password once"
  if ssh-copy-id -i "$HOME/.ssh/id_ed25519.pub" "$REMOTE" 2>/dev/null; then
    say "ssh works"
  else
    # Not fatal. Cards plugged into this Mac work regardless; only the pull from
    # the Linux box needs this, and it can be fixed later.
    warn "key copy failed (is the Linux box awake and on the tailnet?)"
    warn "cards plugged into THIS Mac will still work; re-run this later to fix the remote pull"
    LOCAL_ONLY=true
  fi
else
  say "ssh works"
fi

# ---- config ------------------------------------------------------------------
if [[ -f "$CONF" ]]; then
  say "keeping existing $CONF"
else
  mkdir -p "$(dirname "$CONF")"
  cat > "$CONF" <<EOF
# Read by both agents. See docs/camera-sync.md.

# A card plugged into THIS Mac lands here, and is archived here after import.
LOCAL_STAGING=$HOME/Pictures/camera-inbox
LOCAL_ARCHIVE=$HOME/Pictures/camera-archive
CAMERA_STATE_DIR=$HOME/.local/state/totem-camera
LIB_DIR=$LIB_DIR

# A card plugged into the LINUX box is rsynced here, then acknowledged back so
# that machine archives its own copy. Set REMOTE_ENABLED=false to ignore it.
REMOTE_ENABLED=$([[ "$LOCAL_ONLY" == "true" ]] && echo false || echo true)
REMOTE_HOST=$REMOTE_HOST
REMOTE_USER=$REMOTE_USER
REMOTE_STAGING=$REMOTE_STAGING
REMOTE_REPO=$REMOTE_REPO
REMOTE_INBOX=$HOME/Pictures/TotemCameraInbox
EOF
  say "wrote $CONF"
fi

# ---- the agents --------------------------------------------------------------
install_agent() {
  local label="$1" template="$2" script="$3" plist="$AGENT_DIR/$1.plist"
  sed -e "s|__SCRIPT__|$script|g" -e "s|__LOG__|$LOG|g" "$template" > "$plist"
  plutil -lint "$plist" >/dev/null || { echo "generated $plist is malformed" >&2; exit 1; }
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" || launchctl load "$plist"
  say "loaded $label"
}

install_agent "$LABEL_IMPORT" "$HERE/com.totem.photo-import.plist" "$BIN_DIR/totem-photo-import.sh"
install_agent "$LABEL_PULL" "$HERE/com.totem.camera-pull.plist" "$BIN_DIR/totem-camera-pull.sh"

# ---- first run ---------------------------------------------------------------
say "running the importer once — macOS will ask for permission the first time"
launchctl kickstart -k "gui/$(id -u)/$LABEL_IMPORT" 2>/dev/null || true

cat <<EOF

$(say "installed")

Two one-time things, both required or nothing reaches iCloud:

  1. Photos automation. The first real import triggers "wants to control
     Photos" → Allow. If you clicked Don't Allow, fix it in
     System Settings → Privacy & Security → Automation.

  2. Removable volume access, if prompted → Allow. macOS gates reading
     /Volumes for background agents.

And one thing worth turning OFF, or a window will open every time you plug the
camera in — which is the whole thing you were trying to avoid:

  Open Image Capture, select the XZ-1, and set
  "Connecting this camera opens:" to **No application**.

Then set the camera to Menu → Settings → USB Mode → Storage and plug it in.

  Watch it:      tail -f $LOG
  Import now:    launchctl kickstart -k gui/\$(id -u)/$LABEL_IMPORT
  Test the scan: $LIB_DIR/with-node.sh $LIB_DIR/volumes.mjs
EOF
