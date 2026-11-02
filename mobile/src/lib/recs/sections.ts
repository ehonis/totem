// Ported from web/src/recs/sections.ts: how the Recommendations view groups the ledger,
// so the web and the app show the same sections in the same order.
import type { Rec, RecLedger, RecOutcome } from './types'

export interface RecSection {
  id: 'pending' | 'deferred' | 'decided' | 'outcomes'
  title: string
  recs: Rec[]
}

export const OUTCOME_LABELS: Record<RecOutcome, string> = { worked: 'Worked', partly: 'Partly', failed: "Didn't work" }

const newest = (a: string | null, b: string | null) => (b ?? '').localeCompare(a ?? '')

/** Waiting on you, then deferred (soonest back first), decided, and measured outcomes. */
export function recSections(recs: Rec[]): RecSection[] {
  const sections: RecSection[] = [
    { id: 'pending', title: 'Waiting on you', recs: recs.filter((r) => r.decision === 'pending').sort((a, b) => newest(a.createdAt, b.createdAt)) },
    { id: 'deferred', title: 'Deferred', recs: recs.filter((r) => r.decision === 'deferred').sort((a, b) => (a.reviewOn ?? '').localeCompare(b.reviewOn ?? '')) },
    { id: 'decided', title: 'Decided', recs: recs.filter((r) => (r.decision === 'accepted' && !r.outcome) || r.decision === 'declined').sort((a, b) => newest(a.decidedAt, b.decidedAt)) },
    { id: 'outcomes', title: 'Outcomes', recs: recs.filter((r) => r.decision === 'accepted' && r.outcome).sort((a, b) => newest(a.outcomeAt, b.outcomeAt)) },
  ]
  return sections.filter((s) => s.recs.length)
}

/** "chat:abc" → "Chat", "totem:coach" → "Totem coach", "owner" → "You". */
export function recSourceLabel(source: string): string {
  if (source === 'owner') return 'You'
  const [kind, ...rest] = source.split(':')
  const id = rest.join(':')
  if (kind === 'chat') return 'Chat'
  if (kind === 'totem') return id ? `Totem ${id}` : 'Totem'
  return source
}

/** The chat a source names: the chat itself, or the chat a totem posts its runs to. */
export function recSourceThread(source: string): string | null {
  const [kind, ...rest] = source.split(':')
  const id = rest.join(':')
  if (!id) return null
  if (kind === 'chat') return id
  if (kind === 'totem') return `totem-${id}`
  return null
}

/** Where a source links to on the dashboard, when it names a chat or a totem. */
export function recSourcePath(source: string): string | null {
  const thread = recSourceThread(source)
  return thread ? `/chat?thread=${encodeURIComponent(thread)}` : null
}

export function formatUsd(value: number): string {
  return `$${Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** How long a deferral lasts. Sent as days; the bridge turns them into a date. */
export const DEFER_CHOICES = [
  { days: 7, label: 'In a week' },
  { days: 14, label: 'In two weeks' },
  { days: 30, label: 'In a month' },
  { days: 90, label: 'In three months' },
]

/** "Worked", or "Worked (reported by an agent)". */
export function outcomeLabel(rec: Rec): string {
  if (!rec.outcome) return ''
  return rec.outcomeBy === 'agent' ? `${OUTCOME_LABELS[rec.outcome]} (reported by an agent)` : OUTCOME_LABELS[rec.outcome]
}

/**
 * The ledger after a change, keeping every page of history already loaded. `first` is
 * a fresh first page (open recs and stats move with any change); `changed` is the rec
 * the change returned, which may sit beyond the first page. Recs now open leave the
 * history; the rest is in the bridge's order, newest decision first. The cursor marks a
 * position, not a row, so the deepest one loaded stays valid.
 */
export function mergeLedger(
  prev: { history: Rec[]; nextBefore: string | null },
  first: RecLedger,
  changed?: Rec | null,
): { open: Rec[]; history: Rec[]; nextBefore: string | null } {
  const open = new Set(first.open.map((r) => r.id))
  const byId = new Map(prev.history.map((r) => [r.id, r]))
  if (changed) byId.set(changed.id, changed)
  for (const r of first.history) byId.set(r.id, r)
  const history = [...byId.values()]
    .filter((r) => !open.has(r.id) && (r.decision === 'accepted' || r.decision === 'declined'))
    .sort((a, b) => (a.decidedAt === b.decidedAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.decidedAt ?? '') < (b.decidedAt ?? '') ? 1 : -1))
  const deeper = prev.history.length > first.history.length
  return { open: first.open, history, nextBefore: deeper ? prev.nextBefore : first.nextBefore }
}
