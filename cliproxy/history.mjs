import { proxyAccountId } from './source.mjs'

const WINDOWS = { claude: ['five_hour', 'seven_day', 'seven_day_fable'], codex: ['primary', 'secondary', 'weekly'] }
// The proxy names a passive window after its rate-limit header: Fable's weekly cap
// arrives as `anthropic-ratelimit-unified-7d_oi-*`, so `seven_day_oi`. Checked
// against the active `weekly_scoped` Fable reading (same percent, same reset).
// Active readings (Totem's, and the Management Center's) record `seven_day_fable`.
const ALIASES = { claude: { seven_day_fable: ['seven_day_oi'] } }
const isFable = (m) => /^weekly_scoped:fable\b/i.test(String(m?.key || ''))
const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const positive = (v) => finite(v) && v > 0 ? v : null
const used = (v) => finite(v) ? Math.max(0, Math.min(100, v)) : null

export function normalizeHistory(body, files, now = Date.now()) {
  const accounts = new Map(files.filter((c) => WINDOWS[c.provider || c.type])
    .map((c) => [String(c.auth_index), c]))
  const samples = []
  for (const sample of Array.isArray(body?.samples) ? body.samples : []) {
    if (!sample || !finite(sample.t) || sample.t > now || sample.t < now - 21 * 86400_000) continue
    const cred = accounts.get(String(sample.auth_index))
    if (!cred || sample.provider !== (cred.provider || cred.type)) continue
    const windows = {}
    for (const id of WINDOWS[sample.provider]) {
      const raw = [id, ...(ALIASES[sample.provider]?.[id] || [])].map((k) => sample.windows?.[k]).find((w) => used(w?.used) !== null)
      const value = used(raw?.used)
      if (value === null) continue
      windows[id] = { used: value, resetAtMs: positive(raw.reset_at), windowMinutes: positive(raw.window_minutes) }
    }
    if (!Object.keys(windows).length) continue
    samples.push({
      t: sample.t,
      accountId: proxyAccountId(sample.provider, cred.name || cred.id),
      provider: sample.provider,
      source: sample.source === 'active' ? 'active' : 'passive',
      windows,
    })
  }
  return { supported: true, samples: samples.sort((a, b) => a.t - b.t) }
}

export function historyWindowsFromMeters(provider, meters) {
  const ids = provider === 'claude' ? { 'session:': 'five_hour', 'weekly_all:': 'seven_day' }
    : provider === 'codex' ? { primary: 'primary', secondary: 'secondary' } : {}
  const windows = {}
  for (const m of meters) {
    const id = ids[m.key] || (provider === 'claude' && isFable(m) ? 'seven_day_fable' : null)
    const value = used(m.usedPct)
    if (!id || value === null) continue
    windows[id] = {
      used: value,
      ...(positive(m.resetsAt) ? { reset_at: m.resetsAt } : {}),
      ...(positive(m.windowMinutes) ? { window_minutes: m.windowMinutes } : {}),
    }
  }
  return windows
}
