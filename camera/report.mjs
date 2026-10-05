// What Totem says about the camera.
//
// The sync itself runs as root from udev and can't reach the job store, so it
// leaves events in a spool file (see sync.mjs). This drains that spool, looks at
// what's still sitting in staging, and turns both into notifications.
//
// The backlog check is why this reports at all rather than staying silent: the
// MacBook is the only machine that can put a photo into iCloud and it's usually
// shut, so "photos came off the camera" and "photos reached iCloud" are days
// apart. Without something watching, a MacBook left closed for a month is
// indistinguishable from a working sync.

import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HOUR = 60 * 60 * 1000

// Keep the spool from growing without bound. Events are tiny and only the
// unreported ones matter, but a few hundred kept around make it possible to see
// what happened last week without digging through the journal.
const KEEP_EVENTS = 200

export async function readEvents(file) {
  try {
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return [] // no spool yet means no camera has been plugged in
  }
}

/**
 * Mark everything reported and trim.
 *
 * Written atomically, and — importantly — only after the notifications have
 * actually been raised. A crash between the two re-reports one plug-in, which is
 * a duplicate notification; the other order loses it silently.
 */
export async function commitEvents(file, events) {
  const kept = events.slice(-KEEP_EVENTS).map((e) => ({ ...e, reported: true }))
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''))
  await rename(tmp, file)
}

/**
 * When the backlog warning last fired.
 *
 * Its own tiny file rather than a field on the ledger, because the ledger is
 * written by root from udev and this is written by the bridge as the owner — sharing
 * one file across those two would mean fighting over ownership on every run.
 */
export async function readReportState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return { lastNaggedAt: Number(parsed?.lastNaggedAt) || null }
  } catch {
    return { lastNaggedAt: null }
  }
}

export async function writeReportState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
  await rename(tmp, file)
}

/** Count and age what's still waiting for the Mac. */
export async function scanBacklog(stagingDir) {
  let count = 0
  let bytes = 0
  let oldestMs = null
  const days = new Set()

  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!/\.(jpe?g|orf)$/i.test(entry.name)) continue
      const info = await stat(full).catch(() => null)
      if (!info) continue
      count++
      bytes += info.size
      if (oldestMs === null || info.mtimeMs < oldestMs) oldestMs = info.mtimeMs
      // The day folder is the photo's shot date; the parent of the file.
      const day = dir.split('/').pop()
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day)
    }
  }

  await walk(stagingDir)
  return { count, bytes, oldestMs, days: [...days].sort() }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function humanAge(ms) {
  const hours = Math.floor(ms / HOUR)
  if (hours < 48) return plural(hours, 'hour')
  return plural(Math.floor(hours / 24), 'day')
}

function humanSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))}MB`
}

/**
 * Turn spool events and a backlog scan into notifications and a one-line summary.
 *
 * Pure, so the wording and — more to the point — the decision about *when* to
 * nag can be tested without a camera, a Mac, or a clock.
 */
export function summarize({
  pending = [], backlog, staleHours = 48, nagIntervalHours = 12, lastNaggedAt = null, now = Date.now(),
} = {}) {
  const notifications = []
  const syncs = pending.filter((e) => e.kind === 'sync')
  const copied = syncs.reduce((n, e) => n + (e.copied || 0), 0)
  const duplicates = syncs.reduce((n, e) => n + (e.duplicates || 0), 0)

  if (copied > 0) {
    const days = [...new Set(syncs.flatMap((e) => e.days || []))].sort()
    const span = days.length === 1 ? ` from ${days[0]}`
      : days.length > 1 ? ` from ${days[0]} to ${days[days.length - 1]}` : ''
    notifications.push({
      level: 'info',
      title: `${plural(copied, 'photo')} off the camera`,
      body: `Pulled${span}. ${duplicates ? `${plural(duplicates, 'duplicate')} skipped. ` : ''}`
        + 'They reach iCloud the next time your MacBook is awake.',
    })
  }

  // Failures the sync recorded for itself — a card yanked mid-copy, a full disk.
  for (const event of pending.filter((e) => e.error)) {
    notifications.push({
      level: 'error',
      title: 'Camera sync had a problem',
      body: event.error,
    })
  }

  // The nag. Only fires when there is genuinely something stuck: photos present,
  // and the oldest older than the threshold.
  //
  // Throttled separately from that, because this job runs every 15 minutes and
  // the stuck condition persists until the MacBook is opened — which may be next
  // week. Re-notifying every quarter of an hour for a week is how a useful
  // warning becomes one the owner swipes away without reading, at which point the
  // whole store-and-forward design has lost its only safety net.
  let stale = false
  let nagged = false
  if (backlog?.count > 0 && backlog.oldestMs != null) {
    const age = now - backlog.oldestMs
    if (age >= staleHours * HOUR) {
      stale = true
      const due = lastNaggedAt == null || now - lastNaggedAt >= nagIntervalHours * HOUR
      if (due) {
        nagged = true
        notifications.push({
          level: 'warning',
          title: `${plural(backlog.count, 'photo')} still waiting for your MacBook`,
          body: `Oldest has been here ${humanAge(age)} (${humanSize(backlog.bytes)} total). `
            + 'Open the MacBook on the tailnet and they will import themselves.',
        })
      }
    }
  }

  const parts = []
  if (copied) parts.push(`${copied} pulled`)
  if (duplicates) parts.push(`${duplicates} duplicate(s) skipped`)
  parts.push(backlog?.count ? `${backlog.count} waiting for the Mac` : 'nothing waiting')
  if (stale) parts.push('backlog is stale')

  return {
    output: parts.join(', '),
    // "Nothing happened" is a skip, matching the WHOOP sync: a quiet run should
    // not read as a broken one on the Overview tile.
    status: copied || notifications.length ? 'ok' : 'skipped',
    notifications,
    copied,
    duplicates,
    stale,
    // The caller persists this when true, so the throttle survives a restart.
    nagged,
  }
}
