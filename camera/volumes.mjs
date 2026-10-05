// Find mounted volumes that have a camera card's worth of photos on them.
//
// This is the macOS counterpart to the Linux udev rule. The two platforms hand
// us the card in completely different shapes:
//
//   Linux  — udev names a block device (/dev/sdb1) and we mount it ourselves.
//   macOS  — the system has already mounted it somewhere under /Volumes by the
//            time anything of ours runs, and unmounting it is the Finder's job.
//
// So on macOS there is nothing to mount and nothing to unmount; the whole
// problem is "which of these directories is a camera". Same answer as the Linux
// side gives: the one with a DCIM folder in it.

import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { isEntry } from '../scripts/is-entry.mjs'
import { VOLUME_ROOTS } from './paths.mjs'

// A hung volume must not hang the scan. An unreachable SMB share or a sleeping
// external drive can make readdir block for a long time, and this runs on a
// mount event — possibly of that very share.
const PROBE_TIMEOUT_MS = Number(process.env.CAMERA_PROBE_TIMEOUT_MS || 4000)

// Volumes that are never a camera and are sometimes expensive to look at.
// Time Machine in particular can take tens of seconds to enumerate.
const SKIP = [
  /^\./, // .timemachine, .DocumentRevisions, and friends
  /^(Macintosh HD|System|Preboot|Recovery|VM|Data|Update|xarts|iSCPreboot|Hardware)$/i,
  /^Time ?Machine/i,
  /\.sparsebundle$/i,
]

export function isSkippableVolume(name) {
  return SKIP.some((re) => re.test(name))
}

function withTimeout(promise, ms, fallback) {
  let timer
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/** The DCIM directory inside a volume, whatever case it's written in. */
async function dcimIn(volume) {
  const probe = (async () => {
    const dir = await opendir(volume)
    try {
      for await (const entry of dir) {
        if (entry.isDirectory() && entry.name.toLowerCase() === 'dcim') return join(volume, entry.name)
      }
    } finally {
      await dir.close().catch(() => {})
    }
    return null
  })()
  return withTimeout(probe, PROBE_TIMEOUT_MS, null)
}

/**
 * Every mounted volume that looks like a camera card.
 *
 * Returns paths, not devices — which is exactly what `sync.mjs --path` takes, so
 * the same engine handles a card the Mac mounted and a card udev handed us.
 */
export async function findCameraVolumes(roots = VOLUME_ROOTS) {
  const found = []
  const seen = new Set()

  for (const root of roots.filter(Boolean)) {
    let dir
    try { dir = await opendir(root) } catch { continue } // /media may not exist
    const names = []
    try {
      for await (const entry of dir) {
        // isDirectory() is false for a symlink to one, which is how /Volumes
        // represents the boot volume — but those are in SKIP anyway.
        if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name)
      }
    } finally {
      await dir.close().catch(() => {})
    }

    for (const name of names) {
      if (isSkippableVolume(name)) continue
      const path = join(root, name)
      if (seen.has(path)) continue
      seen.add(path)
      const dcim = await dcimIn(path)
      if (dcim) found.push({ path, name, dcim })
    }
  }

  return found
}

// `volumes.mjs` on its own prints one candidate path per line, for the shell
// script that launchd starts on mount. Nothing is printed when there's no
// camera, which is the overwhelmingly common case — a disk image, a Time
// Machine drive, someone's USB stick.
if (isEntry(import.meta.url)) {
  const volumes = await findCameraVolumes()
  for (const v of volumes) console.log(v.path)
}
