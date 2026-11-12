// cliproxy/source.mjs — the proxy's logins, read for the ai-usage poller.
//
// One `GET /credentials` per poll is the whole cost of a cycle: it is a call to
// the proxy, not to a vendor, and every login in it carries the rate-limit headers
// of its last real request (passive quota). A vendor usage read through the proxy
// (active quota) happens only when that passive reading is old: no request in the
// last few minutes, a window that has reset since, or the owner pressed Refresh.
// At most once a minute per login while a dashboard is watching, once every ten
// minutes otherwise. Totem never refreshes a proxy login's token here; the proxy
// owns its tokens, and two refreshers of one Anthropic login kill it.
//
// A proxy that does not answer keeps its last readings: the first miss changes
// nothing, from the second on the logins are shown stale and the snapshot says the
// proxy is unreachable. Totem never falls back to the host's own CLI logins while
// the proxy is set up: those are not the pool, and switching would hide the outage.
import { toEpochMs } from '../ai-usage/util.mjs'
import { historyWindowsFromMeters } from './history.mjs'
import {
  CLAUDE_HEADERS,
  codexAccountId,
  codexPlanLabel,
  fetchActiveQuota,
  metersFromSignals,
  observedAt,
  planFromSignals,
} from './quota.mjs'

export const PROXY_PROVIDERS = new Set(['claude', 'codex'])
export const PASSIVE_FRESH_MS = 3 * 60_000
export const ACTIVE_MIN_WATCHED_MS = 60_000
export const ACTIVE_MIN_IDLE_MS = 10 * 60_000
const PROFILE_TTL_MS = 6 * 60 * 60_000
const FORCE_FLOOR_MS = 20_000
const RUN_EVERY_MS = 5 * 60_000

const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

/** The id a proxy login has in the usage snapshot. Never collides with a local profile. */
export const proxyAccountId = (provider, name) => `${provider}:proxy:${name}`

const str = (v) => (typeof v === 'string' ? v : '')
const int = (v) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}

/**
 * Why the proxy marked a login as failing, in a few words, never its raw text.
 * `auth` is a login that needs signing in again; `limited` one the proxy is
 * holding back right now (a credential cooldown or a retry time in the future);
 * `error` one the proxy says it cannot use for another reason.
 *
 * The proxy keeps the last 429's status and message on a login until a request
 * succeeds, so a 429 in the message alone is history, not a limit: once its
 * cooldown is over the meters say whether the window is still spent.
 */
export function classifyStatus(cred, at = Date.now()) {
  const message = str(cred.status_message)
  let parsed = null
  if (message.trim().startsWith('{')) {
    try { parsed = JSON.parse(message) } catch { parsed = null }
  }
  const code = Number(parsed?.status ?? parsed?.error?.status ?? 0)
  const type = str(parsed?.error?.type) || str(parsed?.type)
  const text = `${message} ${type}`.toLowerCase()
  const quota = code === 429 || /usage_limit|rate.?limit|quota/.test(text)
  if (!quota && (code === 401 || code === 403 || /invalid[_ ]grant|unauthori[sz]ed|refresh token|token (is )?(expired|revoked)|re-?login|sign in again/.test(text))) {
    return { kind: 'auth', reason: 'Login expired. Sign in again.' }
  }
  if (holdUntil(cred, at)) return { kind: 'limited', reason: quota ? 'Usage limit reached' : 'Cooling down' }
  if (quota) return { kind: 'ok', reason: null }
  if (str(cred.status) === 'error' && cred.unavailable === true) {
    return { kind: 'error', reason: code ? `The provider answered ${code}` : 'The proxy cannot use this login' }
  }
  return { kind: 'ok', reason: null }
}

/** Until when the proxy is holding the whole login back, or null. */
export function holdUntil(cred, at = Date.now()) {
  const retryAt = toEpochMs(cred.next_retry_after)
  const cooldown = (Array.isArray(cred.cooldowns) ? cred.cooldowns : [])
    .filter((c) => c?.scope !== 'model' && int(c?.remaining_seconds) > 0)
    .reduce((max, c) => Math.max(max, at + int(c.remaining_seconds) * 1000), 0)
  const until = Math.max(cooldown, retryAt && retryAt > at ? retryAt : 0)
  return until || null
}

/** The login's cooldowns as absolute times, from the seconds left when listed. */
export function cooldownsOf(cred, listedAt) {
  const out = []
  for (const c of Array.isArray(cred.cooldowns) ? cred.cooldowns : []) {
    const seconds = int(c?.remaining_seconds)
    if (seconds === null || seconds <= 0) continue
    out.push({
      scope: c.scope === 'model' ? 'model' : 'credential',
      model: c.scope === 'model' ? str(c.model_key) || null : null,
      reason: str(c.reason) || null,
      until: listedAt + seconds * 1000,
    })
  }
  return out
}

/** Last 20 ten-minute buckets; a success in the last two means it is serving now. */
function servingRecently(cred) {
  const buckets = Array.isArray(cred.recent_requests) ? cred.recent_requests : []
  return buckets.slice(-2).some((b) => Number(b?.success) > 0)
}

/** Claude's profile → plan label (Pro, Max 20x, Team). */
export function claudePlanFromProfile(body) {
  const org = body?.organization || {}
  const account = body?.account || {}
  const tier = str(org.rate_limit_tier)
  const multiple = /max_(\d+)x/i.exec(tier)?.[1]
  if (org.organization_type === 'claude_team' && (org.subscription_status === 'active' || !org.subscription_status)) return 'Team'
  if (account.has_claude_max) return multiple ? `Max ${multiple}x` : 'Max'
  if (account.has_claude_pro) return 'Pro'
  if (account.has_claude_max === false && account.has_claude_pro === false) return 'Free'
  return null
}

/**
 * A window whose reset has passed has refilled, as far as anything sent through
 * the proxy goes. Shown full and marked `refilled` until the next reading, which
 * the passed reset itself asks for (wantsActive).
 */
function refill(meters, now) {
  return meters.map((m) => (m.resetsAt && m.resetsAt <= now
    ? { ...m, beforeRefill: { remainingPct: m.remainingPct, resetsAt: m.resetsAt }, usedPct: 0, remainingPct: 100, resetsAt: null, refilled: true }
    : m))
}

export function createCliproxySource({ client, now = () => Date.now(), runs = null, log = () => {} } = {}) {
  // authIndex -> { metersAt, meters, plan, resetCredits, triedAt, error }. `metersAt`
  // is when the meters were read; `triedAt` the last attempt, good or not.
  const active = new Map()
  const profiles = new Map() // authIndex -> { at, plan }
  const lastRun = new Map() // source id -> { at, ok }
  let failures = 0
  let lastAccounts = []
  let status = { configured: false, reachable: null, error: null, code: null, checkedAt: null }
  let backends = new Set()
  let historyUnavailableFor = null

  /** One run-log entry per source per five minutes, or when its outcome flips. */
  async function record(source, ok, error) {
    if (typeof runs?.track !== 'function') return
    const prev = lastRun.get(source)
    const t = now()
    if (prev && prev.ok === ok && t - prev.at < RUN_EVERY_MS) return
    lastRun.set(source, { at: t, ok })
    try {
      await runs.track(source, async () => { if (!ok) throw error })
    } catch { /* recorded */ }
  }

  async function profilePlan(authIndex) {
    const hit = profiles.get(authIndex)
    if (hit && now() - hit.at < PROFILE_TTL_MS) return hit.plan
    try {
      const { statusCode, body } = await client.upstream(authIndex, { url: CLAUDE_PROFILE_URL, header: { ...CLAUDE_HEADERS }, timeoutMs: 10_000 })
      const plan = statusCode >= 200 && statusCode < 300 ? claudePlanFromProfile(body) : null
      const multiple = statusCode >= 200 && statusCode < 300 ? /max_(\d+)x/i.exec(str(body?.organization?.rate_limit_tier)) : null
      const size = multiple ? Number(multiple[1]) : plan ? 1 : hit?.size ?? null
      profiles.set(authIndex, { at: now(), plan: plan ?? hit?.plan ?? null, size })
      return plan ?? hit?.plan ?? null
    } catch {
      profiles.set(authIndex, { at: now() - PROFILE_TTL_MS + 10 * 60_000, plan: hit?.plan ?? null, size: hit?.size ?? null })
      return hit?.plan ?? null
    }
  }

  /**
   * Whether to ask the vendor now. Never more than once a minute per login while
   * watched (ten idle), and a forced read at most every FORCE_FLOOR_MS; within
   * that, only when the passive reading is old or a window has reset since the
   * last reading.
   */
  function wantsActive(cred, passiveAt, { watched, force }) {
    if (cred.disabled) return false
    const prev = active.get(String(cred.auth_index))
    if (!prev) return true
    const since = now() - prev.triedAt
    if (force) return since >= FORCE_FLOOR_MS
    if (since < (watched ? ACTIVE_MIN_WATCHED_MS : ACTIVE_MIN_IDLE_MS)) return false
    const passiveAge = passiveAt ? now() - passiveAt : Infinity
    const reset = (prev.meters || []).some((m) => m.resetsAt && m.resetsAt <= now())
    return passiveAge > PASSIVE_FRESH_MS || reset
  }

  async function readOne(cred, listedAt, { watched, force }) {
    const provider = str(cred.provider) || str(cred.type)
    const name = str(cred.name) || str(cred.id)
    const authIndex = String(cred.auth_index ?? '')
    const email = str(cred.email) || str(cred.account) || str(cred.label) || null
    const signals = cred.quota?.signals
    const passiveAt = observedAt(cred.quota)
    const status = classifyStatus(cred, listedAt)
    const held = holdUntil(cred, listedAt)

    if (authIndex && wantsActive(cred, passiveAt, { watched, force })) {
      // Marked tried before the call, so a Refresh during a poll does not send a second.
      const before = active.get(authIndex)
      active.set(authIndex, { meters: [], metersAt: null, ...before, triedAt: now() })
      try {
        const fingerprint = client.fingerprint()
        const reading = await fetchActiveQuota(client, { provider, authIndex, accountId: codexAccountId(cred) })
        active.set(authIndex, { ...reading, metersAt: now(), triedAt: now(), error: null })
        const windows = historyWindowsFromMeters(provider, reading.meters)
        const historyCooling = historyUnavailableFor?.fingerprint === fingerprint && now() - historyUnavailableFor.at < 10 * 60_000
        if (fingerprint === client.fingerprint() && !historyCooling && Object.keys(windows).length) {
          await client.request('POST', '/quota/history', {
            json: { auth_index: authIndex, provider, windows }, timeoutMs: 3000,
          }).catch((err) => {
            if (err.status === 404 || err.code === 'scope_refused') historyUnavailableFor = { fingerprint, at: now() }
          })
        }
      } catch (err) {
        // Keep the old meters at their own time, so a newer passive reading still wins.
        const prev = active.get(authIndex)
        active.set(authIndex, { meters: [], metersAt: null, ...prev, triedAt: now(), error: client.scrub(err.message) })
      }
    }
    const reading = active.get(authIndex)
    let meters = reading?.meters?.length ? reading.meters : []
    let fetchedAt = reading?.meters?.length ? reading.metersAt : null
    let passive = false
    // The passive headers win for the windows they carry when they are newer.
    const fromSignals = refill(metersFromSignals(provider, signals), now())
    if (fromSignals.length && (!fetchedAt || (passiveAt && passiveAt > fetchedAt))) {
      const byKey = new Map(meters.map((m) => [m.key, m]))
      for (const m of fromSignals) byKey.set(m.key, m)
      meters = [...byKey.values()]
      fetchedAt = passiveAt
      passive = true
    } else {
      meters = refill(meters, now())
    }

    let plan = reading?.plan || planFromSignals(provider, signals) || null
    if (provider === 'codex' && !plan) plan = codexPlanLabel(cred.id_token?.plan_type)
    if (provider === 'claude' && authIndex && !cred.disabled) plan = (await profilePlan(authIndex)) || plan

    const authProblem = status.kind === 'auth'
    const readFailed = (!meters.length && reading?.error && status.kind !== 'limited') || status.kind === 'error'
    // Only a login that needs signing in again is an outage worth a notice; a spent
    // or cooling login is the proxy doing its job.
    if (authProblem) await record(`cliproxy:${email || name}`, false, Object.assign(new Error(status.reason), { status: 401 }))
    else await record(`cliproxy:${email || name}`, true)

    return {
      id: proxyAccountId(provider, name),
      backend: provider,
      label: name,
      source: 'cliproxy',
      displayName: str(cred.note).trim() || email || name,
      email,
      plan,
      planSize: provider === 'claude' ? profiles.get(authIndex)?.size ?? null : 1,
      status: readFailed && !authProblem ? 'error' : 'ok',
      error: authProblem || status.kind === 'error' ? status.reason : readFailed ? reading.error : null,
      statusReason: status.reason,
      authProblem,
      disabled: Boolean(cred.disabled),
      runtimeOnly: cred.runtime_only === true || cred.runtime_only === 'true',
      meters,
      passive,
      fetchedAt: fetchedAt || listedAt,
      activeError: reading?.error || null,
      cooldownUntil: held,
      resetCredits: provider === 'codex' && Number.isInteger(reading?.resetCredits) ? reading.resetCredits : null,
      priority: int(cred.priority),
      servingRecently: servingRecently(cred),
      detailUrl: provider === 'claude' ? 'https://claude.ai/settings/usage' : 'https://chatgpt.com/codex/settings/usage',
    }
  }

  /**
   * Read every Claude and Codex login. `force` is true (every login) or one
   * snapshot id, for an explicit refresh. Returns the account list, or the last
   * one marked stale when the proxy did not answer.
   */
  async function read({ watched = false, force = null } = {}) {
    status = { ...status, configured: client.configured(), url: client.baseUrl() }
    if (!status.configured) {
      lastAccounts = []
      backends = new Set()
      return { accounts: [], status, backends }
    }
    let list
    const listedAt = now()
    try {
      const body = await client.request('GET', '/credentials')
      list = Array.isArray(body?.files) ? body.files : []
      failures = 0
      status = { ...status, reachable: true, error: null, code: null, checkedAt: listedAt }
      await record('cliproxy', true)
    } catch (err) {
      failures += 1
      status = { ...status, reachable: false, error: err.message, code: err.code || null, checkedAt: listedAt }
      await record('cliproxy', false, err)
      if (failures === 1) log(`cliproxy: ${err.message}`)
      // A refused key will not come right by itself: stale at once.
      if (failures >= 2 || err.code === 'bad_key') {
        lastAccounts = lastAccounts.map((a) => (a.stale ? a : { ...a, stale: true, staleError: err.message, staleAt: listedAt }))
      }
      return { accounts: lastAccounts, status, backends }
    }
    const creds = list.filter((c) => PROXY_PROVIDERS.has(str(c.provider) || str(c.type)) && (str(c.name) || str(c.id)))
    const accounts = await Promise.all(creds.map((cred) => readOne(cred, listedAt, {
      watched,
      force: force === true || force === proxyAccountId(str(cred.provider) || str(cred.type), str(cred.name) || str(cred.id)),
    })))
    // Forget readings for logins that are gone.
    const live = new Set(creds.map((c) => String(c.auth_index ?? '')))
    for (const key of active.keys()) if (!live.has(key)) active.delete(key)
    for (const key of profiles.keys()) if (!live.has(key)) profiles.delete(key)
    lastAccounts = accounts
    backends = new Set(accounts.map((a) => a.backend))
    return { accounts, status, backends }
  }

  return {
    configured: () => client.configured(),
    read,
    status: () => status,
    backends: () => backends,
  }
}

