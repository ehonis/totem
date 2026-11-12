// dev/runs.mjs — orchestrated runs pushed in by their ORCH threads, in
// data/dev-runs.json. docs/dev-tab.md → Runs.
//
// An ORCH thread (the `orchestrate` skill) runs on another box and keeps its
// state in a playbook Totem cannot read, so it POSTs a status body here on every
// tick. Only the latest body per run slug is kept. A run is archived when it
// reports its finish line, or when the owner archives it.
//
// The owner is pushed when a run starts waiting on him (waitingOnEthan goes from
// empty to non-empty) and when it reports an incident it has not reported
// before. The same item is not pushed twice within DEDUPE_MS, whatever the run
// does in between, so an ORCH that drops and re-adds a line every tick buzzes
// once an hour at most.
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

export const DEDUPE_MS = 60 * 60_000
export const SLUG_RE = /^[a-z0-9-]{1,64}$/
export const STAGES = ['building', 'pr', 'review', 'fixing', 'ready', 'merged', 'blocked']
export const CI_STATES = ['passing', 'failing', 'pending', 'none']
export const CATEGORY = 'dev.run'

const MAX_RUNS = 100
const MAX_THREADS = 100
const MAX_LINES = 50
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const ID_RE = /^[A-Za-z0-9:._%-]{1,200}$/
const CI_ALIASES = { success: 'passing', passed: 'passing', pass: 'passing', failure: 'failing', failed: 'failing', fail: 'failing', running: 'pending', queued: 'pending' }
const REVIEW_RE = /^review(?:[\s:#-]*(?:r|round\s*)?(\d{1,3}))?$/i

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const line = (value, max) => String(value).replace(/\s+/g, ' ').trim().slice(0, max)

class Invalid extends Error {}
const fail = (message) => { throw new Invalid(message) }

function optString(value, name, max) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number') fail(`${name} must be a string`)
  return line(value, max) || null
}

function lines(value, name, max = 500) {
  if (value == null) return []
  if (!Array.isArray(value)) fail(`${name} must be an array of strings`)
  if (value.length > MAX_LINES) fail(`${name} has more than ${MAX_LINES} items`)
  return value.map((v, i) => {
    if (typeof v !== 'string') fail(`${name}[${i}] must be a string`)
    return line(v, max)
  }).filter(Boolean)
}

function isoOrNull(value, name) {
  if (value == null || value === '') return null
  const t = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(t)) fail(`${name} must be an ISO date`)
  return new Date(t).toISOString()
}

function httpsUrl(value, name) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value) || value.length > 2000) fail(`${name} must be an http(s) URL`)
  return value
}

function score(value, name) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value).split('/')[0])
  if (!Number.isFinite(n) || n < 0 || n > 10) fail(`${name} must be a number from 0 to 10`)
  return Math.round(n * 10) / 10
}

function stageOf(value, round, name) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const review = REVIEW_RE.exec(text)
  if (review) {
    const r = review[1] ? Number(review[1]) : round == null || round === '' ? null : Number(round)
    if (r != null && !(Number.isInteger(r) && r > 0 && r < 1000)) fail(`${name}.round must be a whole number`)
    return { stage: 'review', round: r }
  }
  if (!STAGES.includes(text)) fail(`${name}.stage must be one of ${STAGES.join(', ')}`)
  return { stage: text, round: null }
}

// `pr` may be a number, "#12", or a GitHub pull URL; a number needs the run's repo
// to become a link.
function prOf(value, repo, name) {
  if (value == null || value === '') return null
  if (typeof value === 'number' || /^#?\d+$/.test(String(value).trim())) {
    const number = Number(String(value).trim().replace('#', ''))
    if (!Number.isInteger(number) || number <= 0) fail(`${name}.pr must be a PR number or URL`)
    return { number, url: repo ? `https://github.com/${repo}/pull/${number}` : null }
  }
  const url = httpsUrl(value, `${name}.pr`)
  const m = /\/pull\/(\d+)/.exec(url)
  return { number: m ? Number(m[1]) : null, url }
}

function ciOf(value, name) {
  if (value == null || value === '') return 'none'
  const text = String(value).trim().toLowerCase()
  const ci = CI_ALIASES[text] || text
  if (!CI_STATES.includes(ci)) fail(`${name}.ci must be one of ${CI_STATES.join(', ')}`)
  return ci
}

/**
 * Check an ORCH's status body and return the stored shape. Throws an Error whose
 * message says which field is wrong; unknown fields are ignored.
 */
export function validateRun(body) {
  try {
    if (!isObj(body)) fail('body must be a JSON object')
    const title = optString(body.title, 'title', 200)
    if (!title) fail('title is required')
    const repo = optString(body.repo, 'repo', 140)
    if (repo && !REPO_RE.test(repo)) fail('repo must be owner/name')
    const orchThreadId = optString(body.orchThreadId, 'orchThreadId', 200)
    if (orchThreadId && !ID_RE.test(orchThreadId)) fail('orchThreadId has characters a thread id does not')
    const environmentId = optString(body.environmentId, 'environmentId', 200)
    if (environmentId && !ID_RE.test(environmentId)) fail('environmentId has characters an environment id does not')
    if (body.threads != null && !Array.isArray(body.threads)) fail('threads must be an array')
    const rawThreads = body.threads || []
    if (rawThreads.length > MAX_THREADS) fail(`threads has more than ${MAX_THREADS} items`)
    const threads = rawThreads.map((t, i) => {
      const name = `threads[${i}]`
      if (!isObj(t)) fail(`${name} must be an object`)
      if (t.skippedSeats != null && !Array.isArray(t.skippedSeats)) fail(`${name}.skippedSeats must be an array of strings`)
      return {
        issue: optString(t.issue, `${name}.issue`, 40),
        title: optString(t.title, `${name}.title`, 200) || '',
        ...stageOf(t.stage, t.round, name),
        lastReportAt: isoOrNull(t.lastReportAt, `${name}.lastReportAt`),
        pr: prOf(t.pr, repo, name),
        ci: ciOf(t.ci, name),
        codeScore: score(t.codeScore, `${name}.codeScore`),
        uxScore: score(t.uxScore, `${name}.uxScore`),
        skippedSeats: lines(t.skippedSeats, `${name}.skippedSeats`, 60).slice(0, 20),
      }
    })
    if (body.finished != null && typeof body.finished !== 'boolean') fail('finished must be true or false')
    // A handoff that is a file path (HANDOFF.md beside the playbook) is still the finish
    // line; only a web link is kept, since the dashboard cannot open another machine's file.
    const handoff = optString(body.handoffUrl, 'handoffUrl', 2000)
    const handoffUrl = handoff && /^https?:\/\/\S+$/i.test(handoff) ? handoff : null
    return {
      run: optString(body.run, 'run', 120),
      title,
      repo,
      orchThreadId,
      environmentId,
      updatedAt: isoOrNull(body.updatedAt, 'updatedAt'),
      waitingOnEthan: lines(body.waitingOnEthan, 'waitingOnEthan'),
      incidents: lines(body.incidents, 'incidents'),
      threads,
      handoffUrl,
      // The finish line writes the handoff, so a handoff is a finish too.
      finished: body.finished === true || Boolean(handoff),
    }
  } catch (e) {
    if (e instanceof Invalid) { const err = new Error(e.message); err.status = 400; throw err }
    throw e
  }
}

const itemKey = (slug, kind, text) => `${slug}|${kind}|${createHash('sha256').update(text).digest('hex').slice(0, 16)}`

export function t3ThreadUrl(base, environmentId, threadId) {
  if (!base || !environmentId || !threadId) return null
  return `${String(base).replace(/\/+$/, '')}/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`
}

export function createRunStore({ file, notify, now = () => Date.now(), log = () => {}, t3Url = () => null, fs = { mkdir, readFile, rename, writeFile, unlink } }) {
  if (!file) throw new TypeError('createRunStore requires file')
  let chain = Promise.resolve()
  const locked = (fn) => {
    const result = chain.then(fn)
    chain = result.catch(() => {})
    return result
  }

  async function read() {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      return { runs: isObj(raw.runs) ? raw.runs : {}, notified: isObj(raw.notified) ? raw.notified : {} }
    } catch {
      return { runs: {}, notified: {} }
    }
  }

  // Temp file then rename, so a crash or a full disk leaves the last good file.
  async function write(state) {
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(state, null, 2))
      await fs.rename(tmp, file)
    } catch (e) {
      await fs.unlink(tmp).catch(() => {})
      throw e
    }
  }

  const shown = (slug, r) => ({ slug, ...r, orchUrl: t3ThreadUrl(t3Url(), r.environmentId, r.orchThreadId) })
  const lastSeen = (r) => Date.parse(r.updatedAt || r.receivedAt) || 0

  async function list() {
    const { runs } = await read()
    return Object.entries(runs).map(([slug, r]) => shown(slug, r)).sort((a, b) => lastSeen(b) - lastSeen(a))
  }

  /** Store one ORCH body and push what is new. Resolves to `{ run, notified }`. */
  function ingest(slug, body) {
    if (!SLUG_RE.test(String(slug))) { const e = new Error('slug must be 1-64 of a-z, 0-9 and -'); e.status = 400; return Promise.reject(e) }
    const next = validateRun(body)
    return locked(async () => {
      const state = await read()
      const at = now()
      const before = state.runs[slug] || null
      const receivedAt = new Date(at).toISOString()
      // A clock ahead of ours would read as "updated in 3 min"; it is now.
      const updatedAt = next.updatedAt && Date.parse(next.updatedAt) <= at ? next.updatedAt : receivedAt
      // Finishing archives the run once; after that only the owner's switch moves it.
      const { finished, ...fields } = next
      const finishedAt = before?.finishedAt || (finished ? receivedAt : null)
      const archived = before ? Boolean(before.archived) || (finished && !before.finishedAt) : finished
      const run = {
        ...fields,
        updatedAt,
        receivedAt,
        finishedAt,
        archived,
        archivedAt: archived ? before?.archivedAt || receivedAt : null,
      }

      const fresh = []
      if (!(before?.waitingOnEthan?.length) && run.waitingOnEthan.length) {
        fresh.push({ kind: 'waiting', key: itemKey(slug, 'waiting', run.waitingOnEthan.join('\n')), title: `${run.title}: waiting on you`, body: run.waitingOnEthan.join(' · ') })
      }
      const seenIncidents = new Set(before?.incidents || [])
      for (const text of run.incidents) {
        if (!seenIncidents.has(text)) fresh.push({ kind: 'incident', key: itemKey(slug, 'incident', text), title: `${run.title}: incident`, body: text })
      }

      for (const [key, t] of Object.entries(state.notified)) if (at - Date.parse(t) >= DEDUPE_MS) delete state.notified[key]
      const notified = []
      for (const item of fresh) {
        if (state.notified[item.key] || !notify) continue
        try {
          const sent = await notify({ level: item.kind === 'incident' ? 'error' : 'warn', title: item.title, body: item.body, category: CATEGORY, url: '/dev' })
          const delivery = sent?.delivery
          const ok = delivery ? Boolean(delivery.ok) || delivery.reason === 'not-configured' || delivery.reason === 'no-devices' : true
          if (ok) { state.notified[item.key] = receivedAt; notified.push(item.kind) }
        } catch (e) {
          log('run alert delivery failed', e?.message || e)
        }
      }

      state.runs[slug] = run
      // Keep the newest MAX_RUNS; an ORCH that names a fresh slug per tick cannot grow the file forever.
      const order = Object.entries(state.runs).sort((a, b) => lastSeen(b[1]) - lastSeen(a[1]))
      state.runs = Object.fromEntries(order.slice(0, MAX_RUNS))
      await write(state)
      return { run: shown(slug, run), notified }
    })
  }

  /** The owner's archive switch. A 404 for a slug never pushed. */
  function setArchived(slug, archived) {
    return locked(async () => {
      const state = await read()
      const run = state.runs[slug]
      if (!run) { const e = new Error('no such run'); e.status = 404; throw e }
      run.archived = Boolean(archived)
      run.archivedAt = run.archived ? new Date(now()).toISOString() : null
      await write(state)
      return { run: shown(slug, run) }
    })
  }

  return { list, ingest, setArchived }
}
