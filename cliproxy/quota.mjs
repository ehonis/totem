// cliproxy/quota.mjs — one proxy login's quota, as the meters ai-usage draws.
//
// Two sources, freshest first:
//   active   an upstream usage read made with the login's own token through the
//            proxy (`/requests/api-call`): Claude's /api/oauth/usage, Codex's
//            /backend-api/wham/usage. Every window the vendor reports, plus plan.
//   passive  the rate-limit headers of the last real request through the proxy,
//            which it keeps on each credential (`quota.signals`). Free to read, but
//            only as fresh as the last request and only the 5-hour and weekly windows.
import { meter, windowLabel, toEpochMs } from '../ai-usage/util.mjs'
import { metersFromPayload as claudeMeters } from '../ai-usage/providers/claude.mjs'

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

export const CLAUDE_HEADERS = Object.freeze({
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'claude-cli/2.1.280 (external, cli)',
  'anthropic-beta': 'oauth-2025-04-20',
})

export const CODEX_HEADERS = Object.freeze({
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
})

/** Codex headers for one login; its ChatGPT workspace picks the Team seat over the personal one. */
export function codexHeaders(accountId, extra = {}) {
  const header = { ...CODEX_HEADERS, ...extra }
  if (typeof accountId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(accountId)) header['Chatgpt-Account-Id'] = accountId
  return header
}

/** The ChatGPT account id the proxy lists for a Codex login, if any. */
export const codexAccountId = (cred) => cred?.id_token?.chatgpt_account_id || cred?.chatgpt_account_id || null

// Claude's flat usage fields (when `limits[]` is absent) under the keys the
// passive headers and `limits[]` use, so one window is never two meters.
const CLAUDE_KEY = { five_hour: 'session:', seven_day: 'weekly_all:' }

const num = (value) => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const CODEX_PLANS = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' }
export const codexPlanLabel = (plan) => (plan ? CODEX_PLANS[String(plan).toLowerCase()] || String(plan) : null)

/** Codex's wham/usage body → meters (primary = the burst window, secondary = weekly). */
export function metersFromWham(body) {
  const rl = body?.rate_limit
  const meters = []
  for (const [key, window] of [['primary', rl?.primary_window], ['secondary', rl?.secondary_window]]) {
    const used = num(window?.used_percent)
    if (used === null) continue
    const minutes = num(window?.limit_window_seconds) !== null ? Math.round(num(window.limit_window_seconds) / 60) : null
    meters.push(meter(key, windowLabel(minutes), used, num(window?.reset_at) !== null ? num(window.reset_at) * 1000 : null, { windowMinutes: minutes }))
  }
  return meters
}

/** Header names are case-insensitive; the proxy keeps them in canonical case. */
function signalReader(signals) {
  const map = new Map()
  for (const [k, v] of Object.entries(signals || {})) map.set(k.toLowerCase(), v)
  return (name) => map.get(name.toLowerCase())
}

/**
 * The last request's rate-limit headers → meters. Claude reports utilization as
 * 0..1 and a status (rejected = at the limit); Codex reports percents.
 */
export function metersFromSignals(provider, signals) {
  const get = signalReader(signals)
  const meters = []
  if (provider === 'claude') {
    for (const [tag, key, label, minutes] of [['5h', 'session:', '5-hour limit', 300], ['7d', 'weekly_all:', '7-day limit', 10080]]) {
      const util = num(get(`anthropic-ratelimit-unified-${tag}-utilization`))
      if (util === null) continue
      const status = String(get(`anthropic-ratelimit-unified-${tag}-status`) || '')
      const used = status === 'rejected' ? 100 : util * 100
      const reset = num(get(`anthropic-ratelimit-unified-${tag}-reset`))
      meters.push(meter(key, label, used, reset !== null ? reset * 1000 : null, { windowMinutes: minutes, passive: true }))
    }
  } else if (provider === 'codex') {
    for (const [tag, key] of [['primary', 'primary'], ['secondary', 'secondary']]) {
      const used = num(get(`x-codex-${tag}-used-percent`))
      if (used === null) continue
      const minutes = num(get(`x-codex-${tag}-window-minutes`))
      const reset = num(get(`x-codex-${tag}-reset-at`))
      meters.push(meter(key, windowLabel(minutes), used, reset !== null ? reset * 1000 : null, { windowMinutes: minutes, passive: true }))
    }
  }
  return meters
}

export function planFromSignals(provider, signals) {
  if (provider !== 'codex') return null
  return codexPlanLabel(signalReader(signals)('x-codex-plan-type'))
}

/**
 * Read one login's quota through the proxy. Throws on a transport failure or a
 * non-2xx upstream answer; the caller falls back to the passive signals.
 */
export async function fetchActiveQuota(client, { provider, authIndex, accountId = null }) {
  if (provider === 'claude') {
    const { statusCode, body } = await client.upstream(authIndex, { url: CLAUDE_USAGE_URL, header: { ...CLAUDE_HEADERS } })
    if (statusCode < 200 || statusCode >= 300 || !body || typeof body !== 'object') throw upstreamError('Claude usage', statusCode, body, client)
    return { meters: claudeMeters(body).map((m) => (CLAUDE_KEY[m.key] ? { ...m, key: CLAUDE_KEY[m.key] } : m)), plan: null }
  }
  if (provider === 'codex') {
    const { statusCode, body } = await client.upstream(authIndex, { url: CODEX_USAGE_URL, header: codexHeaders(accountId) })
    if (statusCode < 200 || statusCode >= 300 || !body || typeof body !== 'object') throw upstreamError('Codex usage', statusCode, body, client)
    const count = num(body?.rate_limit_reset_credits?.available_count)
    return {
      meters: metersFromWham(body),
      plan: codexPlanLabel(body.plan_type),
      limitReached: body?.rate_limit?.limit_reached === true,
      resetCredits: count,
    }
  }
  throw new Error(`no quota reader for ${provider}`)
}

function upstreamError(what, statusCode, body, client) {
  const detail = body && typeof body === 'object' ? (body.error?.message || body.error || body.message || '') : String(body || '')
  const text = client.scrub(typeof detail === 'string' ? detail : JSON.stringify(detail))
  return Object.assign(new Error(`${what} answered ${statusCode || 'nothing'}${text ? `: ${text}` : ''}`), { upstreamStatus: statusCode })
}

export const observedAt = (quota) => toEpochMs(quota?.observed_at)
