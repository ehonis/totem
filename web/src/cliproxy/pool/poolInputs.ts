import type { ProxyAccount, ProxyHistorySample } from '../api'
import { FIVE_HOUR_MS, WEEK_MS, type PoolAccountInput } from './poolModel'
import { isFableMeter, isScopedMeter, type UsageMeter } from '../../usagePools'

export const POOL_PROVIDERS = ['claude', 'codex'] as const
export type PoolProvider = (typeof POOL_PROVIDERS)[number]
/** `fable` is Claude's model-scoped weekly cap on Fable, drawn as a second line. */
export type PooledLimit = 'weekly' | 'five-hour' | 'fable'

function liveWindow(provider: PoolProvider, meters: UsageMeter[], limit: PooledLimit) {
  if (limit === 'fable') return provider === 'claude' ? meters.find(isFableMeter) : undefined
  if (provider === 'claude')
    return meters.find((m) => m.key === (limit === 'weekly' ? 'weekly_all:' : 'session:'))
  return meters
    .filter((m) => !isScopedMeter(m))
    .find((m) => {
      if (m.windowMinutes != null)
        return limit === 'weekly' ? m.windowMinutes >= 10080 : m.windowMinutes > 0 && m.windowMinutes < 10080
      return m.key === (limit === 'weekly' ? 'secondary' : 'primary')
    })
}

function recordedWindow(provider: PoolProvider, sample: ProxyHistorySample, limit: PooledLimit) {
  if (limit === 'fable') return provider === 'claude' ? sample.windows.seven_day_fable : undefined
  if (provider === 'claude') return sample.windows[limit === 'weekly' ? 'seven_day' : 'five_hour']
  const candidates = limit === 'weekly' ? ['secondary', 'primary', 'weekly'] : ['primary', 'secondary']
  return candidates
    .map((key) => sample.windows[key])
    .find(
      (w) =>
        w &&
        (w.windowMinutes == null ||
          (limit === 'weekly' ? w.windowMinutes >= 10080 : w.windowMinutes > 0 && w.windowMinutes < 10080)),
    )
}

/**
 * A Claude plan's share of the pool, by what it costs rather than by Anthropic's
 * "Nx" label: Pro $20 = 1, Max 5x $100 = 5, Max 20x $200 = 10. The model then
 * scales the most expensive plan to 100%, so Max 20x plus a Max 5x seat is a
 * 150% pool, not 125%. An unknown multiplier keeps its own value.
 */
const CLAUDE_PRICE_WEIGHT: Record<number, number> = { 1: 1, 5: 5, 20: 10 }
export function claudePlanWeight(multiple: number): number {
  return CLAUDE_PRICE_WEIGHT[multiple] ?? multiple
}

export function poolInputsFor(
  provider: PoolProvider,
  accounts: ProxyAccount[],
  history: ProxyHistorySample[],
  limit: PooledLimit,
): PoolAccountInput[] {
  const byId = new Map<string, ProxyHistorySample[]>()
  for (const sample of history) {
    if (sample.provider !== provider) continue
    const rows = byId.get(sample.accountId) || []
    rows.push(sample)
    byId.set(sample.accountId, rows)
  }
  return accounts
    .filter((a) => a.source === 'cliproxy' && a.backend === provider && !a.disabled)
    .map((a) => {
      const live = liveWindow(provider, a.meters || [], limit)
      const remaining =
        live?.beforeRefill?.remainingPct ??
        live?.remainingPct ??
        (live?.usedPct == null ? null : 100 - live.usedPct)
      const multiple = /(?:max\s*|max_)(\d+)x/i.exec(a.plan || '')
      return {
        key: a.id,
        label: a.displayName || a.email || a.label,
        remaining,
        resetAtMs: live?.beforeRefill?.resetsAt ?? live?.resetsAt ?? null,
        periodMs: live?.windowMinutes
          ? live.windowMinutes * 60_000
          : limit !== 'five-hour'
            ? WEEK_MS
            : FIVE_HOUR_MS,
        size: provider === 'claude' ? claudePlanWeight(a.planSize || (multiple ? Number(multiple[1]) : 1)) : 1,
        observedAtMs: live ? a.fetchedAt : null,
        samples: (byId.get(a.id) || []).flatMap((sample) => {
          const window = recordedWindow(provider, sample, limit)
          return window ? [{ t: sample.t, remaining: 100 - window.used, resetAtMs: window.resetAtMs }] : []
        }),
      }
    })
}
