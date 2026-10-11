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
const HEALTH_TIMEOUT_MS = 5_000

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
  return { enabled: repos.length > 0, repos, health, pollMinutes }
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

  /**
   * Add or remove one repo from the watched list. Adding needs a repo gh can see,
   * so a typo never becomes a card that only ever shows an error. One write at a
   * time, so two quick clicks cannot drop each other's change.
   */
  function setWatch(repo, watch) {
    repo = String(repo || '').trim()
    if (!REPO_RE.test(repo)) return Promise.reject(badRequest('repo must look like owner/name'))
    const result = writing.then(async () => {
      if (watch && !config().repos.includes(repo) && !(await github.repoVisible(repo))) {
        throw badRequest(`gh cannot see ${repo}.`)
      }
      const raw = readJsonSafe(configFile)
      const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      const repos = (Array.isArray(file.repos) ? file.repos : []).filter((r) => r !== repo)
      if (watch) repos.push(repo)
      await writeJsonAtomic(configFile, { ...file, repos })
      cache = null
      return { repo, watch: Boolean(watch), watched: config().repos }
    })
    writing = result.catch(() => {})
    return result
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

  return { config, status, setAiReview, setWatch, dispatchReview }
}
