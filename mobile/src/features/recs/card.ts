// Words and numbers for the Recs page (#181). Pure, so `node --test` runs it.
import type { Rec, RecStats } from '../../lib/recs/types'

const usd = (value: number) =>
  `$${Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** "$40 · act by 2026-11-10 · back from deferral": what a card says under its title. */
export function recMeta(rec: Rec): string {
  return [
    rec.costUsd ? usd(rec.costUsd) : null,
    rec.actBy ? `act by ${rec.actBy}` : null,
    rec.decision === 'deferred' && rec.reviewOn ? `back ${rec.reviewOn}` : null,
    rec.decision === 'pending' && rec.resurfacedAt ? 'back from deferral' : null,
  ].filter(Boolean).join(' · ')
}

/** What the toast says once a decision is saved; the rec is the bridge's copy. */
export function decisionToast(rec: Pick<Rec, 'decision' | 'reviewOn'>): string {
  switch (rec.decision) {
    case 'accepted': return 'Accepted.'
    case 'declined': return 'Declined. Agents won’t suggest it again for 30 days.'
    case 'deferred': return rec.reviewOn ? `Deferred. It comes back on ${rec.reviewOn}.` : 'Deferred.'
    default: return 'Back to waiting on you.'
  }
}

/** "today", "yesterday", "3 days ago", then the date. For decided rows. */
export function whenLabel(iso: string | null, now = new Date()): string {
  if (!iso) return ''
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const days = Math.round((day(now) - day(then)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return then.toLocaleDateString([], { month: 'short', day: 'numeric', ...(then.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

export interface StatTile { label: string; value: string }

const pct = (r: number | null) => (r === null || !Number.isFinite(r) ? '–' : `${Math.round(r * 100)}%`)

/** The track record as three numbers: what waits, how often you say yes, how often it works. */
export function statTiles(stats: RecStats): StatTile[] {
  return [
    { label: 'Waiting', value: String(stats.pending) },
    { label: 'Accepted', value: pct(stats.acceptRate) },
    { label: 'Worked', value: pct(stats.hitRate) },
  ]
}
