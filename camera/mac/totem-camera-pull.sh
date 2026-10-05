#!/bin/bash
# Plug the XZ-1 into the MacBook itself: pull the card, then import.
#
# Started by launchd on *every* volume mount (StartOnMount), so the first thing
# it does is establish that a camera is what got mounted. Disk images, Time
# Machine drives, SMB shares and USB sticks all land here too and all have to be
# a silent, sub-second no-op.
#
# This is the same engine the Linux box runs, invoked the other way round:
# macOS has already mounted the card by the time we're called, so there is
# nothing to mount and nothing to unmount — just a path to hand to sync.mjs.
set -uo pipefail

CONF="${HOME}/.config/totem-photo-import.conf"
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"

LIB=${LIB_DIR:-$HOME/.local/lib/totem-camera}
LABEL_IMPORT=com.totem.photo-import

# The card pull writes here; the importer reads here. Distinct from the tree the
# remote pull rsyncs into, because the two need different acknowledgement: these
# are archived locally, those are archived on the Linux box.
export CAMERA_STAGING_DIR=${LOCAL_STAGING:-$HOME/Pictures/camera-inbox}
export CAMERA_ARCHIVE_DIR=${LOCAL_ARCHIVE:-$HOME/Pictures/camera-archive}
export CAMERA_STATE_DIR=${CAMERA_STATE_DIR:-$HOME/.local/state/totem-camera}

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

[ -x "$LIB/with-node.sh" ] || { log "not installed: $LIB/with-node.sh missing"; exit 0; }

# Which volumes look like a camera. Prints nothing at all in the common case.
volumes=$("$LIB/with-node.sh" "$LIB/volumes.mjs" 2>/dev/null)
if [ -z "$volumes" ]; then
  exit 0
fi

pulled=0
while IFS= read -r volume; do
  [ -z "$volume" ] && continue
  log "camera card at $volume"
  if "$LIB/with-node.sh" "$LIB/sync.mjs" --path "$volume"; then
    pulled=$((pulled + 1))
  else
    log "pull from $volume failed"
  fi
done <<< "$volumes"

[ "$pulled" -eq 0 ] && exit 0

# Import now rather than waiting up to 15 minutes for the importer's own tick.
# The card is already unmountable at this point — everything is copied.
log "handing off to $LABEL_IMPORT"
launchctl kickstart -k "gui/$(id -u)/$LABEL_IMPORT" 2>/dev/null \
  || log "could not kickstart the importer; it will pick these up on its next tick"
