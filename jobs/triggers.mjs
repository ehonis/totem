// jobs/triggers.mjs — jobs that wake when something changes, not on a clock.
//
// A job either runs on its `schedule` (jobs/schedule.mjs) or carries a
// `trigger`: { type: 'watch', sources, everyMinutes }. A watch is checked on the
// job tick without any AI — one `git ls-remote` or one page fetch per source —
// and each source is reduced to a fingerprint. A source's first check only
// records its baseline; a later change of fingerprint wakes the job once, with a
// description of everything that changed in that check. So a totem can sit idle
// for a week and still react within minutes of a merge in any of its repos.
// The older single `source` field is still read, as a list of one.
//
// Sources:
//   { kind: 'git', repo, ref }   — a branch. `repo` is a remote URL, or a local
//                                  checkout, in which case its `origin` is watched
//                                  (what was merged upstream, not the local HEAD).
//   { kind: 'url', url, contains? } — a web page. With `contains`, the
//                                  fingerprint is whether the page shows that text
//                                  (reliable); without, a hash of its visible text
//                                  (any edit counts, so pick pages that are stable).
//
// The checks take `exec` and `fetch` as arguments so they test without a network.

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

export const WATCH_KINDS = ['git', 'url']
const MIN_MINUTES = { git: 1, url: 5 }
const MAX_MINUTES = 24 * 60
const DEFAULT_MINUTES = 5
export const MAX_SOURCES = 20

// A ref or repo that starts with "-" would be read by git as an option
// (`--upload-pack=…` runs a command), so both are refused outright.
const REF = /^(?!-)[A-Za-z0-9._/-]{1,200}$/
const REMOTE = /^(https?:\/\/|ssh:\/\/|git@[A-Za-z0-9.-]+:)/

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p)

function cleanSource(s) {
  if (!s || typeof s !== 'object') return null
  if (s.kind === 'git') {
    const repo = String(s.repo || '').trim().slice(0, 500)
    if (!repo || repo.startsWith('-') || !(REMOTE.test(repo) || repo.startsWith('/') || repo.startsWith('~'))) return null
    const ref = String(s.ref || 'main').trim().replace(/^refs\/heads\//, '')
    return { kind: 'git', repo, ref: REF.test(ref) ? ref : 'main' }
  }
  if (s.kind === 'url') {
    let url
    try { url = new URL(String(s.url || '').trim()) } catch { return null }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const contains = String(s.contains || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    return { kind: 'url', url: url.href, ...(contains ? { contains } : {}) }
  }
  return null
}

/** Identifies a source across checks; a job's watch state keeps a baseline per key. */
export const sourceKey = (s) => (s.kind === 'git' ? `git ${s.repo} ${s.ref}` : `url ${s.url}${s.contains ? ` ${s.contains}` : ''}`)

const rawSources = (raw) => (Array.isArray(raw?.sources) ? raw.sources : raw?.source ? [raw.source] : [])

/**
 * A trigger the engine can always check, or null (the job runs on its schedule).
 * Unusable sources are dropped and duplicates merged; `isCompleteTrigger` says
 * whether anything was dropped. The interval is clamped to the strictest
 * minimum among its sources.
 */
export function normalizeTrigger(raw) {
  if (!raw || raw.type !== 'watch') return null
  const sources = []
  const keys = new Set()
  for (const s of rawSources(raw)) {
    const clean = cleanSource(s)
    if (!clean || keys.has(sourceKey(clean))) continue
    keys.add(sourceKey(clean))
    sources.push(clean)
  }
  if (!sources.length) return null
  const kept = sources.slice(0, MAX_SOURCES)
  const min = Math.max(...kept.map((s) => MIN_MINUTES[s.kind]))
  const n = Math.round(Number(raw.everyMinutes))
  const everyMinutes = Math.min(Math.max(Number.isFinite(n) ? n : DEFAULT_MINUTES, min), MAX_MINUTES)
  return { type: 'watch', sources: kept, everyMinutes }
}

/** True when every source it lists is usable, so saving it loses nothing he typed. */
export function isCompleteTrigger(raw) {
  const t = normalizeTrigger(raw)
  const listed = rawSources(raw)
  return !!t && listed.length <= MAX_SOURCES && listed.every((s) => cleanSource(s))
}

const shortRepo = (repo) => repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(homedir(), '~')
const every = (n) => (n === 1 ? 'every minute' : n % 60 === 0 ? `every ${n / 60 === 1 ? 'hour' : `${n / 60} hours`}` : `every ${n} minutes`)
const host = (url) => new URL(url).host.replace(/^www\./, '')

/** A source in a few words: "main in o/r", "shop.example". */
export function describeSource(s) {
  if (s.kind === 'git') return `${s.ref} in ${shortRepo(s.repo)}`
  return s.contains ? `${host(s.url)} showing “${s.contains}”` : host(s.url)
}

export function describeTrigger(trigger) {
  const t = normalizeTrigger(trigger)
  if (!t) return ''
  const checked = `(checked ${every(t.everyMinutes)})`
  if (t.sources.length > 1) {
    const names = t.sources.map(describeSource)
    const list = names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
    return `When ${list} changes ${checked}`
  }
  const s = t.sources[0]
  if (s.kind === 'git') return `When ${s.ref} changes in ${shortRepo(s.repo)} ${checked}`
  return s.contains
    ? `When ${host(s.url)} starts or stops showing “${s.contains}” ${checked}`
    : `When ${host(s.url)} changes ${checked}`
}

/** True when a watch is due a check. `state` is the job's saved `watch` record. */
export function watchDue(trigger, state, now) {
  const t = normalizeTrigger(trigger)
  if (!t) return false
  if (!Number.isFinite(state?.checkedAt)) return true
  return now - state.checkedAt >= t.everyMinutes * 60_000
}

// --- checks -----------------------------------------------------------------

// No prompt for credentials (a hang would wedge the check), and no `ext::`
// transport (it runs a command) whatever the box's git config says.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' }
const GIT_SAFE = ['-c', 'protocol.ext.allow=never']

function localRepo(repo) {
  if (REMOTE.test(repo)) return null
  const dir = expandHome(repo)
  try { if (statSync(dir).isDirectory() && existsSync(`${dir}/.git`)) return dir } catch { /* fall through */ }
  throw new Error(`${repo} is not a git checkout on this machine`)
}

function visibleText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Check one source. Returns { fingerprint, label } where `label` is a short
 * human description of the current state ("a1b2c3d", "shows “In stock”").
 * Throws with a readable message when the source can't be read.
 *
 * `exec(cmd, args, {cwd, env, timeoutMs})` resolves to stdout; `fetch` is WHATWG.
 */
export async function checkSource(s, { exec, fetch = globalThis.fetch } = {}) {
  if (s.kind === 'git') {
    const dir = localRepo(s.repo)
    const args = dir
      ? ['-C', dir, ...GIT_SAFE, 'ls-remote', '--heads', 'origin', `refs/heads/${s.ref}`]
      : [...GIT_SAFE, 'ls-remote', '--heads', s.repo, `refs/heads/${s.ref}`]
    const out = await exec('git', args, { env: GIT_ENV, timeoutMs: 30_000 })
    const sha = String(out).split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === `refs/heads/${s.ref}`)?.[0]
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) throw new Error(`no branch "${s.ref}" in ${shortRepo(s.repo)}`)
    return { fingerprint: sha, label: sha.slice(0, 7) }
  }
  const res = await fetch(s.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Totem watch)', Accept: 'text/html,text/plain,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`${new URL(s.url).host} answered HTTP ${res.status}`)
  const text = visibleText((await res.text()).slice(0, 2_000_000))
  if (s.contains) {
    const shows = text.toLowerCase().includes(s.contains.toLowerCase())
    return { fingerprint: shows ? 'present' : 'absent', label: shows ? `shows “${s.contains}”` : `does not show “${s.contains}”` }
  }
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  return { fingerprint: hash, label: `content hash ${hash.slice(0, 7)}` }
}

/**
 * Check every source of a watch, side by side. One unreadable source doesn't
 * stop the others: each result is { key, source, fingerprint, label } or
 * { key, source, error }. With several sources the error names which one.
 */
export async function checkWatch(trigger, deps = {}) {
  const t = normalizeTrigger(trigger)
  if (!t) throw new Error('not a watch trigger')
  return Promise.all(t.sources.map(async (source) => {
    const key = sourceKey(source)
    try {
      return { key, source, ...(await checkSource(source, deps)) }
    } catch (e) {
      const error = e?.message || String(e)
      return { key, source, error: t.sources.length > 1 ? `${describeSource(source)}: ${error}` : error }
    }
  }))
}

/**
 * What changed in one source, for the run that a change wakes. For a git branch
 * in a local checkout this fetches and lists the new commits; anywhere else it is
 * the before and after labels.
 */
export async function describeChange(s, before, after, { exec } = {}) {
  if (!s) return ''
  if (s.kind === 'git') {
    let commits = ''
    const dir = (() => { try { return localRepo(s.repo) } catch { return null } })()
    if (dir && exec && /^[0-9a-f]+$/.test(before.fingerprint) && /^[0-9a-f]+$/.test(after.fingerprint)) {
      try {
        await exec('git', ['-C', dir, ...GIT_SAFE, 'fetch', '--quiet', 'origin', s.ref], { env: GIT_ENV, timeoutMs: 60_000 })
        commits = String(await exec('git', ['-C', dir, 'log', '--oneline', '--no-decorate', '-n', '30', `${before.fingerprint}..${after.fingerprint}`], { timeoutMs: 15_000 })).trim()
      } catch { /* the SHAs alone still say what moved */ }
    }
    return `${s.ref} in ${shortRepo(s.repo)} moved from ${before.label} to ${after.label}.${commits ? `\nNew commits:\n${commits}` : ''}`
  }
  return `${s.url} changed. Before: ${before.label}. Now: ${after.label}.`
}

/** Every change one check saw, as one event: `changes` is [{ source, before, after }]. */
export async function describeChanges(changes, deps = {}) {
  const parts = await Promise.all(changes.map(({ source, before, after }) =>
    describeChange(source, before, after, deps).catch(() => `${describeSource(source)} moved from ${before.label} to ${after.label}.`)))
  return parts.join('\n\n')
}

/**
 * The saved `watch` record of a job, cleaned: one baseline per source key in
 * `seen`, plus when it was last checked or changed and the current error.
 * A record from before watches had several sources (a bare `fingerprint`) is
 * read as the baseline of the trigger's first source, so upgrading doesn't fire.
 */
export function cleanWatchState(w, trigger) {
  if (!w || typeof w !== 'object') return null
  const t = normalizeTrigger(trigger)
  const num = (v) => (Number.isFinite(v) ? v : null)
  const entry = (e) => ({ fingerprint: String(e.fingerprint).slice(0, 80), label: typeof e.label === 'string' ? e.label.slice(0, 200) : '' })
  const seen = {}
  if (w.seen && typeof w.seen === 'object') {
    for (const [key, e] of Object.entries(w.seen)) if (e && typeof e.fingerprint === 'string') seen[key.slice(0, 800)] = entry(e)
  } else if (typeof w.fingerprint === 'string' && t) {
    seen[sourceKey(t.sources[0])] = entry(w)
  }
  // Only sources it still watches keep a baseline.
  if (t) for (const key of Object.keys(seen)) if (!t.sources.some((s) => sourceKey(s) === key)) delete seen[key]
  return {
    seen,
    label: typeof w.label === 'string' ? w.label.slice(0, 1000) : '',
    checkedAt: num(w.checkedAt),
    changedAt: num(w.changedAt),
    error: typeof w.error === 'string' && w.error ? w.error.slice(0, 600) : null,
    failures: Number(w.failures) || 0,
  }
}
