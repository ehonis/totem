// Away spans (trips, days off) as the dashboard sees them: inclusive "YYYY-MM-DD" day
// keys from /api/away (away/http.mjs). Pure; ported verbatim from web/src/away.ts.
//
// Calendar grids here are built from local Date objects, so a day is matched by its
// local key, never by slicing an ISO string: `toISOString()` is UTC and names the
// wrong day for half the evening west of Greenwich.

export type AwayKind = 'trip' | 'off' | 'other'

export interface AwaySpan {
  id: string
  start: string
  end: string
  label: string
  kind: AwayKind
  note?: string
  source?: string
}

export const AWAY_KINDS: { id: AwayKind; label: string }[] = [
  { id: 'trip', label: 'Trip' },
  { id: 'off', label: 'Day off' },
  { id: 'other', label: 'Away' },
]

const pad = (n: number) => String(n).padStart(2, '0')

/** A local Date's own calendar day. */
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const keyDate = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d) }

export function addDayKeys(key: string, n: number): string {
  const d = keyDate(key)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}

/** The span covering a day, or null. */
export const awayOn = (spans: AwaySpan[], key: string): AwaySpan | null =>
  spans.find((s) => s.start <= key && key <= s.end) || null

/** Today's span first, then those starting within `horizonDays`, soonest first. */
export function upcomingAway(spans: AwaySpan[], today: string, horizonDays = 30): AwaySpan[] {
  const until = addDayKeys(today, horizonDays)
  return spans.filter((s) => s.end >= today && s.start <= until).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

/** Days from `from` to `to`; 0 when they are the same day. */
export const daysBetween = (from: string, to: string) => Math.round((keyDate(to).getTime() - keyDate(from).getTime()) / 86_400_000)

const short = (key: string, withYear = false) =>
  keyDate(key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) })

/** "Mon, Nov 2 – Thu, Nov 5", or one day on its own. */
export function awayRange(span: Pick<AwaySpan, 'start' | 'end'>, today?: string): string {
  const withYear = today ? span.end.slice(0, 4) !== today.slice(0, 4) : false
  return span.start === span.end ? short(span.start, withYear) : `${short(span.start, withYear)} – ${short(span.end, withYear)}`
}

/** One line for a band: where the owner is now, or when the next span starts. */
export function awayStatus(span: AwaySpan, today: string): string {
  if (span.start <= today) {
    const left = daysBetween(today, span.end)
    return left === 0 ? 'last day' : `until ${short(span.end)}`
  }
  const inDays = daysBetween(today, span.start)
  return `${inDays === 1 ? 'tomorrow' : `in ${inDays} days`} · ${awayRange(span, today)}`
}

/** The away days in [from, to), as local Dates: for lists that show a day only when it has something. */
export function awayDaysIn(spans: AwaySpan[], from: Date, to: Date): Date[] {
  const out: Date[] = []
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d < to; d.setDate(d.getDate() + 1)) {
    if (awayOn(spans, dayKey(d))) out.push(new Date(d))
  }
  return out
}
