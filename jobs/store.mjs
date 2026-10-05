// jobs/store.mjs — persistence for scheduled jobs, their run history, and the
// notifications a failed run raises.
//
// One file is the source of truth for every job: data/jobs.json. That single-store
// rule is deliberate. The bug this replaces was a WHOOP sync that looked enabled in
// the UI but resolved to `false` on the server, because "is this on" lived in two
// places (a studio-state.json entry and an env-seeded default) and the UI only ever
// showed one of them.
//
// Every mutation goes through one serialized read-modify-write. The scheduler tick
// and the HTTP handlers both update jobs, and without the mutex a run finishing at
// the same moment someone flips a toggle would silently drop one of the two.
//
// **Nothing here is a locked built-in.** `seedDefs` supplies the jobs a fresh
// install starts with, and that is the entire extent of its authority: it is read
// on first boot and when a *new* job id ships, never again. After that every field
// of every job — name, description, schedule, which skill it runs, whether it
// exists at all — is editable and deletable, because a job you can't change is a
// job you end up working around. A deleted seed is remembered in `deletedSeeds` so
// the next boot doesn't resurrect it.
//
// What a job actually *does* is one of three things, in precedence order:
//
//   1. `runner`  — names a code entrypoint in the bridge (the WHOOP sync is two
//                  HTTP calls). The name is data, so the job is still renameable
//                  and deletable.
//   2. `skillId` — renders an editable skill file from data/skills/ and runs it.
//                  This is how the daily brief and both ingests work.
//   3. `prompt`  — an inline prompt typed straight into the job.

import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdir, readFile, rename, writeFile, stat, appendFile } from 'node:fs/promises'
import { normalizeSchedule, nextRunAfter, describeSchedule } from './schedule.mjs'

// 'agent' is a totem's own judgement: it notifies when its run says NOTIFY (and
// on errors). See totems/core.mjs.
export const NOTIFY_MODES = ['always', 'agent', 'errors', 'never']
export const RUN_STATUSES = ['ok', 'error', 'skipped', 'running']
const MAX_NOTIFICATIONS = 100
const MAX_RUNS_BYTES = 2 * 1024 * 1024 // trim the history file past ~2MB
const DEFAULT_CATCHUP_MINUTES = 120

const nowMs = () => Date.now()

function normalizeNotify(value, fallback = 'errors') {
  return NOTIFY_MODES.includes(value) ? value : fallback
}

function clampCatchUp(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_CATCHUP_MINUTES
  return Math.min(Math.max(n, 0), 24 * 60)
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// A job as the API and UI see it.
//
// Saved state wins over the seed definition for every field a person can edit —
// the seed is a starting point, not an override. `def` still supplies the pieces
// that were never user data (which runner the job was shipped pointing at, what it
// says it needs connected) so a job keeps working when those change in code.
// Fall back to the seed only for a key the saved job has never carried. `??` is
// wrong here: clearing a field writes an explicit null, and `null ?? def.runner`
// would quietly hand the seed's value back — making "detach this runner" and
// "stop using a skill" impossible to express.
const savedOr = (saved, def, key) =>
  saved && Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : (def?.[key] ?? null)

function hydrate(id, saved, def, tz, runners = {}) {
  const schedule = normalizeSchedule(saved?.schedule ?? def?.schedule, def?.schedule?.time)
  const runner = savedOr(saved, def, 'runner')
  const runnerDef = runner ? runners[runner] : null
  const job = {
    id,
    // Provenance, not privilege: 'seeded' means "this shipped with Totem", and
    // that is all it means. Seeded jobs are as editable and deletable as any other.
    kind: def ? 'seeded' : 'user',
    name: saved?.name || def?.name || id,
    description: saved?.description ?? def?.description ?? '',
    iconName: saved?.iconName || def?.iconName || (schedule.type === 'interval' || schedule.type === 'window' ? 'bolt' : 'clock'),
    enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : Boolean(def?.enabled),
    schedule,
    scheduleLabel: describeSchedule(schedule),
    notify: normalizeNotify(saved?.notify, 'errors'),
    catchUpMinutes: clampCatchUp(saved?.catchUpMinutes ?? def?.catchUpMinutes),
    nextRunAt: Number.isFinite(saved?.nextRunAt) ? saved.nextRunAt : null,
    lastRun: saved?.lastRun || null,
    consecutiveFailures: Number(saved?.consecutiveFailures) || 0,
    createdAt: saved?.createdAt || null,
    updatedAt: saved?.updatedAt || null,
    // What it runs. See the header for the precedence rule.
    runner,
    skillId: savedOr(saved, def, 'skillId'),
    prompt: String(saved?.prompt || ''),
    requires: saved?.requires ?? def?.requires ?? [],
    action: saved?.action ?? def?.action ?? '',
    // Totem fields (totems/core.mjs). Every job is a totem; these say how it
    // thinks and where it talks.
    taskType: typeof saved?.taskType === 'string' ? saved.taskType.slice(0, 20) : '',
    browser: saved?.browser === true,
    threadId: typeof saved?.threadId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(saved.threadId) ? saved.threadId : null,
    recommendations: cleanRecommendations(saved?.recommendations),
  }
  // A job pointing at a runner the bridge no longer defines would otherwise fail
  // at 07:00 with a confusing message. Flag it so the UI can say so up front.
  job.runnerMissing = Boolean(runner && !runnerDef)
  // These describe the code entrypoint, so they come from the runner registry
  // rather than from saved state — otherwise a stale jobs.json could claim the
  // WHOOP sync takes a model override.
  job.agentless = Boolean(runnerDef?.agentless)
  // Some runners take no provider override (a chained multi-stage pipeline, say).
  // Those declare fixedProvider so the UI says "uses the default AI" rather than
  // showing a picker that silently does nothing.
  job.fixedProvider = Boolean(runnerDef?.fixedProvider)
  // Which AI runs it is a choice for every job that can honour one. An agentless
  // job (the WHOOP sync is plain HTTP) has no AI to pick at all.
  if (!job.agentless && !job.fixedProvider) {
    job.provider = saved?.provider || 'default'
    job.model = saved?.model || null
    job.effort = ['low', 'medium', 'high'].includes(saved?.effort) ? saved.effort : null
  }
  return job
}

// The builder's model suggestions, kept so the totem's settings can offer them again.
function cleanRecommendations(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 4).filter((r) => r && typeof r.provider === 'string').map((r) => ({
    provider: r.provider.slice(0, 60), model: String(r.model || '').slice(0, 120), effort: String(r.effort || '').slice(0, 10),
    label: String(r.label || '').slice(0, 120), account: String(r.account || '').slice(0, 80), driver: String(r.driver || '').slice(0, 20),
    cost: Math.min(3, Math.max(1, Math.round(Number(r.cost) || 2))), why: String(r.why || '').slice(0, 240),
  }))
}

// Only these fields are ever persisted for a job; anything else the client sends
// is dropped rather than trusted into the file.
function persistable(job) {
  const out = {
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    schedule: job.schedule,
    notify: job.notify,
    catchUpMinutes: job.catchUpMinutes,
    nextRunAt: job.nextRunAt,
    lastRun: job.lastRun,
    consecutiveFailures: job.consecutiveFailures,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    iconName: job.iconName,
    runner: job.runner,
    skillId: job.skillId,
    prompt: job.prompt,
    requires: job.requires,
    action: job.action,
    taskType: job.taskType,
    browser: job.browser,
    threadId: job.threadId,
    recommendations: job.recommendations,
  }
  if (!job.agentless && !job.fixedProvider) {
    out.provider = job.provider
    out.model = job.model
    out.effort = job.effort
  }
  return out
}

export function createJobStore({
  file,
  runsFile,
  notificationsFile,
  // The jobs a fresh install starts with. Read on first boot and when a new id
  // ships; never consulted again for a job that already exists.
  seedDefs = {},
  // Metadata about the code entrypoints a job's `runner` can name:
  // { 'whoop-sleep': { agentless: true }, 'some-pipeline': { fixedProvider: true } }
  runners = {},
  tz = 'UTC',
  log = () => {},
  webhookUrl = null,
  fetchImpl = globalThis.fetch,
  // Where a notification actually goes. Injected rather than imported so this
  // module keeps knowing nothing about push, service workers or devices — the
  // same reason `webhookUrl` and `fetchImpl` are injected. When it is absent the
  // ring file below is the whole story, which is how the tests run.
  deliver = null,
  // Ids and runner names that were renamed in code: { oldId: newId }. A saved job
  // under an old id is carried over, settings and history intact, on first read.
  renamedIds = {},
  renamedRunners = {},
}) {
  let queue = Promise.resolve()

  function applyRenames(raw) {
    for (const [from, to] of Object.entries(renamedIds)) {
      if (raw.jobs[from] && !raw.jobs[to]) raw.jobs[to] = raw.jobs[from]
      delete raw.jobs[from]
      raw.deletedSeeds = raw.deletedSeeds.map((id) => (id === from ? to : id))
    }
    for (const job of Object.values(raw.jobs)) {
      if (job && renamedRunners[job.runner]) job.runner = renamedRunners[job.runner]
    }
    return raw
  }

  const hydrateJob = (id, saved, raw) =>
    hydrate(id, saved, seedDefs[id], tz, runners)

  async function readRaw() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      return applyRenames({
        jobs: parsed.jobs || {},
        migratedFrom: parsed.migratedFrom || null,
        // Seeds the user deleted on purpose. Without this the backfill below
        // would put every built-in back on the next restart, which would read as
        // the app overruling you.
        deletedSeeds: Array.isArray(parsed.deletedSeeds) ? parsed.deletedSeeds : [],
      })
    } catch {
      return null
    }
  }

  async function writeRaw(raw) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify({ ...raw, updatedAt: new Date().toISOString() }, null, 2))
    await rename(tmp, file)
  }

  // Serialize every read-modify-write so concurrent callers can't clobber
  // each other. Returns whatever `fn` returns.
  function withLock(fn) {
    const run = queue.then(() => fn())
    // The chain is normalized to always settle, so one caller throwing can't
    // wedge every later mutation behind a rejected promise.
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  // First boot after this change: seed the store from whatever the old
  // studio-state.json said, so an enabled WHOOP sync at 11:00 stays enabled at
  // 11:00 instead of quietly reverting to a default.
  async function ensureStore(seed = {}) {
    const existing = await readRaw()
    if (existing) return existing
    const jobs = {}
    for (const [id, def] of Object.entries(seedDefs)) {
      const s = seed[id] || {}
      jobs[id] = persistable(hydrate(id, {
        enabled: typeof s.enabled === 'boolean' ? s.enabled : def.enabled,
        schedule: s.time ? { type: 'daily', time: s.time } : def.schedule,
        createdAt: new Date().toISOString(),
      }, def, tz, runners))
    }
    const raw = { jobs, deletedSeeds: [], migratedFrom: Object.keys(seed).length ? 'studio-state.json' : 'defaults' }
    await writeRaw(raw)
    log(`job store created at ${file} (${Object.keys(jobs).length} default jobs, seeded from ${raw.migratedFrom})`)
    return raw
  }

  // Add any seeded job that shipped after the store was written, so a new default
  // appears without anyone deleting jobs.json — but never one the user deleted.
  function backfillSeeds(raw) {
    let changed = false
    for (const [id, def] of Object.entries(seedDefs)) {
      if (raw.jobs[id] || raw.deletedSeeds?.includes(id)) continue
      raw.jobs[id] = persistable(hydrate(id, { createdAt: new Date().toISOString() }, def, tz, runners))
      changed = true
    }
    return changed
  }

  async function list({ seed } = {}) {
    return withLock(async () => {
      const raw = await ensureStore(seed)
      if (backfillSeeds(raw)) await writeRaw(raw)
      return Object.entries(raw.jobs)
        .map(([id, saved]) => hydrateJob(id, saved))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'seeded' ? -1 : 1))
    })
  }

  async function get(id) {
    const all = await list()
    return all.find((j) => j.id === id) || null
  }

  // Recompute nextRunAt for every enabled job that lacks one (fresh store, a job
  // just enabled, or a schedule edit). Called on boot and after every mutation:
  // an enabled job with no next run is a job that never fires, which is precisely
  // the class of silent failure this module exists to prevent.
  async function reschedule({ now = nowMs(), force = [] } = {}) {
    return withLock(async () => {
      const raw = await ensureStore()
      backfillSeeds(raw)
      let changed = false
      for (const [id, saved] of Object.entries(raw.jobs)) {
        const job = hydrateJob(id, saved)
        if (!job.enabled) {
          if (saved.nextRunAt != null) { saved.nextRunAt = null; changed = true }
          continue
        }
        if (saved.nextRunAt == null || force.includes(id)) {
          saved.nextRunAt = nextRunAfter(job.schedule, now, tz, job.lastRun?.startedAt ?? null)
          changed = true
        }
      }
      if (changed) await writeRaw(raw)
      return Object.entries(raw.jobs).map(([id, saved]) => hydrateJob(id, saved))
    })
  }

  async function create(input) {
    return withLock(async () => {
      const raw = await ensureStore()
      const name = cleanText(input?.name, 80) || 'Untitled job'
      const id = `job_${randomUUID().slice(0, 8)}`
      const schedule = normalizeSchedule(input?.schedule)
      const job = hydrate(id, {
        name,
        description: cleanText(input?.description, 300),
        iconName: input?.iconName,
        enabled: input?.enabled !== false,
        schedule,
        notify: input?.notify,
        catchUpMinutes: input?.catchUpMinutes,
        // A new job runs either a skill or an inline prompt. Both are accepted so
        // "write a prompt right here" stays as easy as it was, while "run the
        // Plaud skill on a second schedule" is now possible at all.
        skillId: input?.skillId ? String(input.skillId).slice(0, 64) : null,
        prompt: String(input?.prompt || '').slice(0, 8000),
        provider: input?.provider || 'default',
        model: input?.model || null,
        effort: input?.effort || null,
        taskType: input?.taskType,
        browser: input?.browser === true,
        threadId: input?.threadId,
        recommendations: input?.recommendations,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, null, tz, runners)
      job.nextRunAt = job.enabled ? nextRunAfter(job.schedule, nowMs(), tz, null) : null
      raw.jobs[id] = persistable(job)
      await writeRaw(raw)
      return hydrateJob(id, raw.jobs[id])
    })
  }

  async function update(id, patch) {
    return withLock(async () => {
      const raw = await ensureStore()
      const saved = raw.jobs[id]
      if (!saved) return null
      const before = hydrateJob(id, saved)
      const next = { ...saved }

      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      // `|| .from` so editing a window's step without resending its times keeps
      // the window where it was, rather than defaulting the hour to 08:00.
      if (patch.schedule !== undefined) next.schedule = normalizeSchedule(patch.schedule, before.schedule.time || before.schedule.from)
      if (patch.notify !== undefined) next.notify = normalizeNotify(patch.notify, before.notify)
      if (patch.catchUpMinutes !== undefined) next.catchUpMinutes = clampCatchUp(patch.catchUpMinutes)
      if (patch.iconName !== undefined) next.iconName = String(patch.iconName || '').slice(0, 40)
      // Every job's identity is editable, seeded or not. A built-in whose name you
      // can't change is one you end up describing to yourself in a comment.
      if (patch.name !== undefined) next.name = cleanText(patch.name, 80) || before.name
      if (patch.description !== undefined) next.description = cleanText(patch.description, 300)
      if (patch.prompt !== undefined) next.prompt = String(patch.prompt || '').slice(0, 8000)
      // Repointing a job at a different skill is the main way to change what a
      // built-in does without touching code. `null` falls back to the inline prompt.
      if (patch.skillId !== undefined) next.skillId = patch.skillId ? String(patch.skillId).slice(0, 64) : null
      // Detaching a runner turns a code job into a prompt job — allowed, and the
      // only way to make e.g. the WHOOP sync do something else instead.
      if (patch.runner !== undefined) next.runner = patch.runner ? String(patch.runner).slice(0, 64) : null
      // Which AI runs it is editable either way — unless it can't honour a choice.
      if (!before.agentless && !before.fixedProvider) {
        if (patch.provider !== undefined) next.provider = String(patch.provider || 'default').slice(0, 40)
        if (patch.model !== undefined) next.model = patch.model ? String(patch.model).slice(0, 120) : null
        if (patch.effort !== undefined) next.effort = patch.effort || null
      }
      if (typeof patch.browser === 'boolean') next.browser = patch.browser
      if (patch.taskType !== undefined) next.taskType = String(patch.taskType || '').slice(0, 20)
      if (patch.threadId !== undefined) next.threadId = patch.threadId || null
      if (patch.recommendations !== undefined) next.recommendations = patch.recommendations
      next.updatedAt = new Date().toISOString()

      const after = hydrateJob(id, next)
      // Any change to when or whether it runs invalidates the computed next run.
      const scheduleChanged = JSON.stringify(before.schedule) !== JSON.stringify(after.schedule)
      if (!after.enabled) after.nextRunAt = null
      else if (scheduleChanged || !before.enabled || after.nextRunAt == null) {
        after.nextRunAt = nextRunAfter(after.schedule, nowMs(), tz, after.lastRun?.startedAt ?? null)
      }
      raw.jobs[id] = persistable(after)
      await writeRaw(raw)
      return hydrateJob(id, raw.jobs[id])
    })
  }

  // Any job can be deleted, including one that shipped with Totem. Deleting a
  // seeded job records the id so the backfill doesn't hand it straight back on the
  // next boot; `restore(id)` is the deliberate way to get it again.
  async function remove(id) {
    return withLock(async () => {
      const raw = await ensureStore()
      if (!raw.jobs[id]) return { ok: false, error: 'no such job' }
      const wasSeeded = Boolean(seedDefs[id])
      delete raw.jobs[id]
      if (wasSeeded && !raw.deletedSeeds.includes(id)) raw.deletedSeeds.push(id)
      await writeRaw(raw)
      log(`job deleted: ${id}${wasSeeded ? ' (a default — it will not come back on restart)' : ''}`)
      return { ok: true, id, wasSeeded }
    })
  }

  /** Put a deleted default back, at its shipped settings. The undo for `remove`. */
  async function restore(id) {
    return withLock(async () => {
      const raw = await ensureStore()
      const def = seedDefs[id]
      if (!def) return { ok: false, error: 'that job did not ship with Totem, so there is nothing to restore' }
      if (raw.jobs[id]) return { ok: false, error: 'that job already exists' }
      raw.jobs[id] = persistable(hydrate(id, { createdAt: new Date().toISOString() }, def, tz, runners))
      raw.deletedSeeds = raw.deletedSeeds.filter((x) => x !== id)
      await writeRaw(raw)
      return { ok: true, job: hydrateJob(id, raw.jobs[id]) }
    })
  }

  // Claim a job for running: flips it to running and advances nextRunAt in one
  // locked step, so two overlapping ticks can never both take the same slot.
  async function claim(id, { now = nowMs(), trigger = 'schedule' } = {}) {
    return withLock(async () => {
      const raw = await ensureStore()
      const saved = raw.jobs[id]
      if (!saved) return null
      const job = hydrateJob(id, saved)
      if (job.lastRun?.status === 'running') return null
      saved.lastRun = { startedAt: now, status: 'running', trigger }
      // Advance before running, not after: an agent prompt can take minutes, and
      // the slot must not still look due while it's in flight.
      //
      // Only for scheduled runs, though. Hitting "Run now" at 09:00 must not push
      // an 11:00 daily job to tomorrow — the button is for testing a job, and
      // having it cancel today's real run would be a nasty surprise.
      if (trigger === 'schedule') {
        // Advance from the later of now and the slot being consumed. Measuring
        // from `now` alone is subtly wrong: a run that starts even slightly
        // before its slot would compute that same slot again and re-fire it.
        const from = Math.max(now, job.nextRunAt ?? 0)
        saved.nextRunAt = job.enabled ? nextRunAfter(job.schedule, from, tz, now) : null
      }
      await writeRaw(raw)
      return hydrateJob(id, saved)
    })
  }

  // Record the outcome. Returns the updated job so the caller can decide whether
  // the result is worth notifying about.
  async function finish(id, result) {
    const record = {
      ts: nowMs(),
      jobId: id,
      status: RUN_STATUSES.includes(result.status) ? result.status : 'ok',
      startedAt: result.startedAt ?? null,
      ms: result.startedAt ? Math.max(0, nowMs() - result.startedAt) : null,
      trigger: result.trigger || 'schedule',
      provider: result.provider || null,
      error: result.error ? cleanText(result.error, 600) : null,
      errorKind: result.errorKind || null,
      preview: result.output ? cleanText(result.output, 400) : null,
      late: Boolean(result.late),
    }
    await appendRun(record)
    const job = await withLock(async () => {
      const raw = await ensureStore()
      const saved = raw.jobs[id]
      if (!saved) return null
      saved.lastRun = { ...record }
      delete saved.lastRun.jobId
      saved.consecutiveFailures = record.status === 'error'
        ? (Number(saved.consecutiveFailures) || 0) + 1
        : 0
      // claim() already advanced the schedule for a scheduled run, and left it
      // alone for a manual one. The only gap to close is an enabled job that
      // somehow has no next run — never leave one in that state, since that's a
      // job that silently stops firing.
      const hydrated = hydrateJob(id, saved)
      if (hydrated.enabled && saved.nextRunAt == null) {
        saved.nextRunAt = nextRunAfter(hydrated.schedule, nowMs(), tz, null)
      }
      await writeRaw(raw)
      return hydrateJob(id, saved)
    })
    return { job, record }
  }

  // ---- run history --------------------------------------------------------

  async function appendRun(record) {
    try {
      await mkdir(dirname(runsFile), { recursive: true })
      await appendFile(runsFile, JSON.stringify(record) + '\n')
      await trimRuns()
    } catch (e) {
      log('job run log failed', e.message || e)
    }
  }

  async function trimRuns() {
    try {
      const s = await stat(runsFile)
      if (s.size <= MAX_RUNS_BYTES) return
      const lines = (await readFile(runsFile, 'utf8')).split('\n').filter(Boolean)
      const keep = lines.slice(-2000)
      const tmp = `${runsFile}.${randomUUID()}.tmp`
      await writeFile(tmp, keep.join('\n') + '\n')
      await rename(tmp, runsFile)
    } catch { /* trimming is housekeeping — never fatal */ }
  }

  async function runs({ jobId = null, limit = 50 } = {}) {
    let raw = ''
    try { raw = await readFile(runsFile, 'utf8') } catch { return [] }
    const out = []
    // Newest first, and stop as soon as enough are collected.
    const lines = raw.split('\n')
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line)
        if (jobId && rec.jobId !== jobId) continue
        out.push(rec)
      } catch { /* a torn line is not worth failing the whole request over */ }
    }
    return out
  }

  // ---- notifications ------------------------------------------------------

  async function readNotifications() {
    try {
      const parsed = JSON.parse(await readFile(notificationsFile, 'utf8'))
      return Array.isArray(parsed.items) ? parsed.items : []
    } catch { return [] }
  }

  // `category` is how the notification routes once it leaves here: quiet hours,
  // whether it is pinned, and what the bell files it under. Defaulting every
  // caller to `job.failed` was wrong in a way that mattered — an approval code
  // landed as a job failure, which defers overnight, and a code that arrives in
  // the morning is worthless.
  async function notify({ level = 'info', title, body = '', jobId = null, category = 'job.failed', url = null }) {
    const item = {
      id: `n_${randomUUID().slice(0, 8)}`,
      ts: nowMs(),
      level,
      title: cleanText(title, 120),
      body: cleanText(body, 600),
      jobId,
      category,
      url,
      read: false,
    }
    await withLock(async () => {
      const items = await readNotifications()
      items.unshift(item)
      await mkdir(dirname(notificationsFile), { recursive: true })
      const tmp = `${notificationsFile}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify({ items: items.slice(0, MAX_NOTIFICATIONS), updatedAt: new Date().toISOString() }, null, 2))
      await rename(tmp, notificationsFile)
    }).catch((e) => log('notification write failed', e.message || e))

    // Hand it to the notifier, which owns the ledger the bell reads and the push
    // to the phone. Best effort in exactly the way the webhook below is: a job
    // that failed must not also fail to be recorded because the phone is gone.
    if (deliver) {
      try {
        await deliver(item)
      } catch (e) {
        log('notification delivery failed', e.message || e)
      }
    }
    // Optional off-box delivery. ntfy/Pushover-shaped: the body is the message and
    // the title rides in a header. Best effort — a dead webhook must never take
    // down the run that raised it.
    if (webhookUrl && fetchImpl) {
      try {
        await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { Title: item.title, Priority: level === 'error' ? 'high' : 'default', Tags: 'totem' },
          body: item.body || item.title,
          signal: AbortSignal.timeout(8000),
        })
      } catch (e) {
        log('notification webhook failed', e.message || e)
      }
    }
    return item
  }

  async function notifications({ limit = 30 } = {}) {
    const items = await readNotifications()
    return { items: items.slice(0, limit), unread: items.filter((i) => !i.read).length }
  }

  async function markNotificationsRead(ids = null) {
    return withLock(async () => {
      const items = await readNotifications()
      for (const item of items) {
        if (!ids || ids.includes(item.id)) item.read = true
      }
      const tmp = `${notificationsFile}.${randomUUID()}.tmp`
      await mkdir(dirname(notificationsFile), { recursive: true })
      await writeFile(tmp, JSON.stringify({ items, updatedAt: new Date().toISOString() }, null, 2))
      await rename(tmp, notificationsFile)
      return { ok: true, unread: items.filter((i) => !i.read).length }
    })
  }

  return {
    file, runsFile, notificationsFile,
    list, get, create, update, remove, restore,
    reschedule, claim, finish,
    runs, notify, notifications, markNotificationsRead,
  }
}
