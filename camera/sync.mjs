#!/usr/bin/env node
// Pull new JPEGs off a camera card into staging. Triggered by udev the instant
// the XZ-1 is plugged in; see docs/camera-sync.md.
//
// Runs as root, from a unit with almost no environment, against a filesystem
// that is the user's only copy of photos he can't retake. Three rules follow
// from that and they're worth stating because most of the code below is one of
// them:
//
//   1. The card is mounted read-only and never written to. Not "we don't call
//      unlink" — the kernel is told to refuse.
//   2. Nothing lands in staging under a name that already exists.
//   3. A failure part-way through leaves the ledger describing what actually
//      got copied, so the next plug-in resumes instead of restarting.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, opendir, rename, rm, stat, statfs, appendFile, chown, unlink, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { isEntry } from '../scripts/is-entry.mjs'

import { EXIF_HEAD_BYTES, exifDateFromBuffer, partsFromMtime } from './exif.mjs'
import { stagingDir, stateDir } from './paths.mjs'
import {
  loadLedger, saveLedger, selectNew, stagedPath, uniquePath, recordImported, recordDuplicate,
} from './ledger.mjs'

const exec = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

// Staging lives outside the repo: photos don't belong in a git working tree,
// and on Linux this path is what the Mac rsyncs from. Defaults differ per
// platform and per user — see paths.mjs.
const STAGING_DIR = stagingDir()
const STATE_DIR = stateDir(ROOT)
const LEDGER_FILE = join(STATE_DIR, 'camera-ledger.json')
const EVENTS_FILE = join(STATE_DIR, 'camera-events.jsonl')
const LOCK_FILE = join(STATE_DIR, 'camera-sync.lock')

// JPEG only by default — RAW multiplies iCloud usage for photos that are not
// edited. Widen with CAMERA_EXTENSIONS=jpg,jpeg,orf to include ORF.
const EXTENSIONS = (process.env.CAMERA_EXTENSIONS || 'jpg,jpeg')
  .split(',').map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)

// Which USB vendors count as a camera. Empty or "any" means "anything with a
// DCIM folder", which is the default because it also covers an SD card in a
// reader — and because guessing the XZ-1's storage-mode product ID wrong would
// mean the whole thing silently never fires. The observed id is logged on every
// run so it can be tightened to exactly one camera later.
const ALLOW_VENDORS = (process.env.CAMERA_ALLOW_VENDORS || 'any')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

// Don't fill the disk. Refuse to start a copy that would leave less than this.
const MIN_FREE_BYTES = Number(process.env.CAMERA_MIN_FREE_BYTES || 5 * 1024 ** 3)

const MAX_DEPTH = 6 // DCIM/100OLYMP/P1010001.JPG needs 2; 6 is slack, not a plan

const log = (...args) => console.error('[camera-sync]', ...args)

// ---- locking ---------------------------------------------------------------
// Two partitions on one card, or a re-plug while the first run is still copying,
// would otherwise race on the ledger and lose entries. systemd won't serialise
// this for us: template units with different %i are separate units.

async function acquireLock() {
  await mkdir(STATE_DIR, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(LOCK_FILE, 'wx')
      await handle.writeFile(String(process.pid))
      return handle
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      // Held, or left behind by a run that was killed mid-copy. Tell those apart
      // by asking whether the pid is still alive — a stale lock must not disable
      // syncing until someone notices and deletes a file.
      const owner = Number(await readFile(LOCK_FILE, 'utf8').catch(() => '')) || 0
      let alive = false
      try { process.kill(owner, 0); alive = true } catch { alive = false }
      if (alive) return null
      log(`clearing stale lock from pid ${owner}`)
      await unlink(LOCK_FILE).catch(() => {})
    }
  }
  return null
}

// ---- mounting --------------------------------------------------------------

async function findExistingMount(device) {
  try {
    const { stdout } = await exec('findmnt', ['-n', '-o', 'TARGET', '--source', device])
    const target = stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0]
    return target || null
  } catch {
    return null // findmnt exits non-zero when the source isn't mounted
  }
}

async function mountCard(device) {
  const already = await findExistingMount(device)
  if (already) {
    // A desktop session's automounter got there first. Use its mount point and
    // leave it alone — unmounting underneath the file manager would be rude and
    // would break the next run's assumptions.
    log(`already mounted at ${already}`)
    return { dir: already, weMounted: false }
  }
  const dir = await mkdtemp(join(tmpdir(), 'totem-camera-'))
  // ro is the important one. The rest is hygiene for an untrusted removable
  // filesystem we're about to walk as root.
  await exec('mount', ['-o', 'ro,noatime,nosuid,nodev,noexec', device, dir])
  log(`mounted ${device} read-only at ${dir}`)
  return { dir, weMounted: true }
}

async function unmountCard(dir) {
  try {
    await exec('umount', [dir])
    await rm(dir, { recursive: true, force: true })
    log(`unmounted ${dir}`)
  } catch (err) {
    log(`umount failed (${err.message}) — retrying lazily`)
    // Lazy detach so a lingering fd doesn't leave the card mounted forever.
    await exec('umount', ['-l', dir]).catch(() => {})
  }
}

async function deviceVendor(device) {
  try {
    const { stdout } = await exec('udevadm', ['info', '--query=property', `--name=${device}`])
    const props = Object.fromEntries(
      stdout.split('\n').filter((l) => l.includes('=')).map((l) => {
        const at = l.indexOf('=')
        return [l.slice(0, at), l.slice(at + 1)]
      }),
    )
    return {
      vendor: (props.ID_VENDOR_ID || '').toLowerCase(),
      model: (props.ID_MODEL_ID || '').toLowerCase(),
      label: props.ID_VENDOR_FROM_DATABASE || props.ID_VENDOR || 'unknown',
      bus: props.ID_BUS || '',
    }
  } catch {
    return { vendor: '', model: '', label: 'unknown', bus: '' }
  }
}

// ---- scanning --------------------------------------------------------------

/** DCIM, whatever case the camera wrote it in. */
async function findDcim(root) {
  const dir = await opendir(root)
  try {
    for await (const entry of dir) {
      if (entry.isDirectory() && entry.name.toLowerCase() === 'dcim') return join(root, entry.name)
    }
  } finally {
    await dir.close().catch(() => {})
  }
  return null
}

async function scanPhotos(dcim, depth = 0, base = dcim, out = []) {
  if (depth > MAX_DEPTH) return out
  let dir
  try { dir = await opendir(dcim) } catch { return out }
  try {
    for await (const entry of dir) {
      // `._P1010001.JPG` sidecars appear the moment a card is touched by a Mac.
      // They're AppleDouble metadata, not photos, and they parse as garbage.
      if (entry.name.startsWith('.')) continue
      const full = join(dcim, entry.name)
      if (entry.isDirectory()) {
        await scanPhotos(full, depth + 1, base, out)
        continue
      }
      if (!entry.isFile()) continue
      const ext = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase()
      if (!EXTENSIONS.includes(ext)) continue
      const info = await stat(full).catch(() => null)
      if (!info || info.size === 0) continue
      out.push({ full, relPath: relative(base, full), name: entry.name, size: info.size, mtimeMs: info.mtimeMs })
    }
  } finally {
    await dir.close().catch(() => {})
  }
  return out
}

// ---- copying ---------------------------------------------------------------

async function shotDate(file) {
  let handle
  try {
    handle = await open(file.full, 'r')
    const buf = Buffer.alloc(Math.min(EXIF_HEAD_BYTES, file.size))
    await handle.read(buf, 0, buf.length, 0)
    const parts = exifDateFromBuffer(buf)
    if (parts) return parts
  } catch { /* fall through to mtime */ } finally {
    await handle?.close().catch(() => {})
  }
  // No EXIF, or a camera with a dead clock. mtime on a card is the write time,
  // which is the shot time to within a second.
  return partsFromMtime(file.mtimeMs) || partsFromMtime(Date.now())
}

/** Copy while hashing, so identifying the bytes costs no extra read. */
async function copyHashed(src, dest) {
  const hash = createHash('sha256')
  await pipeline(
    createReadStream(src),
    async function* (source) { for await (const chunk of source) { hash.update(chunk); yield chunk } },
    createWriteStream(dest),
  )
  return hash.digest('hex')
}

// Staging is written by root but read (and rsynced) by the owner. Match whatever
// owns the staging root rather than hardcoding a uid.
async function stagingOwner() {
  try { const s = await stat(STAGING_DIR); return { uid: s.uid, gid: s.gid } } catch { return null }
}

async function ensureOwned(path, owner) {
  if (!owner) return
  await chown(path, owner.uid, owner.gid).catch(() => {})
}

// ---- the run ---------------------------------------------------------------

async function syncFrom(mountDir, { dryRun = false, source = 'unknown' } = {}) {
  const dcim = await findDcim(mountDir)
  if (!dcim) {
    // The udev rule matches any USB filesystem, so this is the normal outcome of
    // plugging in a memory stick. Not an error, and not worth a notification.
    log('no DCIM folder — not a camera card, nothing to do')
    return { skipped: 'no-dcim', copied: 0, duplicates: 0, examined: 0 }
  }

  const all = await scanPhotos(dcim)
  const ledger = await loadLedger(LEDGER_FILE)
  const fresh = selectNew(all, ledger)
  log(`${all.length} photo(s) on the card, ${fresh.length} not yet seen`)
  if (!fresh.length) return { skipped: 'nothing-new', copied: 0, duplicates: 0, examined: all.length }

  const needed = fresh.reduce((sum, f) => sum + f.size, 0)
  await mkdir(STAGING_DIR, { recursive: true })
  const owner = await stagingOwner()
  const space = await statfs(STAGING_DIR)
  const free = space.bavail * space.bsize
  if (free - needed < MIN_FREE_BYTES) {
    throw new Error(
      `not enough room: ${fresh.length} photo(s) need ${(needed / 1024 ** 2).toFixed(0)}MB, `
      + `only ${(free / 1024 ** 3).toFixed(1)}GB free and ${(MIN_FREE_BYTES / 1024 ** 3).toFixed(0)}GB must stay free`,
    )
  }

  if (dryRun) {
    for (const f of fresh.slice(0, 20)) log(`would copy ${f.relPath} (${(f.size / 1024 ** 2).toFixed(1)}MB)`)
    if (fresh.length > 20) log(`…and ${fresh.length - 20} more`)
    return { dryRun: true, copied: 0, duplicates: 0, wouldCopy: fresh.length, examined: all.length }
  }

  let copied = 0
  let duplicates = 0
  let bytes = 0
  const days = new Set()
  let failure = null

  for (const file of fresh) {
    const parts = await shotDate(file)
    const target = join(STAGING_DIR, stagedPath(parts, file.name))
    await mkdir(dirname(target), { recursive: true })
    await ensureOwned(dirname(target), owner)
    await ensureOwned(dirname(dirname(target)), owner)

    // Copy to a temp name in the destination directory so a crash mid-copy can
    // never leave a truncated file looking like a finished photo, and so the
    // rename into place is atomic on the same filesystem.
    const temp = `${target}.partial`
    let hash
    try {
      hash = await copyHashed(file.full, temp)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {})
      // One unreadable file — a bad sector, a card yanked mid-run — shouldn't
      // abandon the rest. Record nothing for it so the next plug-in retries.
      log(`FAILED ${file.relPath}: ${err.message}`)
      failure = failure || err
      if (err.code === 'ENODEV' || err.code === 'EIO') break // card is gone; stop
      continue
    }

    if (ledger.hashes[hash]) {
      // Same bytes already in staging under another name — a reformatted card
      // that restarted its numbering, or the same photo copied twice by the
      // camera. Keep the copy we have.
      await rm(temp, { force: true }).catch(() => {})
      recordDuplicate(ledger, file)
      duplicates++
      continue
    }

    const finalPath = uniquePath(target, existsSync)
    await rename(temp, finalPath)
    await ensureOwned(finalPath, owner)
    recordImported(ledger, {
      relPath: file.relPath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      hash,
      staged: relative(STAGING_DIR, finalPath),
      at: new Date().toISOString(),
    })
    copied++
    bytes += file.size
    days.add(`${parts.year}-${parts.month}-${parts.day}`)

    // Checkpoint periodically. A card pulled out at photo 400 of 500 should
    // leave 400 recorded, not zero.
    if (copied % 25 === 0) await saveLedger(LEDGER_FILE, ledger)
  }

  ledger.lastSyncAt = new Date().toISOString()
  await saveLedger(LEDGER_FILE, ledger)

  const result = {
    copied, duplicates, bytes, examined: all.length,
    days: [...days].sort(),
    source,
    at: ledger.lastSyncAt,
    error: failure ? failure.message : null,
  }
  log(`copied ${copied}, skipped ${duplicates} duplicate(s), ${(bytes / 1024 ** 2).toFixed(0)}MB`)
  return result
}

// The spool is how a root process triggered by udev tells Totem — a different
// process, running as the owner — that something happened. Append-only JSONL rather
// than an HTTP call: the bridge might be restarting, and a photo import must not
// depend on it being up.
async function spool(event) {
  await mkdir(STATE_DIR, { recursive: true })
  await appendFile(EVENTS_FILE, `${JSON.stringify(event)}\n`)
  const owner = await stagingOwner()
  if (owner) await chown(EVENTS_FILE, owner.uid, owner.gid).catch(() => {})
}

function parseArgs(argv) {
  const args = { device: null, path: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--path') args.path = argv[++i]
    else if (a === '--device') args.device = argv[++i]
    else if (!a.startsWith('-') && !args.device) args.device = a
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.device && !args.path) {
    console.error('usage: sync.mjs <device|--device sdb1> [--dry-run]\n       sync.mjs --path /media/card [--dry-run]')
    process.exit(2)
  }

  const lock = await acquireLock()
  if (!lock) { log('another sync is already running — leaving this one to it'); return }

  let mount = null
  try {
    if (args.path) {
      mount = { dir: args.path, weMounted: false }
    } else {
      const device = args.device.startsWith('/') ? args.device : `/dev/${args.device}`
      const info = await deviceVendor(device)
      // Logged on every run so ALLOW_VENDORS can be narrowed to this exact
      // camera once its real id is known.
      log(`device ${device} vendor=${info.vendor || '?'} model=${info.model || '?'} (${info.label})`)
      const anyAllowed = ALLOW_VENDORS.includes('any') || ALLOW_VENDORS.length === 0
      if (!anyAllowed && !ALLOW_VENDORS.includes(info.vendor)) {
        log(`vendor ${info.vendor} not in CAMERA_ALLOW_VENDORS — ignoring`)
        return
      }
      mount = await mountCard(device)
    }

    const result = await syncFrom(mount.dir, { dryRun: args.dryRun, source: args.device || args.path })
    if (result.copied > 0 || result.error) {
      await spool({ kind: 'sync', reported: false, ...result })
    }
  } catch (err) {
    log(`ERROR ${err.message}`)
    await spool({ kind: 'error', reported: false, at: new Date().toISOString(), error: err.message }).catch(() => {})
    process.exitCode = 1
  } finally {
    // Unmount before releasing the lock: the card must be safe to unplug the
    // moment this process is gone.
    if (mount?.weMounted) await unmountCard(mount.dir)
    await lock.close().catch(() => {})
    await unlink(LOCK_FILE).catch(() => {})
  }
}

// Importable for tests, executable from udev.
if (isEntry(import.meta.url)) {
  main()
}

export { syncFrom, scanPhotos, findDcim, shotDate, parseArgs, STAGING_DIR, LEDGER_FILE, EVENTS_FILE }
