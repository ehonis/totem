/**
 * The usage snapshot grouped by provider, for every limits surface (the rail and
 * chat-header pills, the utilities launcher's limits panel).
 *
 * The bridge computes each account's `state` and `headroomPct` and each
 * provider's pool (ai-usage/pools.mjs); this file only groups and words them. A
 * pool's number is its best usable account's headroom, because that is what the
 * next request gets: with CLIProxy the proxy routes around a spent login.
 */

export type AccountState = 'ok' | 'low' | 'limited' | 'error' | 'disabled'

export interface UsageMeter {
  key?: string
  label: string
  usedPct?: number | null
  remainingPct?: number | null
  resetsAt?: number | null
  windowMinutes?: number | null
  passive?: boolean
  beforeRefill?: { remainingPct: number; resetsAt: number }
}

export interface UsageAccount {
  id: string
  backend: string
  label: string
  displayName?: string
  email?: string | null
  plan?: string | null
  planSize?: number | null
  status?: string
  error?: string | null
  source?: string
  state?: AccountState
  headroomPct?: number | null
  limitedUntil?: number | null
  meters?: UsageMeter[]
  fetchedAt?: number
  stale?: boolean
  staleAt?: number
  hidden?: boolean
  disabled?: boolean
  authProblem?: boolean
  statusReason?: string | null
  servingRecently?: boolean
  modelCooldowns?: { model: string | null; until: number }[]
  resetCredits?: number | null
}

export interface UsagePool {
  backend: string
  total: number
  usable: number
  bestId: string | null
  headroomPct: number | null
  nextBackAt: number | null
  limited: number
  errors: number
  disabled: number
  proxied?: boolean
}

export interface ProviderGroup {
  backend: string
  name: string
  pool: UsagePool
  accounts: UsageAccount[]
}

const ORDER: Record<string, number> = { claude: 0, codex: 1, cursor: 2 }
const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }

/** Model-scoped windows only badge an account; the main ones decide its headroom. */
export const isScopedMeter = (m: UsageMeter) =>
  /^(weekly_scoped|seven_day_(opus|sonnet|oauth_apps|cowork)|extra_usage)/.test(String(m.key || ''))

/** Claude's weekly cap on Fable: model-scoped, so it never decides headroom, but it is its own tier. */
export const isFableMeter = (m: UsageMeter) => /^weekly_scoped:fable\b/i.test(String(m.key || ''))

function fallbackState(a: UsageAccount): UsageAccount {
  if (a.state) return a
  const main = (a.meters || []).filter((m) => typeof m.remainingPct === 'number' && !isScopedMeter(m))
  const headroomPct = main.length ? Math.min(...main.map((m) => m.remainingPct as number)) : null
  const state: AccountState = a.status && a.status !== 'ok' && !a.stale ? 'error'
    : headroomPct !== null && headroomPct <= 1 ? 'limited'
      : headroomPct !== null && headroomPct < 25 ? 'low' : 'ok'
  return { ...a, headroomPct, state }
}

function fallbackPool(backend: string, accounts: UsageAccount[]): UsagePool {
  const live = accounts.filter((a) => a.state === 'ok' || a.state === 'low')
  const best = live.reduce<UsageAccount | null>((top, a) => (a.headroomPct != null && (!top || a.headroomPct > (top.headroomPct ?? -1)) ? a : top), null)
  return {
    backend,
    total: accounts.length,
    usable: live.length,
    bestId: best?.id ?? null,
    headroomPct: best?.headroomPct ?? null,
    nextBackAt: null,
    limited: accounts.filter((a) => a.state === 'limited').length,
    errors: accounts.filter((a) => a.state === 'error').length,
    disabled: accounts.filter((a) => a.state === 'disabled').length,
  }
}

/**
 * Providers with at least one account worth showing. An account that could not
 * be read still shows (as `error`): a login that died is exactly what the owner
 * needs to see, and dropping it would make "2 accounts, one dead" read as one.
 */
export function providerGroups(snapshot: any, { all = false }: { all?: boolean } = {}): ProviderGroup[] {
  const accounts: UsageAccount[] = (snapshot?.accounts || [])
    .filter((a: UsageAccount) => !a.hidden)
    .map(fallbackState)
  const pools: UsagePool[] = snapshot?.pools || []
  const providers: Record<string, string> = snapshot?.providers || {}
  const byBackend = new Map<string, UsageAccount[]>()
  for (const a of accounts) {
    if (!byBackend.has(a.backend)) byBackend.set(a.backend, [])
    byBackend.get(a.backend)!.push(a)
  }
  return [...byBackend.entries()]
    .map(([backend, list]) => ({
      backend,
      name: providers[backend] || NAMES[backend] || backend,
      pool: pools.find((p) => p.backend === backend) || fallbackPool(backend, list),
      accounts: list,
    }))
    // In the pills, a provider whose accounts have never been read says nothing
    // useful; the CLIProxy tab lists every login (`all`), so each can be managed.
    .filter((g) => all || g.accounts.some((a) => (a.meters || []).length || a.state === 'error' || a.state === 'disabled' || a.state === 'limited'))
    .sort((a, b) => (ORDER[a.backend] ?? 9) - (ORDER[b.backend] ?? 9))
}

/** Lower is worse: nothing usable sorts below any headroom. */
export const poolScore = (g: ProviderGroup) => (g.pool.usable === 0 ? -1 : g.pool.headroomPct ?? 100)

export const toneOf = (g: ProviderGroup) => {
  if (g.pool.usable === 0) return 'crit'
  const left = g.pool.headroomPct ?? 100
  return left < 10 ? 'crit' : left < 25 ? 'low' : ''
}

export const accountTone = (a: UsageAccount) =>
  a.state === 'limited' || a.state === 'error' ? 'crit' : a.state === 'low' ? 'low' : a.state === 'disabled' ? 'off' : ''

/** "5h", "wk", "mo" for a window, from its length. */
export function shortWindow(m: UsageMeter) {
  const mins = Number(m.windowMinutes)
  if (!Number.isFinite(mins) || mins <= 0) return m.label.replace(/ limit$/, '')
  if (mins <= 600) return `${Math.round(mins / 60)}h`
  if (mins <= 1440) return 'day'
  if (mins <= 10080) return 'wk'
  return 'mo'
}

/** The two main windows worth a mini bar: the shortest and the longest. */
export function mainMeters(a: UsageAccount): UsageMeter[] {
  const main = (a.meters || []).filter((m) => typeof m.remainingPct === 'number' && !isScopedMeter(m))
  if (main.length <= 2) return main
  const sorted = [...main].sort((x, y) => (Number(x.windowMinutes) || 0) - (Number(y.windowMinutes) || 0))
  return [sorted[0], sorted[sorted.length - 1]]
}

/** Claude's Fable tier, when the account reports one; shown beside the main windows. */
export function fableMeter(a: UsageAccount): UsageMeter | undefined {
  if (a.backend !== 'claude') return undefined
  return (a.meters || []).find((m) => typeof m.remainingPct === 'number' && isFableMeter(m))
}

/** "in 40m", "at 12:50 AM", "Mon 10 AM". */
export function whenLabel(ts?: number | null, now = Date.now()) {
  if (!ts) return ''
  const ms = ts - now
  if (ms <= 0) return 'now'
  if (ms < 90 * 60_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`
  const d = new Date(ts)
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined })
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay ? `at ${clock}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${clock}`
}

/** What an account's row says next to its name. */
export function stateLabel(a: UsageAccount, now = Date.now()) {
  switch (a.state) {
    case 'disabled': return 'Off'
    case 'error': return a.authProblem ? 'Sign in again' : 'Can’t read'
    case 'limited': return a.limitedUntil ? `Back ${whenLabel(a.limitedUntil, now)}` : 'Limited'
    default: return a.stale ? 'Stale' : a.servingRecently ? 'In use' : ''
  }
}

/** The pill's number, or the return time when nothing can serve. */
export function pillText(g: ProviderGroup, now = Date.now()) {
  if (g.accounts.length && g.accounts.every((a) => a.state === 'disabled')) return 'off'
  if (g.pool.usable === 0) {
    if (!g.pool.nextBackAt) return g.pool.errors ? '!' : '0%'
    const ms = g.pool.nextBackAt - now
    if (ms < 90 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
    if (ms < 48 * 3600_000) return `${Math.round(ms / 3600_000)}h`
    return `${Math.round(ms / 86400_000)}d`
  }
  return `${Math.round(g.pool.headroomPct ?? 0)}%`
}

/** One sentence for a pill's tooltip and aria-label. */
export function poolSentence(g: ProviderGroup, now = Date.now()) {
  const { pool } = g
  if (pool.total <= 1) {
    const a = g.accounts[0]
    if (!a) return g.name
    if (a.state === 'limited') return `${g.name}: limited, back ${whenLabel(a.limitedUntil, now)}`
    if (a.state === 'error') return `${g.name}: ${a.authProblem ? 'needs signing in again' : 'could not be read'}`
    return `${g.name}: ${Math.round(a.headroomPct ?? 0)}% left`
  }
  if (pool.usable === 0) return `${g.name}: none of ${pool.total} accounts can serve${pool.nextBackAt ? `, first back ${whenLabel(pool.nextBackAt, now)}` : ''}`
  const back = pool.nextBackAt ? `, next back ${whenLabel(pool.nextBackAt, now)}` : ''
  return `${g.name}: best account ${Math.round(pool.headroomPct ?? 0)}% left, ${pool.usable} of ${pool.total} usable${back}`
}

/** The panel column's subtitle. */
export function poolSubtitle(g: ProviderGroup, now = Date.now()) {
  const { pool } = g
  if (pool.total <= 1) return g.accounts[0]?.plan || ''
  const parts = [`${pool.usable} of ${pool.total} usable`]
  if (pool.nextBackAt) parts.push(`next back ${whenLabel(pool.nextBackAt, now)}`)
  return parts.join(' · ')
}

/** A short name: rename, note or email; an email loses its domain when that leaves it unique. */
export function shortName(a: UsageAccount, siblings: UsageAccount[]) {
  const name = a.displayName || a.email || a.label
  const at = name.indexOf('@')
  if (at <= 0 || name !== a.email) return name
  const local = name.slice(0, at)
  const clash = siblings.some((b) => b.id !== a.id && (b.displayName || b.email || b.label).split('@')[0] === local)
  return clash ? name : local
}
