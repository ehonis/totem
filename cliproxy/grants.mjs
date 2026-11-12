// cliproxy/grants.mjs — Claude reset grants and Codex reset credits, read strictly.
//
// Both spend something scarce at the vendor in the owner's name, so the parsers
// refuse anything they do not fully understand rather than guess, and a claim
// whose outcome is unknown is retried only with the same request id.
// Ported from the CLIProxy management dashboard (claudeResetGrants.ts, resetCredits.ts).

export const RESET_GRANT_STATUS_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
export const claimUrl = (org) => `https://api.anthropic.com/api/organizations/${org}/reset_rate_limits`
export const CODEX_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
export const CODEX_CREDITS_CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'

export const GRANT_ID_RE = /^[a-z0-9_-]{1,40}$/
export const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WINDOWS = ['five_hour', 'seven_day', 'seven_day_overage_included']
export const CLAIM_RESULTS = ['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable']
const INELIGIBLE = new Set(['config_off', 'tier', 'seat', 'mobile', 'surface', 'cli_version', 'no_grant', 'tenure', 'other_experiment', 'unavailable', 'unknown'])

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0
function optTime(v) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return undefined
  return v
}
function optBool(v, fallback) {
  if (v === undefined || v === null) return fallback
  return typeof v === 'boolean' ? v : undefined
}
const label = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '')

function parseGrant(v) {
  if (!isRecord(v)) return null
  if (typeof v.id !== 'string' || !GRANT_ID_RE.test(v.id)) return null
  if (!isCount(v.resets_total) || !isCount(v.resets_left) || v.resets_left > v.resets_total) return null
  const startsAt = optTime(v.starts_at)
  const endsAt = optTime(v.ends_at)
  const clears = v.clears === undefined || v.clears === null ? [] : Array.isArray(v.clears) ? WINDOWS.filter((w) => v.clears.includes(w)) : undefined
  // A grant that does not say it is usable is not offered.
  const paused = optBool(v.paused, false)
  const usableNow = optBool(v.usable_now, false)
  const useRequiresLimit = optBool(v.use_requires_limit, true)
  if ([startsAt, endsAt, clears, paused, usableNow, useRequiresLimit].includes(undefined)) return null
  return { id: v.id, label: label(v.label), resetsTotal: v.resets_total, resetsLeft: v.resets_left, startsAt, endsAt, clears, paused, usableNow, useRequiresLimit }
}

/** The `cedar_ember` block, or null when it is missing or anything in it is malformed. */
export function parseGrantStatus(block) {
  if (!isRecord(block) || typeof block.eligible !== 'boolean') return null
  const raw = block.grants ?? []
  if (!Array.isArray(raw)) return null
  const grants = []
  const seen = new Set()
  for (const g of raw) {
    const grant = parseGrant(g)
    if (!grant || seen.has(grant.id)) return null
    seen.add(grant.id)
    grants.push(grant)
  }
  const reason = block.ineligible_reason
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return null
  const atLimit = optBool(block.at_limit, false)
  const weeklyResetsAt = optTime(block.weekly_resets_at)
  const cooldownUntil = optTime(block.cooldown_until)
  if ([atLimit, weeklyResetsAt, cooldownUntil].includes(undefined)) return null
  return {
    eligible: block.eligible,
    ineligibleReason: typeof reason === 'string' ? (INELIGIBLE.has(reason) ? reason : 'unknown') : null,
    atLimit,
    grants,
    nextGrantId: typeof block.next_grant_id === 'string' && seen.has(block.next_grant_id) ? block.next_grant_id : null,
    weeklyResetsAt,
    cooldownUntil,
  }
}

/** Why a grant cannot be spent now, or null when it can. */
export function grantBlocker(status, grantId, now = Date.now()) {
  if (!status.eligible) return 'ineligible'
  const grant = status.grants.find((g) => g.id === grantId)
  if (!grant) return 'unknown_grant'
  if (grant.paused) return 'paused'
  if (!grant.usableNow) return 'not_usable'
  if (grant.resetsLeft <= 0) return 'exhausted'
  if (grant.useRequiresLimit && !status.atLimit) return 'not_limited'
  if (grant.startsAt && Date.parse(grant.startsAt) > now) return 'not_started'
  if (grant.endsAt && Date.parse(grant.endsAt) <= now) return 'expired'
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return 'cooldown'
  return null
}

/** The grant to offer: the vendor's pick when usable, else the lowest usable id. */
export function pickGrant(status, now = Date.now()) {
  if (status.nextGrantId && !grantBlocker(status, status.nextGrantId, now)) return status.nextGrantId
  return status.grants.map((g) => g.id).sort().find((id) => !grantBlocker(status, id, now)) ?? null
}

/** Codex's reset-credit list → the credits that can be spent now. */
export function parseCodexCredits(body, now = Date.now()) {
  if (!isRecord(body)) return null
  const credits = (Array.isArray(body.credits) ? body.credits : [])
    .filter((c) => isRecord(c) && c.reset_type === 'codex_rate_limits' && c.status === 'available' && typeof c.expires_at === 'string' && Date.parse(c.expires_at) > now)
    .map((c) => ({ id: typeof c.id === 'string' ? c.id.slice(0, 80) : null, expiresAt: c.expires_at, grantedAt: optTime(c.granted_at) ?? null }))
  return { available: credits.length, credits }
}
