// The Activity pane's small shared pieces (web LogsView.tsx): times, durations,
// and the one log entry the detail sheet is opened on.

export interface LogEntry {
  id: string
  ts: number
  iso: string
  action: string
  actor: string
  status: string
  channel?: string
  target?: string
  summary?: string
  why?: string
  detail?: string
  error?: string
  ms?: number
  correlationId?: string
}

// Entry times are the bridge's own clock, not the phone's: the log and the
// Totems page show the same runs, and two zones would place one run twice.
export function clockTime(iso: string, tz?: string): string {
  const d = new Date(iso)
  try {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz })
  } catch {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
}

export function agoText(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Minutes until a grant expires; negative once it has. */
export const minutesLeft = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 60000)

export function elapsed(ms: number): string {
  if (!ms || ms < 1000) return `${ms || 0}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function prettyDetail(detail?: string): string | null {
  if (!detail) return null
  try { return JSON.stringify(JSON.parse(detail), null, 2) } catch { return detail }
}

// A route param carries only strings, so the entry a row opens waits here for
// the sheet (the pane already holds it; refetching one entry has no endpoint).
const opened = new Map<string, LogEntry & { timezone?: string }>()
export function holdEntry(entry: LogEntry, timezone?: string) {
  opened.clear()
  opened.set(entry.id, { ...entry, timezone })
}
export const heldEntry = (id: string) => opened.get(id) || null
