// jobs/triggers.mjs — jobs that wake when something changes, not on a clock.
//
// A job either runs on its `schedule` (jobs/schedule.mjs) or carries a
// `trigger`: { type: 'watch', source, everyMinutes }. A watch is checked on the
// job tick without any AI — one `git ls-remote` or one page fetch — and reduced
// to a fingerprint. The first check only records a baseline; every later change
// of fingerprint wakes the job once, with a description of what changed. So a
// totem can sit idle for a week and still react within minutes of a merge.
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

/** A trigger the engine can always check, or null (the job runs on its schedule). */
export function normalizeTrigger(raw) {
  if (!raw || raw.type !== 'watch') return null
  const source = cleanSource(raw.source)
  if (!source) return null
  const n = Math.round(Number(raw.everyMinutes))
  const everyMinutes = Math.min(Math.max(Number.isFinite(n) ? n : DEFAULT_MINUTES, MIN_MINUTES[source.kind]), MAX_MINUTES)
  return { type: 'watch', source, everyMinutes }
}

const shortRepo = (repo) => repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(homedir(), '~')
const every = (n) => (n === 1 ? 'every minute' : n % 60 === 0 ? `every ${n / 60 === 1 ? 'hour' : `${n / 60} hours`}` : `every ${n} minutes`)

export function describeTrigger(trigger) {
  const t = normalizeTrigger(trigger)
  if (!t) return ''
  const s = t.source
  if (s.kind === 'git') return `When ${s.ref} changes in ${shortRepo(s.repo)} (checked ${every(t.everyMinutes)})`
  const host = new URL(s.url).host.replace(/^www\./, '')
  return s.contains
    ? `When ${host} starts or stops showing “${s.contains}” (checked ${every(t.everyMinutes)})`
    : `When ${host} changes (checked ${every(t.everyMinutes)})`
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
 * Check a watch once. Returns { fingerprint, label } where `label` is a short
 * human description of the current state ("a1b2c3d", "shows “In stock”").
 * Throws with a readable message when the source can't be read.
 *
 * `exec(cmd, args, {cwd, env, timeoutMs})` resolves to stdout; `fetch` is WHATWG.
 */
export async function checkWatch(trigger, { exec, fetch = globalThis.fetch } = {}) {
  const t = normalizeTrigger(trigger)
  if (!t) throw new Error('not a watch trigger')
  const s = t.source
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
 * What changed, for the run that a change wakes. For a git branch in a local
 * checkout this fetches and lists the new commits; anywhere else it is the
 * before and after labels.
 */
export async function describeChange(trigger, before, after, { exec } = {}) {
  const t = normalizeTrigger(trigger)
  const s = t?.source
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
