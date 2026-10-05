#!/usr/bin/env bash
# Install (or remove) the plug-in-the-camera photo sync. Needs root; run it once.
#
#   sudo camera/install.sh
#   sudo camera/install.sh --uninstall
#
# Everything it writes outside the repo:
#   /etc/udev/rules.d/99-totem-camera.rules
#   /etc/systemd/system/totem-camera-sync@.service
#   /etc/default/totem-camera              (config; not overwritten if present)
#   /usr/local/lib/totem-camera/run-sync.sh
#
# Re-running is safe and is how you pick up an edit to any of the templates.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RULE_DST=/etc/udev/rules.d/99-totem-camera.rules
UNIT_DST=/etc/systemd/system/totem-camera-sync@.service
CONF_DST=/etc/default/totem-camera
LIB_DIR=/usr/local/lib/totem-camera

# The repo is owned by the person whose photos these are, and whose nvm holds the
# node that will run. Derive both rather than hardcoding a username.
OWNER="$(stat -c '%U' "$REPO")"
OWNER_UID="$(stat -c '%u' "$REPO")"
OWNER_GID="$(stat -c '%g' "$REPO")"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
STAGING="${CAMERA_STAGING_DIR:-$OWNER_HOME/Pictures/camera-inbox}"
STATE="$REPO/data"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warning:\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "needs root: sudo $0 $*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  say "removing the camera sync"
  rm -fv "$RULE_DST" "$UNIT_DST"
  rm -rfv "$LIB_DIR"
  systemctl daemon-reload
  udevadm control --reload-rules
  say "left in place: $CONF_DST, staging at $STAGING, and the ledger in $STATE"
  say "delete those by hand if you want them gone — they hold your photos and the record of what has already synced"
  exit 0
fi

say "repo:    $REPO"
say "owner:   $OWNER (uid $OWNER_UID)"
say "staging: $STAGING"

# ---- staging ---------------------------------------------------------------
install -d -o "$OWNER_UID" -g "$OWNER_GID" -m 755 "$STAGING"
install -d -o "$OWNER_UID" -g "$OWNER_GID" -m 755 "$STATE"

# ---- the wrapper -----------------------------------------------------------
install -d -m 755 "$LIB_DIR"
sed -e "s|__REPO__|$REPO|g" \
    -e "s|__NVM_ROOT__|$OWNER_HOME/.nvm/versions/node|g" \
    "$REPO/camera/run-sync.sh" > "$LIB_DIR/run-sync.sh"
chmod 755 "$LIB_DIR/run-sync.sh"
say "installed $LIB_DIR/run-sync.sh"

# Resolve node now, loudly, rather than at 11pm when a camera gets plugged in.
# env -i so this sees the same empty environment the systemd unit will.
if ! resolved_node="$(env -i "$LIB_DIR/run-sync.sh" --print-node)"; then
  echo "could not find a node interpreter — see the message above" >&2
  exit 1
fi
say "node:    $resolved_node"

# ---- config ----------------------------------------------------------------
if [[ -f "$CONF_DST" ]]; then
  say "keeping existing $CONF_DST"
else
  cat > "$CONF_DST" <<EOF
# Totem camera sync. Read by totem-camera-sync@.service; see docs/camera-sync.md.
# Changes take effect on the next plug-in — no daemon to restart.

# Where photos land on this box before the Mac collects them.
CAMERA_STAGING_DIR=$STAGING

# Which USB vendor ids count as a camera. "any" means "anything with a DCIM
# folder", which also covers an SD card in a reader. Every run logs the id it
# saw (journalctl -t camera-sync), so this can be narrowed to just the XZ-1:
#   CAMERA_ALLOW_VENDORS=07b4
CAMERA_ALLOW_VENDORS=any

# JPEG only. Add orf to bring Olympus RAW across too — it will multiply the
# iCloud storage this uses.
CAMERA_EXTENSIONS=jpg,jpeg

# Refuse to start a copy that would leave less than this free (bytes).
CAMERA_MIN_FREE_BYTES=5368709120

# Pin the node interpreter if the automatic search picks the wrong one.
#NODE_BIN=/usr/local/bin/node
EOF
  chmod 644 "$CONF_DST"
  say "wrote $CONF_DST"
fi

# ---- unit and rule ---------------------------------------------------------
sed -e "s|__REPO__|$REPO|g" \
    -e "s|__STAGING__|$STAGING|g" \
    -e "s|__STATE__|$STATE|g" \
    "$REPO/camera/systemd/totem-camera-sync@.service" > "$UNIT_DST"
chmod 644 "$UNIT_DST"
say "installed $UNIT_DST"

install -m 644 "$REPO/camera/udev/99-totem-camera.rules" "$RULE_DST"
say "installed $RULE_DST"

systemctl daemon-reload
udevadm control --reload-rules
udevadm trigger --subsystem-match=block --action=add >/dev/null 2>&1 || true
say "reloaded systemd and udev"

# ---- verify ----------------------------------------------------------------
unit_check="$(systemd-analyze verify "$UNIT_DST" 2>&1 || true)"
if [[ -z "$unit_check" ]]; then
  say "unit verifies clean"
else
  warn "systemd-analyze had something to say about the unit:"
  printf '%s\n' "$unit_check" | sed 's/^/    /'
fi

cat <<EOF

$(say "installed")

Next, on the camera itself:
  Menu → Settings → USB Mode → Storage
  (Auto or MTP present the camera over PTP instead, which has no block device
  for udev to match, and nothing will happen when you plug it in.)

Then plug the XZ-1 in and watch it work:
  journalctl -f -u 'totem-camera-sync@*'

Photos land in $STAGING, organised by shot date. Nothing is ever written to or
deleted from the memory card.

Photos reach Apple Photos via the MacBook, which is the only machine here that
can upload to iCloud. Install that half on the Mac:
  camera/mac/install-mac.sh    (run it there, not here)

That same installer also makes the Mac handle a card plugged directly into it,
which is the faster path when the laptop is to hand — no waiting for a lid.
EOF
