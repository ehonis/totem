// What has already come off a card, and where the next file should land.
//
// Split out from sync.mjs because these are the decisions that have to be right
// — "is this photo new", "what do I call it" — and they're the ones you can test
// without a camera, a mount point, or root.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dateFolder } from './exif.mjs'

export const LEDGER_VERSION = 1

/**
 * The cheap identity of a file on the card: where it sits, how big it is, when
 * the camera wrote it.
 *
 * This exists so a re-plug doesn't re-read the card. Hashing content is the
 * honest way to answer "have I seen this", but the XZ-1 is USB 2.0 — hashing a
 * full 16GB card means reading 16GB at ~30MB/s, about nine minutes of spinning
 * every time the cable goes in. So the cheap key is the *first* gate and only
 * files that miss it get read at all. Content hashing still happens, but on the
 * bytes we were going to copy anyway (see sync.mjs), so it costs nothing extra.
 *
 * mtime is included because DCIM filenames are not unique: the XZ-1 rolls over
 * at P9999999 and restarts at 0001 after a card format, so a name alone would
 * hide genuinely new photos behind old ones.
 */
export function cheapKey(relPath, size, mtimeMs) {
  // Second precision. FAT32 stores mtime at 2-second granularity and the exact
  // value can wobble by a second across mounts and DST changes; a millisecond
  // key would make every re-plug look like a card full of new photos.
  return `${relPath}|${size}|${Math.floor(mtimeMs / 1000)}`
}

export function emptyLedger() {
  return { version: LEDGER_VERSION, keys: {}, hashes: {}, lastSyncAt: null }
}

/**
 * Read the ledger, tolerating absence and corruption.
 *
 * A ledger we can't parse must not stop a sync. The failure mode of starting
 * fresh is re-copying photos we already have — which the content-hash gate then
 * catches anyway, so it costs time and no duplicates. The failure mode of
 * throwing is a camera that silently stops syncing, which is worse.
 */
export async function loadLedger(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || parsed.version !== LEDGER_VERSION) return emptyLedger()
    return {
      version: LEDGER_VERSION,
      keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
      hashes: parsed.hashes && typeof parsed.hashes === 'object' ? parsed.hashes : {},
      lastSyncAt: parsed.lastSyncAt ?? null,
    }
  } catch {
    return emptyLedger()
  }
}

/** Atomic write — a half-written ledger on a power cut is a ledger we can't trust. */
export async function saveLedger(file, ledger) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`)
  await rename(tmp, file)
}

/** Files on the card the ledger has never recorded. Order is preserved. */
export function selectNew(files, ledger) {
  return files.filter((f) => !ledger.keys[cheapKey(f.relPath, f.size, f.mtimeMs)])
}

/**
 * Where a photo goes in staging: `2011/2011-04-03/2011-04-03_182207_P1010001.JPG`.
 *
 * The timestamp is repeated in the filename on purpose. Photos shows the
 * filename, folders get flattened by whatever touches them next, and
 * `P1010001.JPG` on its own says nothing and collides with the same name from
 * the next card.
 */
export function stagedPath(parts, originalName) {
  const day = dateFolder(parts)
  const stem = originalName.replace(/[/\\]/g, '_')
  return `${parts.year}/${day}/${day}_${parts.hour}${parts.minute}${parts.second}_${stem}`
}

/**
 * Disambiguate a target that already exists on disk.
 *
 * Reached when two photos share a name *and* a shot second — a burst across two
 * cards. Rare, but silently overwriting someone's photo is not an acceptable way
 * to handle rare.
 */
export function uniquePath(path, exists) {
  if (!exists(path)) return path
  const dot = path.lastIndexOf('.')
  const [stem, ext] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${stem}-${randomUUID().slice(0, 8)}${ext}`
}

/** Note a copied photo so neither its slot on the card nor its bytes come back. */
export function recordImported(ledger, { relPath, size, mtimeMs, hash, staged, at }) {
  ledger.keys[cheapKey(relPath, size, mtimeMs)] = 1
  if (hash) ledger.hashes[hash] = { staged, at }
  return ledger
}

/**
 * Note a photo we read but chose not to keep, because its bytes are already in
 * staging under a different name.
 *
 * Only the cheap key is added — the hash entry already exists and points at the
 * copy we kept, and overwriting it would relabel the original. Without this the
 * duplicate is re-read on every single plug-in, forever.
 */
export function recordDuplicate(ledger, { relPath, size, mtimeMs }) {
  ledger.keys[cheapKey(relPath, size, mtimeMs)] = 1
  return ledger
}
