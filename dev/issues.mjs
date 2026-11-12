// dev/issues.mjs — the Dev tab's Issues list: GitHub issues (never PRs) in the
// watched repos plus the ones assigned to the server's gh login, in one list,
// newest-updated first. docs/dev-tab.md → Issues.
//
// Each source (one watched repo, or "assigned to the login") is read and cached
// on its own for five minutes, per state, so switching Mine/All or a repo never
// re-reads what is already fresh. Refresh re-reads a source at most once a
// minute. A source that fails answers its last good list, and the answer says
// which source failed and whether it has ever been read.
import { ghErrorMessage, ghSignedOut, mapLimit } from './github.mjs'

export const ISSUE_STATES = ['open', 'closed', 'all']
export const ISSUE_SCOPES = ['mine', 'watched', 'all']
export const ISSUES_CACHE_MS = 5 * 60_000
export const ISSUES_REFRESH_MS = 60_000
const LOGIN_CACHE_MS = 60 * 60_000
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const ASSIGNED = 'Assigned to you'

const badRequest = (message) => Object.assign(new Error(message), { status: 400 })
const issueKey = (i) => `${i.repo.toLowerCase()}#${i.number}`
const newestFirst = (a, b) =>
  String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.repo.localeCompare(b.repo) || b.number - a.number

export const OFF_REASON = 'Watch a repo below, or sign in the server’s gh (gh auth login), to list issues here.'

export function createIssueFeed({ github, config, now = () => Date.now() }) {
  // key -> { triedAt, okAt, issues, total, capped, warnings, error, pending }
  const sources = new Map()
  let viewer = null // { at, login, error, signedOut, pending }

  // Due: never read; a good read older than the cache; a failed read older
  // than a minute; or Refresh, once the last try is a minute old.
  const due = (hit, refresh) => {
    if (!hit) return true
    const age = now() - hit.triedAt
    if (age >= ISSUES_REFRESH_MS && (refresh || hit.error)) return true
    return age >= ISSUES_CACHE_MS
  }

  async function read(key, fetcher, refresh) {
    let hit = sources.get(key)
    if (hit?.pending) return hit.pending
    if (!due(hit, refresh)) return hit
    hit = hit || { triedAt: 0, okAt: null, issues: null, total: 0, capped: false, warnings: [], error: null }
    sources.set(key, hit)
    hit.pending = (async () => {
      hit.triedAt = now()
      try {
        const { issues, total, capped, warnings = [] } = await fetcher()
        Object.assign(hit, { okAt: hit.triedAt, issues, total: Number(total) || issues.length, capped: Boolean(capped), warnings, error: null })
      } catch (e) {
        hit.error = ghErrorMessage(e)
      } finally {
        hit.pending = null
      }
      return hit
    })()
    return hit.pending
  }

  async function login(refresh) {
    if (viewer?.pending) return viewer.pending
    const age = viewer ? now() - viewer.at : Infinity
    const fresh = viewer && (viewer.login && !viewer.error ? age < LOGIN_CACHE_MS : age < ISSUES_REFRESH_MS)
    if (fresh && !(refresh && age >= ISSUES_REFRESH_MS)) return viewer
    const pending = github.viewerLogin()
      .then((name) => (viewer = { at: now(), login: name, error: null, signedOut: false }))
      .catch((e) => (viewer = {
        at: now(),
        // A blip keeps the login it had; signed out means there is none.
        login: ghSignedOut(e) ? null : viewer?.login || null,
        error: ghErrorMessage(e),
        signedOut: ghSignedOut(e),
      }))
    viewer = { ...(viewer || { at: 0, login: null, error: null, signedOut: false }), pending }
    return pending
  }

  /**
   * `state`: open | closed | all. `scope`: mine (assigned to the gh login),
   * watched (the Dev tab's repos) or all (both). `repo`: one owner/name.
   */
  async function issues({ state = 'open', scope = 'all', repo = null, refresh = false } = {}) {
    if (!ISSUE_STATES.includes(state)) throw badRequest(`state must be one of ${ISSUE_STATES.join(', ')}`)
    if (!ISSUE_SCOPES.includes(scope)) throw badRequest(`scope must be one of ${ISSUE_SCOPES.join(', ')}`)
    if (repo != null && !REPO_RE.test(repo)) throw badRequest('repo must look like owner/name')
    const watched = config().repos
    const me = await login(refresh)
    const base = { state, scope, repo: repo || null, login: me.login, repos: watched }
    // Off only when there is truly nothing to read: no repos, and gh signed out
    // or missing. A gh that failed for another reason is an error, not "off".
    if (!watched.length && !me.login && me.signedOut) {
      return { ...base, enabled: false, reason: OFF_REASON, fetchedAt: null, issues: [], capped: [], errors: [], warnings: [] }
    }

    const sameRepo = (r) => !repo || r.toLowerCase() === repo.toLowerCase()
    const jobs = []
    if (scope !== 'mine') {
      for (const r of watched.filter(sameRepo)) jobs.push({ source: r, key: `${state}|repo|${r}`, fetch: () => github.repoIssues(r, state) })
    }
    if (scope !== 'watched') {
      if (me.login) jobs.push({ source: ASSIGNED, key: `${state}|assigned`, fetch: () => github.assignedIssues(state) })
      else jobs.push({ source: ASSIGNED, failed: me.error || 'gh is not signed in' })
    }

    const results = await mapLimit(jobs, 3, async (job) =>
      (job.failed ? { source: job.source, error: job.failed, issues: null, okAt: null } : { source: job.source, ...(await read(job.key, job.fetch, refresh)) }))

    const byKey = new Map()
    for (const res of results) {
      for (const issue of res.issues || []) {
        if (!sameRepo(issue.repo)) continue
        const k = issueKey(issue)
        const seen = byKey.get(k)
        if (!seen || String(issue.updatedAt) > String(seen.updatedAt)) byKey.set(k, issue)
      }
    }
    // `stale`: the source failed now but its last good list is in the answer;
    // otherwise it has never been read and nothing of it is shown.
    const errors = results.filter((r) => r.error).map((r) => ({ source: r.source, error: r.error, stale: Boolean(r.issues) }))
    const okTimes = results.map((r) => r.okAt).filter(Number.isFinite)
    return {
      ...base,
      enabled: true,
      fetchedAt: okTimes.length ? new Date(Math.min(...okTimes)).toISOString() : null,
      issues: [...byKey.values()].sort(newestFirst),
      capped: results.filter((r) => r.capped && r.issues).map((r) => ({ source: r.source, shown: r.issues.length, total: r.total })),
      errors,
      // Read, but GitHub left some out (an org that blocks the token, say).
      warnings: results.filter((r) => r.warnings?.length && r.issues).map((r) => ({ source: r.source, warning: r.warnings.join(' · ') })),
      ...(errors.length ? { error: errors.map((e) => `${e.source}: ${e.error}`).join(' · ') } : {}),
    }
  }

  return { issues }
}
