import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { getCalendarRange, updateCalendarEvent, AuthError } from '../api'
import { Hi, XMarkIcon, WarnIcon } from '../icons'
import { useErrorToast } from '../toast'

// Loosely-shaped bridge JSON.
type CalEvent = any

// ---------- date helpers ----------
const DAY_MS = 86_400_000
const WEEK_START = 0 // 0 = Sunday (matches Google/Outlook default)
const HOUR_PX = 44   // height of one hour row in time-grid views

// Google returns all-day events as a date-only string ("YYYY-MM-DD"). new Date()
// would read that as UTC midnight, which shifts to the previous day in negative-UTC
// timezones. Parse date-only values as a LOCAL date so they land on the right day.
const parseDate = (s: string | number | Date): Date => {
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(s)
}

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x }
const startOfWeek = (d: Date, ws = WEEK_START) => {
  const x = startOfDay(d)
  x.setDate(x.getDate() - ((x.getDay() - ws + 7) % 7))
  return x
}
const startOfMonth = (d: Date) => { const x = startOfDay(d); x.setDate(1); return x }
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const isToday = (d: Date) => sameDay(d, new Date())
const minsOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes()

const VIEWS = [
  { id: 'day', label: 'Day' },
  { id: 'workweek', label: 'Work Week' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'agenda', label: 'Agenda' },
]

const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const pad2 = (n: number) => String(n).padStart(2, '0')
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const toDateTimeInput = (d: Date) => `${toDateInput(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
const allDayEndForInput = (value?: string) => {
  if (!value) return ''
  const d = parseDate(value)
  d.setDate(d.getDate() - 1)
  return toDateInput(d)
}
const allDayEndForApi = (value: string) => {
  const d = parseDate(value)
  d.setDate(d.getDate() + 1)
  return toDateInput(d)
}

function eventTimeLabel(ev: CalEvent) {
  if (ev.allDay) return 'all day'
  const s = fmtTime(parseDate(ev.start))
  const e = ev.end ? fmtTime(parseDate(ev.end)) : ''
  return e ? `${s} – ${e}` : s
}

// The window of events to request from the API for a given view + anchor.
function fetchRange(view: string, anchor: Date): [Date, Date] {
  if (view === 'day') return [startOfDay(anchor), addDays(startOfDay(anchor), 1)]
  if (view === 'week') { const s = startOfWeek(anchor); return [s, addDays(s, 7)] }
  if (view === 'workweek') { const s = startOfWeek(anchor); return [s, addDays(s, 7)] }
  if (view === 'agenda') return [startOfDay(anchor), addDays(startOfDay(anchor), 14)]
  if (view === 'month') {
    const s = startOfWeek(startOfMonth(anchor))
    return [s, addDays(s, 42)] // full 6-week grid
  }
  // year
  const s = new Date(anchor.getFullYear(), 0, 1)
  return [s, new Date(anchor.getFullYear() + 1, 0, 1)]
}

// Title shown in the toolbar for the current view + anchor.
function rangeTitle(view: string, anchor: Date) {
  if (view === 'day') return anchor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  if (view === 'year') return String(anchor.getFullYear())
  if (view === 'month') return anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
  // week / workweek / agenda
  const s = view === 'agenda' ? startOfDay(anchor)
    : view === 'workweek' ? addDays(startOfWeek(anchor), WEEK_START === 0 ? 1 : 0)
    : startOfWeek(anchor)
  const e = view === 'workweek' ? addDays(s, 4) : addDays(s, view === 'agenda' ? 13 : 6)
  const sameMonth = s.getMonth() === e.getMonth()
  const sameYear = s.getFullYear() === e.getFullYear()
  const sFmt = s.toLocaleDateString([], { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })
  const eFmt = e.toLocaleDateString([], { month: sameMonth ? undefined : 'short', day: 'numeric', year: 'numeric' })
  return `${sFmt} – ${eFmt}`
}

// Greedy column packing for overlapping timed events within one day.
function packDay(items: CalEvent[]) {
  const evs: any[] = items
    .map((e) => ({ ev: e, s: minsOfDay(parseDate(e.start)), e: Math.max(minsOfDay(parseDate(e.end || e.start)), minsOfDay(parseDate(e.start)) + 25) }))
    .sort((a, b) => a.s - b.s || a.e - b.e)
  const out: any[] = []
  let cluster: any[] = []
  let clusterEnd = -1
  const flush = () => {
    const columns: any[][] = []
    for (const it of cluster) {
      let placed = false
      for (let i = 0; i < columns.length; i++) {
        if (it.s >= columns[i][columns[i].length - 1].e) { columns[i].push(it); it.col = i; placed = true; break }
      }
      if (!placed) { columns.push([it]); it.col = columns.length - 1 }
    }
    for (const it of cluster) { it.cols = columns.length; out.push(it) }
    cluster = []; clusterEnd = -1
  }
  for (const it of evs) {
    if (cluster.length && it.s >= clusterEnd) flush()
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e)
  }
  if (cluster.length) flush()
  return out
}

interface TimeGridProps {
  days: Date[]
  events: CalEvent[]
  onPickDay?: (d: Date) => void
  onSelectEvent: (ev: CalEvent) => void
}

// ---------- time-grid (day / week / workweek) ----------
function TimeGrid({ days, events, onPickDay, onSelectEvent }: TimeGridProps) {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Scroll to ~7am so the morning is visible without manual scrolling.
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX
  }, [days[0]?.getTime()])

  const allDayByDay = days.map((d) => events.filter((e) => e.allDay && sameDay(parseDate(e.start), d)))
  const hasAllDay = allDayByDay.some((l) => l.length)
  const now = new Date()

  return (
    <div className="tg">
      <div className="tg-head">
        <div className="tg-gutter" />
        {days.map((d) => (
          <div key={d.getTime()} className={`tg-daycol-h ${isToday(d) ? 'today' : ''}`} onClick={() => onPickDay?.(d)}>
            <span className="tg-dow">{d.toLocaleDateString([], { weekday: 'short' })}</span>
            <span className="tg-dnum">{d.getDate()}</span>
          </div>
        ))}
      </div>
      {hasAllDay && (
        <div className="tg-allday">
          <div className="tg-gutter">all day</div>
          {days.map((d, i) => (
            <div key={d.getTime()} className="tg-allday-col">
              {allDayByDay[i].map((ev) => (
                <EventChip key={ev.id} ev={ev} compact onClick={() => onSelectEvent(ev)} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="tg-body" ref={scroller}>
        <div className="tg-grid" style={{ height: 24 * HOUR_PX }}>
          <div className="tg-gutter-col">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="tg-hour" style={{ height: HOUR_PX }}>
                <span>{h === 0 ? '' : new Date(0, 0, 0, h).toLocaleTimeString([], { hour: 'numeric' })}</span>
              </div>
            ))}
          </div>
          {days.map((d) => {
            const dayEvents = events.filter((e) => !e.allDay && sameDay(parseDate(e.start), d))
            const packed = packDay(dayEvents)
            return (
              <div key={d.getTime()} className="tg-daycol">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="tg-slot" style={{ height: HOUR_PX }} />
                ))}
                {isToday(d) && (
                  <div className="tg-now" style={{ top: (minsOfDay(now) / 60) * HOUR_PX }} />
                )}
                {packed.map(({ ev, s, e, col, cols }) => (
                  <button
                    key={ev.id}
                    className={`tg-event acct-${(ev.accountIndex ?? 0) % 4}`}
                    onClick={() => onSelectEvent(ev)}
                    style={{
                      top: (s / 60) * HOUR_PX,
                      height: Math.max(((e - s) / 60) * HOUR_PX - 2, 16),
                      left: `calc(${(col / cols) * 100}% + 2px)`,
                      width: `calc(${(1 / cols) * 100}% - 4px)`,
                    }}
                  >
                    <span className="tg-event-t">{ev.title}</span>
                    <span className="tg-event-time">{fmtTime(parseDate(ev.start))}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function EventChip({ ev, compact, onClick }: { ev: CalEvent; compact?: boolean; onClick: () => void }) {
  const inner = (
    <>
      {!ev.allDay && <span className="chip-time">{fmtTime(parseDate(ev.start))}</span>}
      <span className="chip-t">{ev.title}</span>
    </>
  )
  const cls = `cal-chip acct-${(ev.accountIndex ?? 0) % 4} ${compact ? 'compact' : ''} ${ev.allDay ? 'allday' : ''}`
  return <button className={cls} onClick={onClick}>{inner}</button>
}

interface MonthGridProps {
  anchor: Date
  events: CalEvent[]
  onPickDay: (d: Date) => void
  onSelectEvent: (ev: CalEvent) => void
}

// ---------- month ----------
function MonthGrid({ anchor, events, onPickDay, onSelectEvent }: MonthGridProps) {
  const gridStart = startOfWeek(startOfMonth(anchor))
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const dows = Array.from({ length: 7 }, (_, i) => addDays(gridStart, i).toLocaleDateString([], { weekday: 'short' }))
  return (
    <div className="month">
      <div className="month-dow">{dows.map((d) => <div key={d}>{d}</div>)}</div>
      <div className="month-grid">
        {cells.map((d) => {
          const dayEvents = events
            .filter((e) => sameDay(parseDate(e.start), d))
            .sort((a, b) => (a.allDay === b.allDay ? (a.start < b.start ? -1 : 1) : a.allDay ? -1 : 1))
          const off = d.getMonth() !== anchor.getMonth()
          const shown = dayEvents.slice(0, 3)
          return (
            <div key={d.getTime()} className={`month-cell ${off ? 'off' : ''} ${isToday(d) ? 'today' : ''}`}>
              <button className="month-daynum" onClick={() => onPickDay(d)}>{d.getDate()}</button>
              <div className="month-events">
                {shown.map((ev) => <EventChip key={ev.id} ev={ev} compact onClick={() => onSelectEvent(ev)} />)}
                {dayEvents.length > shown.length && (
                  <button className="month-more" onClick={() => onPickDay(d)}>+{dayEvents.length - shown.length} more</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface MiniMonthProps {
  month: Date
  eventDays: Set<string>
  onPickDay: (d: Date) => void
  onPickMonth: (d: Date) => void
}

// ---------- year ----------
function MiniMonth({ month, eventDays, onPickDay, onPickMonth }: MiniMonthProps) {
  const gridStart = startOfWeek(startOfMonth(month))
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  return (
    <div className="mini-month">
      <button className="mini-title" onClick={() => onPickMonth(month)}>
        {month.toLocaleDateString([], { month: 'long' })}
      </button>
      <div className="mini-dow">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div className="mini-grid">
        {cells.map((d) => {
          const off = d.getMonth() !== month.getMonth()
          const has = !off && eventDays.has(d.toDateString())
          return (
            <button
              key={d.getTime()}
              className={`mini-day ${off ? 'off' : ''} ${isToday(d) ? 'today' : ''} ${has ? 'has' : ''}`}
              onClick={() => !off && onPickDay(d)}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface YearGridProps {
  anchor: Date
  events: CalEvent[]
  onPickDay: (d: Date) => void
  onPickMonth: (d: Date) => void
}

function YearGrid({ anchor, events, onPickDay, onPickMonth }: YearGridProps) {
  const eventDays = useMemo(() => {
    const s = new Set<string>()
    for (const e of events) s.add(parseDate(e.start).toDateString())
    return s
  }, [events])
  const months = Array.from({ length: 12 }, (_, m) => new Date(anchor.getFullYear(), m, 1))
  return (
    <div className="year">
      {months.map((m) => (
        <MiniMonth key={m.getTime()} month={m} eventDays={eventDays} onPickDay={onPickDay} onPickMonth={onPickMonth} />
      ))}
    </div>
  )
}

// ---------- agenda (list) ----------
function dayHeading(d: Date) {
  const today = new Date()
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, addDays(today, 1))) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'long' })
}

interface AgendaProps {
  anchor: Date
  events: CalEvent[]
  onSelectEvent: (ev: CalEvent) => void
}

function Agenda({ anchor, events, onSelectEvent }: AgendaProps) {
  const days: Record<string, CalEvent[]> = {}
  for (const ev of events) (days[parseDate(ev.start).toDateString()] ||= []).push(ev)
  const keys = Object.keys(days).sort((a, b) => +new Date(a) - +new Date(b))
  if (!keys.length) return <div className="empty">No events in this range.</div>
  return (
    <div className="cal-agenda">
      {keys.map((k) => (
    <div className="cal-day" key={k}>
      <div className="cal-day-h">
        {dayHeading(new Date(k))}
        <span className="date">{new Date(k).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      </div>
      <div className="card">
        {days[k].map((ev) => (
          <button className="event" key={ev.id} onClick={() => onSelectEvent(ev)}>
            <span className={`bar acct-${(ev.accountIndex ?? 0) % 4}`} />
            <span className="time">{eventTimeLabel(ev)}</span>
            <div>
              <div>{ev.title}</div>
              {ev.location && <div className="loc">{ev.location}</div>}
            </div>
          </button>
        ))}
      </div>
    </div>
      ))}
    </div>
  )
}

interface EventModalProps {
  event: CalEvent
  onClose: () => void
  onSave: (saved: CalEvent) => void
  onAuthError: () => void
}

function EventModal({ event, onClose, onSave, onAuthError }: EventModalProps) {
  const [form, setForm] = useState(() => ({
    title: event.title === '(no title)' ? '' : event.title,
    location: event.location || '',
    description: event.description || '',
    allDay: Boolean(event.allDay),
    start: event.allDay ? event.start : toDateTimeInput(parseDate(event.start)),
    end: event.allDay ? allDayEndForInput(event.end || event.start) : toDateTimeInput(parseDate(event.end || event.start)),
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useErrorToast(error)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (key: string, value: any) => setForm((f) => ({ ...f, [key]: value }))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload = {
        id: event.id,
        title: form.title.trim() || '(no title)',
        location: form.location,
        description: form.description,
        allDay: form.allDay,
        start: form.start,
        end: form.allDay ? allDayEndForApi(form.end || form.start) : form.end,
      }
      const { event: saved } = await updateCalendarEvent(payload)
      onSave(saved)
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="event-modal" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-kicker">{event.account} calendar</div>
            <h2>Event details</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>

        <label className="field">
          <span>Title</span>
          <input value={form.title} onChange={(e) => set('title', e.target.value)} autoFocus required />
        </label>

        <label className="field checkbox-field">
          <input type="checkbox" checked={form.allDay} onChange={(e) => {
            const checked = e.target.checked
            setForm((f) => checked
              ? { ...f, allDay: true, start: f.start.slice(0, 10), end: f.end.slice(0, 10) }
              : { ...f, allDay: false, start: `${f.start.slice(0, 10)}T09:00`, end: `${f.end.slice(0, 10)}T10:00` })
          }} />
          <span>All day</span>
        </label>

        <div className="field-row">
          <label className="field">
            <span>Starts</span>
            <input type={form.allDay ? 'date' : 'datetime-local'} value={form.start} onChange={(e) => set('start', e.target.value)} required />
          </label>
          <label className="field">
            <span>{form.allDay ? 'Ends on' : 'Ends'}</span>
            <input type={form.allDay ? 'date' : 'datetime-local'} value={form.end} onChange={(e) => set('end', e.target.value)} required />
          </label>
        </div>

        <label className="field">
          <span>Location</span>
          <input value={form.location} onChange={(e) => set('location', e.target.value)} />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </label>

        <div className="modal-actions">
          {event.htmlLink && <a className="btn" href={event.htmlLink} target="_blank" rel="noreferrer">Open in Google</a>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</button>
        </div>
      </form>
    </div>
  )
}

interface CalendarViewProps {
  onAuthError: () => void
}

// ---------- main ----------
export default function CalendarView({ onAuthError }: CalendarViewProps) {
  const [view, setView] = useState('week')
  const [anchor, setAnchor] = useState(() => new Date())
  const [events, setEvents] = useState<CalEvent[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useErrorToast(error)
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null)

  const [rStart, rEnd] = useMemo(() => fetchRange(view, anchor), [view, anchor])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { events, errors } = await getCalendarRange(rStart.toISOString(), rEnd.toISOString())
      setEvents(events)
      setErrors(errors || [])
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [rStart, rEnd, onAuthError])

  useEffect(() => { load() }, [load])

  const step = (dir: number) => {
    if (view === 'day') setAnchor((a) => addDays(a, dir))
    else if (view === 'week' || view === 'workweek') setAnchor((a) => addDays(a, dir * 7))
    else if (view === 'month') setAnchor((a) => addMonths(a, dir))
    else if (view === 'year') setAnchor((a) => addMonths(a, dir * 12))
    else setAnchor((a) => addDays(a, dir * 14)) // agenda
  }

  const pickDay = (d: Date) => { setAnchor(d); setView('day') }
  const pickMonth = (d: Date) => { setAnchor(d); setView('month') }
  const saveEvent = (saved: CalEvent) => {
    setEvents((list) => list.map((ev) => (ev.id === saved.id ? saved : ev)).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)))
    setSelectedEvent(saved)
  }

  const gridDays = useMemo(() => {
    if (view === 'day') return [startOfDay(anchor)]
    if (view === 'workweek') return Array.from({ length: 5 }, (_, i) => addDays(startOfWeek(anchor), i + (WEEK_START === 0 ? 1 : 0)))
    if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))
    return []
  }, [view, anchor])

  return (
    <div className="view cal-view">
      <div className="view-head cal-toolbar">
        <div className="cal-nav">
          <button className="btn" onClick={() => setAnchor(new Date())}>Today</button>
          <button className="btn compact" onClick={() => step(-1)} aria-label="Previous">‹</button>
          <button className="btn compact" onClick={() => step(1)} aria-label="Next">›</button>
          <h1 className="cal-title">{rangeTitle(view, anchor)}</h1>
          {loading && <span className="muted cal-loading">·</span>}
        </div>
        <div className="cal-viewswitch">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`seg ${view === v.id ? 'active' : ''}`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {errors.map((e) => <div key={e} className="muted inline-warn" style={{ marginBottom: 6 }}><WarnIcon /> {e}</div>)}

      {(view === 'day' || view === 'week' || view === 'workweek') && (
        <TimeGrid days={gridDays} events={events} onPickDay={pickDay} onSelectEvent={setSelectedEvent} />
      )}
      {view === 'month' && <MonthGrid anchor={anchor} events={events} onPickDay={pickDay} onSelectEvent={setSelectedEvent} />}
      {view === 'year' && <YearGrid anchor={anchor} events={events} onPickDay={pickDay} onPickMonth={pickMonth} />}
      {view === 'agenda' && <Agenda anchor={anchor} events={events} onSelectEvent={setSelectedEvent} />}
      {selectedEvent && (
        <EventModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onSave={saveEvent}
          onAuthError={onAuthError}
        />
      )}
    </div>
  )
}
