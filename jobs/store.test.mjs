// Run with: node --test jobs/store.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobStore } from './store.mjs'
import { localParts } from './schedule.mjs'

const TZ = 'America/New_York'

const SEED_DEFS = {
  'daily-brief': { name: 'Daily brief', schedule: { type: 'daily', time: '07:30' }, enabled: false, skillId: 'daily-brief' },
  'whoop-sleep-ingest': { name: 'WHOOP sleep sync', schedule: { type: 'daily', time: '11:00' }, enabled: false, runner: 'whoop-sleep' },
}

// What each `runner` name means. agentless/fixedProvider describe the code, so
// they live here rather than in saved state.
const RUNNERS = {
  'whoop-sleep': { agentless: true },
  // No shipped runner currently pins its provider; kept as a fixture so the
  // fixedProvider plumbing stays covered.
  'pinned-provider-runner': { fixedProvider: true },
}

async function freshStore(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-jobs-'))
  return createJobStore({
    file: join(dir, 'jobs.json'),
    runsFile: join(dir, 'job-runs.jsonl'),
    notificationsFile: join(dir, 'notifications.json'),
    seedDefs: SEED_DEFS,
    runners: RUNNERS,
    tz: TZ,
    ...opts,
  })
}

test('seeds default jobs from the old studio-state shape, preserving enabled + time', async () => {
  const store = await freshStore()
  // This is the exact state that was on disk when the WHOOP sync was fixed.
  const jobs = await store.list({ seed: { 'whoop-sleep-ingest': { enabled: true, time: '11:00' }, 'daily-brief': { enabled: false } } })
  const whoop = jobs.find((j) => j.id === 'whoop-sleep-ingest')
  assert.equal(whoop.enabled, true, 'migration must not silently disable a job')
  assert.equal(whoop.schedule.time, '11:00')
  assert.equal(whoop.kind, 'seeded')
  assert.equal(jobs.find((j) => j.id === 'daily-brief').enabled, false)
})

test('an enabled job always has a next run after reschedule', async () => {
  const store = await freshStore()
  await store.list({ seed: { 'whoop-sleep-ingest': { enabled: true, time: '11:00' } } })
  const jobs = await store.reschedule()
  const whoop = jobs.find((j) => j.id === 'whoop-sleep-ingest')
  assert.ok(whoop.nextRunAt > Date.now(), 'enabled job must be scheduled')
  const p = localParts(whoop.nextRunAt, TZ)
  assert.equal(`${p.hour}:${String(p.minute).padStart(2, '0')}`, '11:00')
  // A disabled job carries no next run, so the tick loop can skip it cheaply.
  assert.equal(jobs.find((j) => j.id === 'daily-brief').nextRunAt, null)
})

// The whole point of the seeded/system distinction going away: a job that shipped
// with Totem is editable in every field, exactly like one you wrote yourself.
test('a seeded job can be renamed, re-described, and repointed at another skill', async () => {
  const store = await freshStore()
  await store.list()
  const patched = await store.update('daily-brief', {
    name: 'Morning rundown',
    description: 'My version.',
    skillId: 'my-own-brief',
  })
  assert.equal(patched.name, 'Morning rundown')
  assert.equal(patched.description, 'My version.')
  assert.equal(patched.skillId, 'my-own-brief')
  // Still seeded — that's provenance, and it's what lets the UI offer a reset.
  assert.equal(patched.kind, 'seeded')
})

test('a seeded job schedule and toggle stay editable', async () => {
  const store = await freshStore()
  await store.list()
  const moved = await store.update('daily-brief', { enabled: true, schedule: { type: 'weekly', time: '06:15', days: [1, 5] } })
  assert.equal(moved.enabled, true)
  assert.equal(moved.scheduleLabel, 'Mon, Fri at 6:15 AM')
  assert.ok(moved.nextRunAt > Date.now())
})

test('a seeded job can be deleted, and does not come back on the next boot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-jobs-'))
  const paths = {
    file: join(dir, 'jobs.json'),
    runsFile: join(dir, 'job-runs.jsonl'),
    notificationsFile: join(dir, 'notifications.json'),
  }
  const store = createJobStore({ ...paths, seedDefs: SEED_DEFS, runners: RUNNERS, tz: TZ })
  await store.list()
  const removed = await store.remove('daily-brief')
  assert.equal(removed.ok, true)
  assert.equal(removed.wasSeeded, true)
  assert.equal(await store.get('daily-brief'), null)

  // Restart: the backfill must respect the delete rather than overruling it.
  const rebooted = createJobStore({ ...paths, seedDefs: SEED_DEFS, runners: RUNNERS, tz: TZ })
  const jobs = await rebooted.list()
  assert.equal(jobs.find((j) => j.id === 'daily-brief'), undefined)
  // …but a genuinely new default still arrives.
  assert.ok(jobs.find((j) => j.id === 'whoop-sleep-ingest'))
})

test('a deleted default can be restored deliberately', async () => {
  const store = await freshStore()
  await store.list()
  await store.remove('daily-brief')
  const restored = await store.restore('daily-brief')
  assert.equal(restored.ok, true)
  assert.equal(restored.job.name, 'Daily brief')
  assert.equal(restored.job.skillId, 'daily-brief')
  // And restoring clears the tombstone, so it survives the next backfill.
  assert.ok((await store.list()).find((j) => j.id === 'daily-brief'))
})

test('restore refuses for a job that never shipped', async () => {
  const store = await freshStore()
  const mine = await store.create({ name: 'Mine', prompt: 'x' })
  await store.remove(mine.id)
  assert.equal((await store.restore(mine.id)).ok, false)
})

test('runner metadata comes from the registry, not from saved state', async () => {
  const store = await freshStore()
  const jobs = await store.list()
  const whoop = jobs.find((j) => j.id === 'whoop-sleep-ingest')
  assert.equal(whoop.runner, 'whoop-sleep')
  assert.equal(whoop.agentless, true)
  assert.equal(whoop.provider, undefined, 'an agentless job has no AI to pick')
  assert.equal(whoop.runnerMissing, false)
})

test('a job pointing at a runner the bridge no longer defines is flagged, not hidden', async () => {
  const store = await freshStore()
  await store.list()
  const patched = await store.update('daily-brief', { runner: 'runner-that-was-deleted' })
  assert.equal(patched.runnerMissing, true)
})

test('detaching a runner turns a code job into an ordinary prompt job', async () => {
  const store = await freshStore()
  await store.list()
  const patched = await store.update('whoop-sleep-ingest', { runner: null, prompt: 'Ask WHOOP nicely.' })
  assert.equal(patched.runner, null)
  assert.equal(patched.agentless, false)
  assert.equal(patched.prompt, 'Ask WHOOP nicely.')
  // It can pick an AI now that it is no longer two HTTP calls.
  assert.equal(patched.provider, 'default')
})

// Same trap as the runner one: `null ?? def.skillId` would hand the seed's skill
// straight back, so "stop using a skill, use this prompt instead" would not stick.
test('a seeded job can drop its skill in favour of an inline prompt', async () => {
  const store = await freshStore()
  await store.list()
  const patched = await store.update('daily-brief', { skillId: null, prompt: 'Just tell me the weather.' })
  assert.equal(patched.skillId, null)
  assert.equal(patched.prompt, 'Just tell me the weather.')
})

test('a job can be created against a skill instead of an inline prompt', async () => {
  const store = await freshStore()
  const job = await store.create({
    name: 'Second Plaud sweep',
    skillId: 'plaud-action-items-ingest',
    schedule: { type: 'daily', time: '17:00' },
  })
  assert.equal(job.skillId, 'plaud-action-items-ingest')
  assert.equal(job.kind, 'user')
  assert.equal(job.scheduleLabel, 'Every day at 5:00 PM')
})

test('an edit to a seeded job survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-jobs-'))
  const paths = {
    file: join(dir, 'jobs.json'),
    runsFile: join(dir, 'job-runs.jsonl'),
    notificationsFile: join(dir, 'notifications.json'),
  }
  const store = createJobStore({ ...paths, seedDefs: SEED_DEFS, runners: RUNNERS, tz: TZ })
  await store.list()
  await store.update('daily-brief', { name: 'Morning rundown' })
  const rebooted = createJobStore({ ...paths, seedDefs: SEED_DEFS, runners: RUNNERS, tz: TZ })
  assert.equal((await rebooted.get('daily-brief')).name, 'Morning rundown')
})

// Upgrade path: a jobs.json written before this change has no name/runner/skillId
// stored for its built-ins, because the old code refused to persist them.
test('a pre-existing store without runner/skillId picks them up from the seed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-jobs-'))
  const file = join(dir, 'jobs.json')
  await writeFile(file, JSON.stringify({
    jobs: {
      'whoop-sleep-ingest': { enabled: true, schedule: { type: 'daily', time: '11:00' }, nextRunAt: null },
    },
  }))
  const store = createJobStore({
    file,
    runsFile: join(dir, 'job-runs.jsonl'),
    notificationsFile: join(dir, 'notifications.json'),
    seedDefs: SEED_DEFS,
    runners: RUNNERS,
    tz: TZ,
  })
  const whoop = (await store.list()).find((j) => j.id === 'whoop-sleep-ingest')
  assert.equal(whoop.name, 'WHOOP sleep sync')
  assert.equal(whoop.runner, 'whoop-sleep')
  assert.equal(whoop.agentless, true)
  assert.equal(whoop.enabled, true, 'the upgrade must not disable a running job')
})

test('user jobs round-trip a prompt, provider, and interval schedule', async () => {
  const store = await freshStore()
  const job = await store.create({
    name: '  Check the deploy  ',
    prompt: 'Check whether the latest deploy is healthy and summarise.',
    provider: 'claude',
    schedule: { type: 'interval', everyMinutes: 90 },
    notify: 'always',
  })
  assert.equal(job.name, 'Check the deploy')
  assert.equal(job.kind, 'user')
  assert.equal(job.provider, 'claude')
  assert.equal(job.scheduleLabel, 'Every 1h 30m')
  assert.ok(job.nextRunAt > Date.now())
  assert.equal((await store.get(job.id)).prompt, 'Check whether the latest deploy is healthy and summarise.')
  assert.equal((await store.remove(job.id)).ok, true)
  assert.equal(await store.get(job.id), null)
})

test('disabling clears the next run; re-enabling recomputes it', async () => {
  const store = await freshStore()
  const job = await store.create({ name: 'x', prompt: 'y', schedule: { type: 'daily', time: '09:00' } })
  assert.ok(job.nextRunAt)
  assert.equal((await store.update(job.id, { enabled: false })).nextRunAt, null)
  assert.ok((await store.update(job.id, { enabled: true })).nextRunAt > Date.now())
})

test('claim is exclusive, so two overlapping ticks cannot both run one job', async () => {
  const store = await freshStore()
  const job = await store.create({ name: 'x', prompt: 'y', schedule: { type: 'daily', time: '09:00' } })
  const first = await store.claim(job.id)
  assert.ok(first, 'first claim wins')
  assert.equal(await store.claim(job.id), null, 'second claim while running must be refused')
  await store.finish(job.id, { status: 'ok', startedAt: Date.now() - 10, output: 'done' })
  assert.ok(await store.claim(job.id), 'claimable again once finished')
})

test('a scheduled claim advances the slot; a manual run leaves it alone', async () => {
  const store = await freshStore()
  const job = await store.create({ name: 'x', prompt: 'y', schedule: { type: 'daily', time: '09:00' } })
  const slot = job.nextRunAt

  await store.claim(job.id, { trigger: 'manual' })
  await store.finish(job.id, { status: 'ok', startedAt: Date.now(), trigger: 'manual' })
  assert.equal((await store.get(job.id)).nextRunAt, slot, 'Run now must not cancel today’s real run')

  await store.claim(job.id, { trigger: 'schedule' })
  assert.ok((await store.get(job.id)).nextRunAt > slot, 'a scheduled run moves to the next slot')
})

test('failures accumulate and successes reset the counter', async () => {
  const store = await freshStore()
  const job = await store.create({ name: 'x', prompt: 'y', schedule: { type: 'daily', time: '09:00' } })
  for (const _ of [1, 2, 3]) {
    await store.claim(job.id)
    await store.finish(job.id, { status: 'error', startedAt: Date.now(), error: 'provider logged out', errorKind: 'provider-auth' })
  }
  let current = await store.get(job.id)
  assert.equal(current.consecutiveFailures, 3)
  assert.equal(current.lastRun.status, 'error')
  assert.equal(current.lastRun.errorKind, 'provider-auth')
  assert.equal(current.lastRun.error, 'provider logged out')

  await store.claim(job.id)
  await store.finish(job.id, { status: 'ok', startedAt: Date.now() })
  current = await store.get(job.id)
  assert.equal(current.consecutiveFailures, 0)
  assert.equal(current.lastRun.error, null)
})

test('run history is newest-first and filterable per job', async () => {
  const store = await freshStore()
  const a = await store.create({ name: 'a', prompt: 'p', schedule: { type: 'daily', time: '09:00' } })
  const b = await store.create({ name: 'b', prompt: 'p', schedule: { type: 'daily', time: '09:00' } })
  for (const id of [a.id, b.id, a.id]) {
    await store.claim(id)
    await store.finish(id, { status: 'ok', startedAt: Date.now(), output: `ran ${id}` })
  }
  const all = await store.runs()
  assert.equal(all.length, 3)
  assert.ok(all[0].ts >= all[1].ts, 'newest first')
  assert.equal((await store.runs({ jobId: a.id })).length, 2)
  assert.equal((await store.runs({ jobId: b.id })).length, 1)
})

test('concurrent mutations do not lose writes', async () => {
  // Without the mutex these read-modify-writes clobber each other and only the
  // last one survives, which is how a toggle flipped during a run gets lost.
  const store = await freshStore()
  const created = await Promise.all(
    Array.from({ length: 12 }, (_, i) => store.create({ name: `job ${i}`, prompt: 'p', schedule: { type: 'daily', time: '09:00' } })),
  )
  const jobs = await store.list()
  assert.equal(jobs.filter((j) => j.kind === 'user').length, 12)
  await Promise.all(created.map((j, i) => store.update(j.id, { enabled: i % 2 === 0 })))
  const after = await store.list()
  assert.equal(after.filter((j) => j.kind === 'user' && j.enabled).length, 6)
})

test('notifications ring buffer records errors and marks them read', async () => {
  const store = await freshStore()
  await store.notify({ level: 'error', title: 'Job failed', body: 'cursor is logged out', jobId: 'x' })
  await store.notify({ level: 'info', title: 'Job ran' })
  let feed = await store.notifications()
  assert.equal(feed.unread, 2)
  assert.equal(feed.items[0].title, 'Job ran', 'newest first')
  await store.markNotificationsRead([feed.items[0].id])
  feed = await store.notifications()
  assert.equal(feed.unread, 1)
  await store.markNotificationsRead()
  assert.equal((await store.notifications()).unread, 0)
})

test('the notification webhook is best effort and never breaks a run', async () => {
  const calls = []
  const store = await freshStore({
    webhookUrl: 'https://ntfy.example/totem',
    fetchImpl: async (url, init) => { calls.push({ url, init }); throw new Error('network down') },
  })
  // Must resolve despite the webhook throwing.
  const item = await store.notify({ level: 'error', title: 'Job failed', body: 'boom' })
  assert.equal(item.title, 'Job failed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Title, 'Job failed')
  assert.equal(calls[0].init.headers.Priority, 'high')
  assert.equal((await store.notifications()).unread, 1, 'stored even though delivery failed')
})

test('a job added to the code catalog later appears without wiping the store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-jobs-'))
  const paths = {
    file: join(dir, 'jobs.json'),
    runsFile: join(dir, 'job-runs.jsonl'),
    notificationsFile: join(dir, 'notifications.json'),
    tz: TZ,
  }
  const before = createJobStore({ ...paths, seedDefs: SEED_DEFS, runners: RUNNERS })
  await before.update('daily-brief', { enabled: true })

  const after = createJobStore({
    ...paths,
    runners: RUNNERS,
    seedDefs: { ...SEED_DEFS, 'brand-new-job': { name: 'Brand new', schedule: { type: 'daily', time: '05:00' } } },
  })
  const jobs = await after.list()
  assert.ok(jobs.find((j) => j.id === 'brand-new-job'), 'new built-in backfilled')
  assert.equal(jobs.find((j) => j.id === 'daily-brief').enabled, true, 'existing state preserved')
  // And it survives to disk, not just this read.
  const onDisk = JSON.parse(await readFile(paths.file, 'utf8'))
  assert.ok(onDisk.jobs['brand-new-job'])
})

test('a seeded job can be pointed at a different AI, but an agentless one cannot', async () => {
  const store = await freshStore()
  await store.list()
  const brief = await store.update('daily-brief', { provider: 'claude', model: 'opus' })
  assert.equal(brief.provider, 'claude')
  assert.equal(brief.model, 'opus')
  // The WHOOP sync is plain HTTP against WHOOP's API — there is no AI to choose,
  // so the field must not exist rather than sit there doing nothing.
  const whoop = await store.update('whoop-sleep-ingest', { provider: 'claude' })
  assert.equal(whoop.agentless, true)
  assert.equal(whoop.provider, undefined)
  assert.equal((await store.get('whoop-sleep-ingest')).provider, undefined)
})

test('user jobs default to the default provider rather than a hardcoded one', async () => {
  const store = await freshStore()
  const job = await store.create({ name: 'x', prompt: 'y', schedule: { type: 'daily', time: '09:00' } })
  assert.equal(job.provider, 'default')
})

test('a notification is handed to the delivery hook as well as written down', async () => {
  // jobs/store owns the raising of a notification; notify/ owns getting it to the
  // phone. Before this hook, a failed WHOOP sync died in a JSON ring nobody opened.
  const delivered = []
  const store = await freshStore({ deliver: async (item) => { delivered.push(item) } })
  await store.notify({ level: 'error', title: 'WHOOP sleep sync failed', body: 'token refresh 400', jobId: 'whoop-sleep-ingest' })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].title, 'WHOOP sleep sync failed')
  assert.equal(delivered[0].jobId, 'whoop-sleep-ingest')
  assert.equal((await store.notifications()).items.length, 1)
})

test('a failing delivery hook never loses the notification', async () => {
  const store = await freshStore({ deliver: async () => { throw new Error('phone is gone') } })
  await store.notify({ level: 'error', title: 'still recorded' })
  const { items } = await store.notifications()
  assert.equal(items[0].title, 'still recorded')
})

test('a notification can name its own category, and defaults to a job failure', async () => {
  // Everything routed as `job.failed` meant approval codes deferred overnight —
  // and a single-use, time-limited code that arrives in the morning is worthless.
  const seen = []
  const store = await freshStore({ deliver: async (item) => { seen.push(item) } })
  await store.notify({ title: 'Approval needed', category: 'approval.pending', url: '/logs' })
  await store.notify({ title: 'WHOOP sync failed', level: 'error' })
  assert.deepEqual(seen.map((i) => i.category), ['approval.pending', 'job.failed'])
  assert.equal(seen[0].url, '/logs')
})

test('a job saved under a renamed id and runner carries over with its settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-jobs-rename-'))
  const file = join(dir, 'jobs.json')
  await writeFile(file, JSON.stringify({
    jobs: { 'old-sync': { enabled: true, runner: 'old-runner', schedule: { type: 'interval', everyMinutes: 15 }, createdAt: '2026-09-01T00:00:00.000Z' } },
    deletedSeeds: [],
  }))
  const store = createJobStore({
    file, runsFile: join(dir, 'runs.jsonl'), notificationsFile: join(dir, 'n.json'),
    seedDefs: { 'new-sync': { name: 'Sync', runner: 'new-runner', enabled: false, schedule: { type: 'interval', everyMinutes: 15 } } },
    runners: { 'new-runner': { agentless: true } },
    tz: TZ,
    renamedIds: { 'old-sync': 'new-sync' },
    renamedRunners: { 'old-runner': 'new-runner' },
  })
  const jobs = await store.list()
  assert.deepEqual(jobs.map((j) => j.id), ['new-sync'])
  assert.equal(jobs[0].enabled, true, 'an enabled job stays enabled')
  assert.equal(jobs[0].runner, 'new-runner')
})
