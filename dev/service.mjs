// dev/service.mjs — the Dev tab: CI and review status of the owner's repos, the
// per-repo AI review switch, health checks, and recent alerts.
//
// Configured by data/dev.json (DEV_CONFIG_FILE). The watched repos are picked in
// the tab (PUT /api/dev/repos), which rewrites `repos` and keeps every other key;
// hand edits still work. An empty list means the feature is off and nothing
// calls GitHub. The file is re-read on each request, so no restart is needed.
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mapLimit } from './github.mjs'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CACHE_MS = 60_000
const SHIPPED_CACHE_MS = 10 * 60_000
export const SHIPPED_RANGES = [14, 30, 90]
const HEALTH_TIMEOUT_MS = 5_000
const MAX_GROUPS = 24
const MAX_GROUP_NAME = 40

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

async function writeJsonAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(obj, null, 2))
  await rename(tmp, path)
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 })

/** The config file, normalised. `enabled` is false when there is nothing to watch. */
export function loadDevConfig(file) {
  const raw = readJsonSafe(file) || {}
  const repos = [...new Set((Array.isArray(raw.repos) ? raw.repos : []).map((r) => String(r).trim()).filter((r) => REPO_RE.test(r)))]
  const health = (Array.isArray(raw.health) ? raw.health : [])
    .filter((h) => h && /^https?:\/\//i.test(String(h.url || '')))
    .map((h) => ({
      name: String(h.name || h.url).slice(0, 80),
      url: String(h.url),
      expect: Array.isArray(h.expect) && h.expect.length ? h.expect.map(Number).filter(Number.isFinite) : [200],
    }))
  const pollMinutes = Number(raw.pollMinutes) >= 1 ? Number(raw.pollMinutes) : 5
  const shippedHidden = [...new Set((Array.isArray(raw.shippedHidden) ? raw.shippedHidden : []).map(String).filter((r) => REPO_RE.test(r)))]
  const shippedGroups = normalizeGroups(raw.shippedGroups)
  return { enabled: repos.length > 0, repos, health, pollMinutes, shippedHidden, shippedGroups }
}

/**
 * Named sets of repos for PRs per day ("Work", "Side projects"). A name is kept
 * once (case aside) and a repo in its first group only, so a stray hand edit
 * never draws a PR twice.
 */
export function normalizeGroups(raw) {
  const names = new Set()
  const taken = new Set()
  const groups = []
  for (const g of Array.isArray(raw) ? raw : []) {
    const name = String(g?.name ?? '').trim().slice(0, MAX_GROUP_NAME)
    if (!name || names.has(name.toLowerCase()) || groups.length >= MAX_GROUPS) continue
    names.add(name.toLowerCase())
    const repos = []
    for (const r of Array.isArray(g.repos) ? g.repos : []) {
      const repo = String(r).trim()
      if (REPO_RE.test(repo) && !taken.has(repo)) { taken.add(repo); repos.push(repo) }
    }
    groups.push({ name, repos })
  }
  return groups
}

export async function checkHealth(entry, { fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const started = Date.now()
  try {
    const res = await fetchImpl(entry.url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    await res.body?.cancel?.().catch(() => {})
    return { name: entry.name, url: entry.url, ok: entry.expect.includes(res.status), status: res.status, ms: Date.now() - started }
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return { name: entry.name, url: entry.url, ok: false, status: null, ms: Date.now() - started, error: timedOut ? 'timed out' : String(e?.cause?.code || e?.message || e) }
  }
}

export function createDevService({ configFile, github, alerts, fetchImpl = fetch, now = () => Date.now(), cacheMs = CACHE_MS }) {
  if (!configFile) throw new TypeError('createDevService requires configFile')
  let cache = null // { at, key, repos, health }
  const shippedCache = new Map() // days -> { at, pulls }
  let writing = Promise.resolve()

  const config = () => loadDevConfig(configFile)

  async function status({ refresh = false } = {}) {
    const cfg = config()
    const recent = alerts ? await alerts.list(50) : []
    if (!cfg.enabled) return { enabled: false, watched: [], alerts: recent }
    const key = JSON.stringify([cfg.repos, cfg.health])
    if (refresh || !cache || cache.key !== key || now() - cache.at >= cacheMs) {
      const [repos, health] = await Promise.all([
        mapLimit(cfg.repos, 3, (repo) => github.repoStatus(repo)),
        Promise.all(cfg.health.map((h) => checkHealth(h, { fetchImpl }))),
      ])
      cache = { at: now(), key, repos, health }
    }
    return { enabled: true, watched: cfg.repos, repos: cache.repos, health: cache.health, alerts: recent, fetchedAt: new Date(cache.at).toISOString() }
  }

  const requireWatched = (repo) => {
    if (!config().repos.includes(repo)) throw badRequest(`${repo} is not watched in the Dev tab.`)
  }

  // One write at a time, so two quick clicks cannot drop each other's change.
  // `change` gets the file as it is now and returns the keys to replace.
  function updateConfig(change) {
    const result = writing.then(async () => {
      const raw = readJsonSafe(configFile)
      const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      await writeJsonAtomic(configFile, { ...file, ...(await change(file)) })
    })
    writing = result.catch(() => {})
    return result
  }

  /**
   * Add or remove one repo from the watched list. Adding needs a repo gh can see,
   * so a typo never becomes a card that only ever shows an error.
   */
  async function setWatch(repo, watch) {
    repo = String(repo || '').trim()
    if (!REPO_RE.test(repo)) throw badRequest('repo must look like owner/name')
    await updateConfig(async (file) => {
      if (watch && !config().repos.includes(repo) && !(await github.repoVisible(repo))) {
        throw badRequest(`gh cannot see ${repo}.`)
      }
      const repos = (Array.isArray(file.repos) ? file.repos : []).filter((r) => r !== repo)
      if (watch) repos.push(repo)
      return { repos }
    })
    cache = null
    return { repo, watch: Boolean(watch), watched: config().repos }
  }

  /**
   * The owner's merged PRs over the last `days`, in every repo, for the PRs per
   * day chart. Not gated on watched repos: it is about the owner, not a repo.
   * Search is rate-limited, so results are kept for ten minutes.
   */
  async function shipped({ days = 30, refresh = false } = {}) {
    days = Number(days)
    if (!SHIPPED_RANGES.includes(days)) throw badRequest(`days must be one of ${SHIPPED_RANGES.join(', ')}`)
    let hit = shippedCache.get(days)
    if (refresh || !hit || now() - hit.at >= SHIPPED_CACHE_MS) {
      // A day of slack before the range, so the browser can bucket by its own
      // timezone without losing the first morning.
      const since = new Date(now() - (days + 1) * 86_400_000).toISOString().slice(0, 10)
      hit = { at: now(), pulls: await github.mergedPulls(since, { today: new Date(now()) }) }
      shippedCache.set(days, hit)
    }
    const cfg = config()
    return { days, pulls: hit.pulls, hidden: cfg.shippedHidden, groups: cfg.shippedGroups, fetchedAt: new Date(hit.at).toISOString() }
  }

  /** Hide a repo from the chart, or show it again (kept in `shippedHidden`). */
  async function setShippedHidden(repo, hidden) {
    repo = String(repo || '').trim()
    if (!REPO_RE.test(repo)) throw badRequest('repo must look like owner/name')
    await updateConfig((file) => {
      const list = (Array.isArray(file.shippedHidden) ? file.shippedHidden : []).filter((r) => r !== repo)
      if (hidden) list.push(repo)
      return { shippedHidden: list }
    })
    return { repo, hidden: Boolean(hidden), shippedHidden: config().shippedHidden }
  }

  /** Replace the repo groups (kept in `shippedGroups`). */
  async function setShippedGroups(groups) {
    if (!Array.isArray(groups)) throw badRequest('groups must be a list')
    const clean = normalizeGroups(groups)
    await updateConfig(() => ({ shippedGroups: clean }))
    return { shippedGroups: config().shippedGroups }
  }

  /** A one-off review of one PR, whatever the AI review switch says. */
  async function dispatchReview(repo, number) {
    requireWatched(repo)
    if (!Number.isInteger(number) || number < 1) throw badRequest('PR number must be a positive integer')
    return github.dispatchReview(repo, number)
  }

  /** Only watched repos can be switched; anything else is a 400. */
  async function setAiReview(repo, enabled) {
    requireWatched(repo)
    const aiReview = await github.setAiReview(repo, Boolean(enabled))
    const card = cache?.repos.find((r) => r.repo === repo)
    if (card) card.aiReview = aiReview
    return { repo, aiReview }
  }

  return { config, status, setAiReview, setWatch, dispatchReview, shipped, setShippedHidden, setShippedGroups }
}
