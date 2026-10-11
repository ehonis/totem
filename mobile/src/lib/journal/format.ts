// Pure presentation helpers for the Journal view. No React, no fetch, so they run
// under the plain vitest suite.
import type { JournalEntry } from './types'

/** "0:07", "12:34", "1:02:03" — the recorder's clock and an entry's length. */
export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/** Milliseconds until an ISO deadline, floored at zero. */
export function msUntil(deadline: string, now: number): number {
  return Math.max(0, Date.parse(deadline) - now)
}

/**
 * The state a card should show, worked out from the entry and the clock. One
 * function so the chip, the buttons, and the poll cadence can't disagree.
 */
export type CardState =
  | 'transcribing' | 'transcribe-failed'
  | 'waiting' | 'due' | 'digesting' | 'digested' | 'skipped' | 'ingest-failed'

export function cardState(entry: JournalEntry, now: number): CardState {
  if (entry.status === 'transcribing') return 'transcribing'
  if (entry.status === 'failed') return 'transcribe-failed'
  switch (entry.ingest.state) {
    case 'running': return 'digesting'
    case 'done': return 'digested'
    case 'skipped': return 'skipped'
    case 'failed': return 'ingest-failed'
    default: return msUntil(entry.ingest.at, now) > 0 ? 'waiting' : 'due'
  }
}

/** Something on screen is changing on its own; poll accordingly. */
export function pollIntervalMs(entries: JournalEntry[], now: number): number {
  const states = entries.map((e) => cardState(e, now))
  if (states.some((s) => s === 'transcribing' || s === 'digesting' || s === 'due')) return 4_000
  if (states.some((s) => s === 'waiting')) return 20_000
  return 90_000
}

/** A card's headline: his title, else the agent's, else the opening words. */
export function entryTitle(entry: JournalEntry): string {
  if (entry.title) return entry.title
  const text = entry.transcript?.text?.trim()
  if (text) {
    const firstSentence = text.split(/(?<=[.!?])\s+/)[0] || text
    return firstSentence.length > 72 ? `${firstSentence.slice(0, 70).trimEnd()}…` : firstSentence
  }
  return entry.source === 'text' ? 'Typed entry' : 'Recording'
}

const DAY_MS = 86_400_000

const localISODate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** "Today", "Yesterday", or "Wednesday, September 10" for an entry's day. */
export function dayLabel(isoDate: string, today = new Date()): string {
  const todayKey = localISODate(today)
  if (isoDate === todayKey) return 'Today'
  const yesterday = localISODate(new Date(today.getTime() - DAY_MS))
  if (isoDate === yesterday) return 'Yesterday'
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const sameYear = y === today.getFullYear()
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

export interface DayGroup { date: string; label: string; entries: JournalEntry[] }

/** Newest day first, newest entry first within it — the Voice Memos order. */
export function groupByDay(entries: JournalEntry[], today = new Date()): DayGroup[] {
  const byDate = new Map<string, JournalEntry[]>()
  for (const e of entries) {
    const list = byDate.get(e.date) || []
    list.push(e)
    byDate.set(e.date, list)
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, list]) => ({
      date,
      label: dayLabel(date, today),
      entries: list.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
    }))
}

/** "1.8 MB" / "812 kB" — recording sizes, which is all this is used for. */
export function fmtBytes(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0)
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${Math.round(n / 1000)} kB`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`
}

/**
 * What the card says about the recording: whether it is still here, and for how
 * much longer. "Deleted" is a state worth naming rather than leaving blank — the
 * whole point of the retention window is knowing the audio is still recoverable.
 */
export function audioLabel(audio: JournalEntry['audio'], now = Date.now()): string {
  if (!audio) return ''
  if (!audio.kept) return 'audio deleted'
  if (audio.pinned) return 'audio kept'
  if (!audio.keepUntil) return 'audio'
  const days = Math.ceil((Date.parse(audio.keepUntil) - now) / 86_400_000)
  if (days <= 0) return 'audio expiring'
  return `audio ${days}d`
}

/** The same fact spelled out, for the title attribute and the menu. */
export function audioTitle(audio: JournalEntry['audio'], now = Date.now()): string {
  if (!audio) return 'This entry has no recording.'
  if (!audio.kept) return 'The recording has been deleted. The transcript is the record.'
  if (audio.pinned) return 'Kept indefinitely — no sweep will delete this recording.'
  if (!audio.keepUntil) return 'This recording is not being kept and goes on the next sweep.'
  const when = new Date(audio.keepUntil).toLocaleDateString([], { month: 'long', day: 'numeric' })
  const days = Math.ceil((Date.parse(audio.keepUntil) - now) / 86_400_000)
  return days <= 0 ? 'This recording is due to be deleted on the next sweep.' : `Recording kept until ${when} (${days} day${days === 1 ? '' : 's'}), then deleted.`
}

/** "7:12 AM" in the browser's locale. */
export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * The recorder's container format, in the order worth trying. Safari records
 * AAC-in-MP4 and knows nothing of WebM; Chrome and Firefox are the reverse.
 */
export const PREFERRED_MIME_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
]

export function pickMimeType(isSupported: (type: string) => boolean): string | undefined {
  return PREFERRED_MIME_TYPES.find((t) => { try { return isSupported(t) } catch { return false } })
}
