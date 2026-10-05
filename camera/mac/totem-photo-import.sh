#!/bin/bash
# Put staged photos into Apple Photos, which uploads them to iCloud.
#
# There are two ways a photo gets staged, and this handles both:
#
#   local  — the XZ-1 was plugged into this MacBook. totem-camera-pull.sh has
#            already copied the card into ~/Pictures/camera-inbox. Archived here
#            when the import succeeds.
#   remote — the XZ-1 was plugged into the Linux box. Its photos are rsynced into
#            ~/Pictures/TotemCameraInbox. Acknowledged back over ssh so the
#            Linux box can archive them and clear its backlog.
#
# The two are kept in separate trees with separate ledgers precisely because
# they need different acknowledgement. Merging them would mean guessing which
# machine owns a given file.
#
# Run every 15 minutes by launchd, and kicked immediately after a local card
# pull. The Linux box being asleep, unreachable, or not set up at all is normal:
# the remote half is skipped and the local half still runs.
#
# Nothing here deletes a photo. Files leave a staging tree only by being moved
# into an archive, and only after Photos has accepted the import.
set -uo pipefail

CONF="${HOME}/.config/totem-photo-import.conf"
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"

# Normally all set by the config install-mac.sh writes.
REMOTE_HOST=${REMOTE_HOST:-}
REMOTE_USER=${REMOTE_USER:-$(id -un)}
REMOTE_STAGING=${REMOTE_STAGING:-/home/$REMOTE_USER/Pictures/camera-inbox}
REMOTE_REPO=${REMOTE_REPO:-/home/$REMOTE_USER/projects/totem}
REMOTE_INBOX=${REMOTE_INBOX:-${LOCAL_INBOX:-$HOME/Pictures/TotemCameraInbox}}
LOCAL_STAGING=${LOCAL_STAGING:-$HOME/Pictures/camera-inbox}
LOCAL_ARCHIVE=${LOCAL_ARCHIVE:-$HOME/Pictures/camera-archive}
STATE_DIR=${STATE_DIR:-$HOME/.local/state/totem-photo-import}
LIB=${LIB_DIR:-$HOME/.local/lib/totem-camera}
BATCH=${BATCH:-80}
# Set REMOTE_ENABLED=false on a Mac that should only ever handle its own cards.
REMOTE_ENABLED=${REMOTE_ENABLED:-true}

REMOTE="$REMOTE_USER@$REMOTE_HOST"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new)

mkdir -p "$STATE_DIR" "$REMOTE_INBOX" "$LOCAL_STAGING"

# stderr, so stdout stays clean for the functions that return file lists.
# launchd sends both to the same log, so nothing is lost by the distinction.
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

# ---- import a tree ----------------------------------------------------------
# $1 tree, $2 ledger. Echoes the relative paths that Photos accepted.
#
# In batches: one osascript call holding several thousand file references is slow
# to compile, and an error loses the whole run rather than one batch.
#
# `skip check duplicates false` tells Photos to DO check for duplicates — the
# double negative is AppleScript's. It matters because re-importing after a lost
# ledger should not silently double every photo in the library.
import_tree() {
  local tree="$1" ledger="$2"
  [ -d "$tree" ] || return 0
  touch "$ledger"

  # LC_ALL=C on both sides: comm needs its inputs in matching collation, and the
  # ledger was sorted by an earlier run.
  local pending
  pending=$(
    cd "$tree" || return 0
    find . -type f \( -iname '*.jpg' -o -iname '*.jpeg' \) \
      | sed 's|^\./||' | LC_ALL=C sort \
      | LC_ALL=C comm -23 - <(LC_ALL=C sort "$ledger")
  )
  [ -z "$pending" ] && return 0

  local count
  count=$(printf '%s\n' "$pending" | wc -l | tr -d ' ')
  log "importing $count photo(s) from $tree"

  local pending_file script_file imported offset chunk first rel esc
  pending_file=$(mktemp)
  script_file=$(mktemp)
  printf '%s\n' "$pending" > "$pending_file"

  imported=""
  offset=0
  while [ "$offset" -lt "$count" ]; do
    chunk=$(tail -n +$((offset + 1)) "$pending_file" | head -n "$BATCH")
    [ -z "$chunk" ] && break

    {
      printf 'set theFiles to {'
      first=1
      while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        [ $first -eq 0 ] && printf ', '
        # AppleScript string literals escape backslash and double quote, nothing else.
        esc=$(printf '%s' "$tree/$rel" | sed 's/\\/\\\\/g; s/"/\\"/g')
        printf 'POSIX file "%s"' "$esc"
        first=0
      done <<< "$chunk"
      printf '}\n'
      printf 'tell application "Photos"\n'
      printf '  import theFiles skip check duplicates false\n'
      printf 'end tell\n'
    } > "$script_file"

    if osascript "$script_file" >/dev/null 2>"$STATE_DIR/last-error.txt"; then
      imported+="$chunk"$'\n'
      log "imported batch of $(printf '%s\n' "$chunk" | wc -l | tr -d ' ')"
    else
      log "batch failed: $(tr '\n' ' ' < "$STATE_DIR/last-error.txt")"
      # Stop rather than press on. The overwhelming cause is Photos not having
      # been granted Automation access, and every later batch fails identically.
      break
    fi
    offset=$((offset + BATCH))
  done
  rm -f "$pending_file" "$script_file"

  imported=$(printf '%s' "$imported" | sed '/^$/d')
  [ -z "$imported" ] && return 0

  # Ledger first, so a crash before archiving can't cause a re-import. What
  # makes that safe is that archiving is driven by reconcile_tree below, from
  # the ledger, rather than from this function's return value.
  printf '%s\n' "$imported" >> "$ledger"
  LC_ALL=C sort -u -o "$ledger" "$ledger"
  printf '%s\n' "$imported"
}

# ---- what still needs archiving ---------------------------------------------
# $1 tree, $2 ledger. Echoes files still in the tree that the ledger says Photos
# already has.
#
# This is deliberately computed from disk-versus-ledger rather than from what
# this run happened to import. Writing the ledger and archiving are two steps
# that can fail independently: an ssh drop, a full disk, a node that isn't
# installed yet. If archiving were driven by "what I just imported", anything
# that failed in between would be marked imported, skipped by every future run,
# and sit in staging forever — which on the Linux side means the backlog warning
# never clears. Reconciling instead means every tick retries it.
# $3 is an optional "already dealt with" ledger to subtract. The two trees need
# it differently:
#
#   local  — archiving MOVES the file out of the tree, so disk-minus-nothing
#            empties by itself. No third ledger.
#   remote — rsync --ignore-existing means our copy stays put after the Linux box
#            archives its own, so disk never shrinks. Without subtracting what's
#            already been acknowledged, every tick would re-send every photo
#            ever imported over ssh, forever.
reconcile_tree() {
  local tree="$1" ledger="$2" done_ledger="${3:-}" result
  [ -d "$tree" ] || return 0
  [ -s "$ledger" ] || return 0
  result=$(
    (
      cd "$tree" || exit 0
      find . -type f \( -iname '*.jpg' -o -iname '*.jpeg' \) | sed 's|^\./||' | LC_ALL=C sort
    ) | LC_ALL=C comm -12 - <(LC_ALL=C sort "$ledger")
  )
  if [ -n "$done_ledger" ] && [ -s "$done_ledger" ]; then
    result=$(printf '%s\n' "$result" | LC_ALL=C sort | LC_ALL=C comm -23 - <(LC_ALL=C sort "$done_ledger"))
  fi
  printf '%s\n' "$result" | sed '/^$/d'
}

# ---- the local tree: a card plugged into this Mac ---------------------------
import_tree "$LOCAL_STAGING" "$STATE_DIR/imported-local.txt" >/dev/null

local_done=$(reconcile_tree "$LOCAL_STAGING" "$STATE_DIR/imported-local.txt")
if [ -n "$local_done" ]; then
  n=$(printf '%s\n' "$local_done" | wc -l | tr -d ' ')
  if [ -x "$LIB/with-node.sh" ]; then
    log "archiving $n local photo(s)"
    printf '%s\n' "$local_done" | \
      CAMERA_STAGING_DIR="$LOCAL_STAGING" CAMERA_ARCHIVE_DIR="$LOCAL_ARCHIVE" \
      "$LIB/with-node.sh" "$LIB/ack.mjs" >&2 \
      || log "local archive failed — retried on the next tick"
  else
    log "$LIB/ack.mjs missing; $n photo(s) are in Photos but left in staging"
  fi
fi

# ---- the remote tree: a card plugged into the Linux box ---------------------
if [ "$REMOTE_ENABLED" != "true" ]; then
  log "remote pull disabled"
elif [ -z "$REMOTE_HOST" ]; then
  log "REMOTE_HOST not set in $CONF — skipping the remote pull"
elif ! ssh "${SSH_OPTS[@]}" "$REMOTE" true 2>/dev/null; then
  # An asleep desktop is the normal state of the world, not a failure.
  log "$REMOTE_HOST unreachable — skipping the remote pull"
else
  log "pulling from $REMOTE:$REMOTE_STAGING"
  if rsync -a --ignore-existing --prune-empty-dirs \
    --exclude '.*' --exclude '*.partial' \
    -e "ssh ${SSH_OPTS[*]}" \
    "$REMOTE:$REMOTE_STAGING/" "$REMOTE_INBOX/"; then

    import_tree "$REMOTE_INBOX" "$STATE_DIR/imported-remote.txt" >/dev/null

    # Acknowledging is what clears the Linux box's backlog, so it has to be
    # retried until it lands. The acked ledger is appended to only on success,
    # which is what makes a failed ssh a retry rather than a lost photo.
    acked="$STATE_DIR/acked-remote.txt"
    remote_done=$(reconcile_tree "$REMOTE_INBOX" "$STATE_DIR/imported-remote.txt" "$acked")
    if [ -n "$remote_done" ]; then
      n=$(printf '%s\n' "$remote_done" | wc -l | tr -d ' ')
      log "acknowledging $n to $REMOTE"
      if printf '%s\n' "$remote_done" | ssh "${SSH_OPTS[@]}" "$REMOTE" \
        "cd '$REMOTE_REPO' && ./camera/with-node.sh camera/ack.mjs" >&2; then
        printf '%s\n' "$remote_done" >> "$acked"
        LC_ALL=C sort -u -o "$acked" "$acked"
      else
        log "ack failed — retried on the next tick"
      fi
    fi
  else
    log "rsync failed"
  fi
fi

log "done"
