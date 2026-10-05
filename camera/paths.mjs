// Where things live, on both machines.
//
// The camera sync runs on Linux and on macOS, as root and as the user, from udev
// and from launchd. That's four combinations with four different ideas about
// what `~` means, which is exactly the kind of thing that works in testing and
// then writes a directory called `/root/Pictures` in production.
//
// Every default is resolved here, once.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const IS_MAC = process.platform === 'darwin'

/**
 * Home directory of whoever owns this checkout — the same rule camera/install.sh
 * uses ("the repo is owned by the person whose photos these are"). Under udev the
 * process is root, so homedir() would be `/root`; the checkout's owner is not.
 */
function ownerHome() {
  try {
    const uid = String(statSync(fileURLToPath(new URL('..', import.meta.url))).uid)
    const entry = readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find((f) => f[2] === uid)
    if (entry?.[5]) return entry[5]
  } catch {}
  return homedir()
}

/**
 * Staging: photos that have come off a card but aren't in Apple Photos yet.
 *
 * On macOS every part of this runs as the logged-in user, so homedir() is
 * right. On Linux the card pull runs as **root from udev**, where homedir() is
 * `/root` — so the Linux default hangs off the checkout owner's home instead,
 * and camera/install.sh writes the resolved path into /etc/default/totem-camera
 * so the runtime never has to guess.
 */
export function stagingDir() {
  if (process.env.CAMERA_STAGING_DIR) return process.env.CAMERA_STAGING_DIR
  return join(IS_MAC ? homedir() : ownerHome(), 'Pictures', 'camera-inbox')
}

/** Archive: imported, and kept. A sibling of staging so the move is a rename. */
export function archiveDir() {
  return process.env.CAMERA_ARCHIVE_DIR || join(dirname(stagingDir()), 'camera-archive')
}

/**
 * State: the ledger, the event spool, the lock.
 *
 * On Linux this is the repo's `data/` alongside every other piece of Totem
 * state. On macOS there is no repo to speak of — install-mac.sh copies the
 * engine into ~/.local/lib — so it follows the XDG-ish convention instead.
 */
export function stateDir(repoRoot) {
  if (process.env.CAMERA_STATE_DIR) return process.env.CAMERA_STATE_DIR
  return IS_MAC ? join(homedir(), '.local', 'state', 'totem-camera') : join(repoRoot, 'data')
}

/**
 * Where the OS mounts removable media.
 *
 * macOS puts every volume in /Volumes. Linux desktops use one of two spellings
 * depending on the udisks version, and the Linux card pull doesn't use this at
 * all — it's handed a device node by udev and mounts it itself. This is here for
 * the `--scan` path, which is how the Mac finds a card and how either machine
 * can be driven by hand.
 */
export const VOLUME_ROOTS = IS_MAC
  ? ['/Volumes']
  : ['/media', '/run/media', `/media/${process.env.SUDO_USER || process.env.USER || ''}`.replace(/\/$/, '')]
