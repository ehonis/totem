// Run with: node --test camera/
//
// summarize() decides when the owner gets interrupted. Over-firing trains him to
// ignore it and the backlog nag becomes worthless; under-firing means a MacBook
// shut for a month looks exactly like a working sync. So the thresholds get
// tests rather than a hopeful comment.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarize, scanBacklog, readEvents, commitEvents, readReportState, writeReportState } from './report.mjs'

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 29, 12, 0, 0)
const SANDBOX = await mkdtemp(join(tmpdir(), 'camera-report-test-'))
after(async () => { await rm(SANDBOX, { recursive: true, force: true }) })

const noBacklog = { count: 0, bytes: 0, oldestMs: null, days: [] }

test('a quiet run notifies nobody and reads as skipped', () => {
  const result = summarize({ pending: [], backlog: noBacklog, now: NOW })
  assert.deepEqual(result.notifications, [])
  assert.equal(result.status, 'skipped')
  assert.match(result.output, /nothing waiting/)
})

test('a plug-in is announced once, with the dates it covered', () => {
  const result = summarize({
    pending: [{ kind: 'sync', copied: 42, duplicates: 3, days: ['2026-08-27', '2026-08-28'] }],
    backlog: { count: 42, bytes: 180 * 1024 ** 2, oldestMs: NOW - 60_000, days: [] },
    now: NOW,
  })
  assert.equal(result.notifications.length, 1)
  assert.equal(result.notifications[0].level, 'info')
  assert.match(result.notifications[0].title, /^42 photos off the camera$/)
  assert.match(result.notifications[0].body, /2026-08-27 to 2026-08-28/)
  assert.match(result.notifications[0].body, /3 duplicates skipped/)
  assert.equal(result.status, 'ok')
})

test('one photo is not "1 photos"', () => {
  const result = summarize({
    pending: [{ kind: 'sync', copied: 1, duplicates: 0, days: ['2026-08-28'] }],
    backlog: noBacklog,
    now: NOW,
  })
  assert.match(result.notifications[0].title, /^1 photo off the camera$/)
  assert.match(result.notifications[0].body, /from 2026-08-28/)
  assert.doesNotMatch(result.notifications[0].body, /duplicate/)
})

test('a fresh backlog does not nag', () => {
  // Photos that arrived an hour ago are not a problem, they are the normal state
  // between a plug-in and the next time the lid opens.
  const result = summarize({
    pending: [],
    backlog: { count: 42, bytes: 1024 ** 3, oldestMs: NOW - 5 * HOUR, days: [] },
    now: NOW,
  })
  assert.deepEqual(result.notifications, [])
  assert.equal(result.stale, false)
})

test('a backlog past the threshold nags exactly once per run', () => {
  const result = summarize({
    pending: [],
    backlog: { count: 42, bytes: 2 * 1024 ** 3, oldestMs: NOW - 50 * HOUR, days: [] },
    staleHours: 48,
    now: NOW,
  })
  assert.equal(result.notifications.length, 1)
  assert.equal(result.notifications[0].level, 'warning')
  assert.match(result.notifications[0].title, /42 photos still waiting/)
  assert.match(result.notifications[0].body, /2 days/)
  assert.match(result.notifications[0].body, /2\.0GB/)
  assert.equal(result.stale, true)
  assert.equal(result.status, 'ok')
})

test('the nag does not repeat on every tick while the backlog stays stuck', () => {
  // The job ticks every 15 minutes and a shut MacBook can stay shut for a week.
  // Without the throttle this is ~670 identical notifications.
  const backlog = { count: 42, bytes: 1024 ** 3, oldestMs: NOW - 50 * HOUR, days: [] }
  const first = summarize({ backlog, staleHours: 48, nagIntervalHours: 12, lastNaggedAt: null, now: NOW })
  assert.equal(first.nagged, true)
  assert.equal(first.notifications.length, 1)

  // 15 minutes later, still stuck, still true — but silent.
  const soon = summarize({
    backlog, staleHours: 48, nagIntervalHours: 12, lastNaggedAt: NOW, now: NOW + 15 * 60_000,
  })
  assert.equal(soon.stale, true, 'still genuinely stale')
  assert.equal(soon.nagged, false)
  assert.deepEqual(soon.notifications, [])

  // Half a day later it speaks up again.
  const later = summarize({
    backlog, staleHours: 48, nagIntervalHours: 12, lastNaggedAt: NOW, now: NOW + 12 * HOUR,
  })
  assert.equal(later.nagged, true)
  assert.equal(later.notifications.length, 1)
})

test('the throttle never silences a fresh plug-in', () => {
  // Photos arriving is always worth saying, even mid-throttle — otherwise
  // plugging the camera in during a stuck week looks like nothing happened.
  const result = summarize({
    pending: [{ kind: 'sync', copied: 3, duplicates: 0, days: ['2026-08-29'] }],
    backlog: { count: 45, bytes: 1024 ** 3, oldestMs: NOW - 50 * HOUR, days: [] },
    staleHours: 48,
    nagIntervalHours: 12,
    lastNaggedAt: NOW - 60_000,
    now: NOW,
  })
  assert.equal(result.notifications.length, 1)
  assert.equal(result.notifications[0].level, 'info')
  assert.equal(result.nagged, false)
})

test('report state round-trips and tolerates a missing or corrupt file', async () => {
  const file = join(SANDBOX, 'report-state.json')
  assert.deepEqual(await readReportState(file), { lastNaggedAt: null })

  await writeReportState(file, { lastNaggedAt: NOW })
  assert.deepEqual(await readReportState(file), { lastNaggedAt: NOW })

  await writeFile(file, 'not json')
  assert.deepEqual(await readReportState(file), { lastNaggedAt: null })
})

test('the threshold is a boundary, not a range', () => {
  const backlog = (hours) => ({ count: 1, bytes: 4 * 1024 ** 2, oldestMs: NOW - hours * HOUR, days: [] })
  assert.equal(summarize({ backlog: backlog(47.9), staleHours: 48, now: NOW }).stale, false)
  assert.equal(summarize({ backlog: backlog(48), staleHours: 48, now: NOW }).stale, true)
})

test('an empty backlog never nags, however old the timestamp looks', () => {
  const result = summarize({
    pending: [],
    backlog: { count: 0, bytes: 0, oldestMs: NOW - 1000 * HOUR, days: [] },
    now: NOW,
  })
  assert.deepEqual(result.notifications, [])
})

test('a sync error is surfaced even when nothing was copied', () => {
  const result = summarize({
    pending: [{ kind: 'error', error: 'not enough room: 200 photo(s) need 800MB' }],
    backlog: noBacklog,
    now: NOW,
  })
  assert.equal(result.notifications.length, 1)
  assert.equal(result.notifications[0].level, 'error')
  assert.match(result.notifications[0].body, /not enough room/)
})

test('a partial failure reports both what landed and what broke', () => {
  const result = summarize({
    pending: [{ kind: 'sync', copied: 8, duplicates: 0, days: ['2026-08-28'], error: 'EIO reading P1010009.JPG' }],
    backlog: noBacklog,
    now: NOW,
  })
  assert.equal(result.notifications.length, 2)
  assert.deepEqual(result.notifications.map((n) => n.level), ['info', 'error'])
})

test('scanBacklog counts photos, sizes them, and finds the oldest', async () => {
  const staging = join(SANDBOX, 'staging')
  await mkdir(join(staging, '2026/2026-08-28'), { recursive: true })
  await writeFile(join(staging, '2026/2026-08-28/a.JPG'), Buffer.alloc(1024))
  await writeFile(join(staging, '2026/2026-08-28/b.jpeg'), Buffer.alloc(2048))
  // Neither of these is a photo waiting for the Mac.
  await writeFile(join(staging, '2026/2026-08-28/.hidden.JPG'), Buffer.alloc(10))
  await writeFile(join(staging, '2026/2026-08-28/notes.txt'), 'x')

  const backlog = await scanBacklog(staging)
  assert.equal(backlog.count, 2)
  assert.equal(backlog.bytes, 3072)
  assert.deepEqual(backlog.days, ['2026-08-28'])
  assert.ok(backlog.oldestMs > 0)
})

test('scanBacklog on a directory that does not exist is empty, not an error', async () => {
  const backlog = await scanBacklog(join(SANDBOX, 'nope'))
  assert.equal(backlog.count, 0)
  assert.equal(backlog.oldestMs, null)
})

test('the spool round-trips, and committing marks everything reported', async () => {
  const file = join(SANDBOX, 'events.jsonl')
  await writeFile(file, [
    JSON.stringify({ kind: 'sync', copied: 2, reported: true }),
    'this line is not json',
    JSON.stringify({ kind: 'sync', copied: 5, reported: false }),
  ].join('\n') + '\n')

  // A truncated or corrupt line is skipped rather than taking the run with it —
  // the spool is appended to by a process that can be killed mid-write.
  const events = await readEvents(file)
  assert.equal(events.length, 2)
  assert.equal(events.filter((e) => !e.reported).length, 1)

  await commitEvents(file, events)
  const after_ = await readEvents(file)
  assert.equal(after_.length, 2)
  assert.equal(after_.every((e) => e.reported), true)
})

test('reading a spool that was never written is empty', async () => {
  assert.deepEqual(await readEvents(join(SANDBOX, 'never.jsonl')), [])
})
