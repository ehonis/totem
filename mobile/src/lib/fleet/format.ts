// Numbers on the Fleet screens, ported from web/src/fleet/format.ts.

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(digits)} ${units[i]}`
}

export const rate = (bps: number | null | undefined) => `${bytes(bps ?? 0)}/s`

export function duration(sec: number | null | undefined): string {
  if (sec == null || sec < 0) return '–'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export const uptimeSince = (bootedAt: number | null) => (bootedAt ? duration((Date.now() - bootedAt) / 1000) : '–')

export function money(n: number | null | undefined): string {
  if (n == null) return '–'
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`
}

export const pct = (n: number | null | undefined, digits = 0) => (n == null ? '–' : `${n.toFixed(digits)}%`)
export const watts = (n: number | null | undefined) => (n == null ? '–' : `${n < 10 ? n.toFixed(1) : Math.round(n)} W`)

/** btop's colour ramp: calm until 60%, warm to 85%, hot past it. */
export const heat = (p: number) => (p >= 85 ? 'hot' : p >= 60 ? 'warm' : 'calm')

export const MEASURED_LABEL = {
  measured: 'Measured',
  partial: 'Partly measured',
  estimated: 'Estimated',
} as const
