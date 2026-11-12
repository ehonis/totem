import React, { useEffect, useMemo, useState } from 'react'
import { Hi, ExclamationTriangleIcon } from '../icons'
import { getJobRuns } from '../api'

// The pieces of a totem's settings that deal in time: the schedule editor, the
// run history, the notify choices and the relative-time label. They came from
// the old Settings → Jobs page, which the Totems page replaced (every job is a
// totem; components/TotemsView.tsx).

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]

// The interval choices worth offering as buttons. Anything else is a rounding
// error on "how often should this run", and a free-text minutes box invites the
// 0-minute and 100000-minute cases the server has to clamp anyway.
const INTERVAL_CHOICES = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' },
]

export const NOTIFY_CHOICES = [
  { id: 'agent', label: 'When the totem decides it matters' },
  { id: 'errors', label: 'Only when it fails' },
  { id: 'always', label: 'Every run' },
  { id: 'never', label: 'Never' },
]

// ---- formatting ------------------------------------------------------------

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  const ahead = diff >= 0
  const mins = Math.round(Math.abs(diff) / 60000)
  if (mins < 1) return ahead ? 'in under a minute' : 'just now'
  if (mins < 60) return ahead ? `in ${mins}m` : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  if (hours < 24) {
    const h = rem ? `${hours}h ${rem}m` : `${hours}h`
    return ahead ? `in ${h}` : `${h} ago`
  }
  const days = Math.round(hours / 24)
  return ahead ? `in ${days}d` : `${days}d ago`
}

// A job's clock times belong to the scheduler's timezone, not the viewer's. The
// server schedules "07:30" in MORNING_BRIEFING_TZ and reports the resolved
// instant; rendering that instant in the browser's zone made a perfectly correct
// schedule read hours off from its own label — and made the header's "Times are
// <zone>" claim untrue on any device not set to Eastern. The zone comes from the
// jobs payload, so it always agrees with what actually fires.
/** The scheduler's time zone (GET /api/jobs `timezone`); run times are shown in it. */
export const TimezoneContext = React.createContext<string | null>(null)

// Local calendar day in `tz`, as YYYY-MM-DD. 'en-CA' is the shortest way to get
// that ordering out of Intl, and it's what jobs/schedule.mjs uses server-side.
function civilDay(ts: number, tz?: string): string {
  return new Date(ts).toLocaleDateString('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz,
  })
}

// The day after a YYYY-MM-DD, stepped on the calendar rather than by adding 24
// hours, so "Tomorrow" is still tomorrow on the two days a year that aren't 24
// hours long.
function nextCivilDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

// "America/New_York (EDT)". The abbreviation is the part that answers "is this
// actually Eastern, or has it drifted" — the doubt that brought us here.

// Formatters bound to the scheduler's zone. A hook rather than plain functions
// because the zone arrives with the payload, and every row has to agree on it.
function useJobTime() {
  const tz = React.useContext(TimezoneContext) || undefined
  return React.useMemo(() => {
    const clockTime = (ts: number) =>
      new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz })
    const dayAndTime = (ts: number) => {
      // "Today"/"Tomorrow" have to be decided in the same zone as the time beside
      // them, or an 11pm Eastern run reads as "Tomorrow 11:00 PM" to a viewer
      // whose own calendar day has already turned over.
      const today = civilDay(Date.now(), tz)
      const key = civilDay(ts, tz)
      const day = key === today
        ? 'Today'
        : key === nextCivilDay(today)
          ? 'Tomorrow'
          : new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })
      return `${day} ${clockTime(ts)}`
    }
    return { clockTime, dayAndTime }
  }, [tz])
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

// ---- small shared pieces ---------------------------------------------------

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label: string
}

export function Switch({ checked, onChange, disabled, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

// A job's last attempt, stated plainly. "Never run" is its own state on purpose:
// an enabled job that has never run is the exact thing that used to hide.
// ---- schedule builder ------------------------------------------------------

interface ScheduleValue {
  type: 'daily' | 'weekly' | 'interval' | 'window'
  time?: string
  days?: number[]
  everyMinutes?: number
  from?: string
  to?: string
}

// Steps offered for a polling window. Capped well below the interval choices on
// purpose: the point of a window is to check repeatedly inside a few hours, and a
// 6-hour step inside a 4-hour window is a single run wearing a poll's clothes.
const WINDOW_STEPS = [
  { minutes: 10, label: '10 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
]

// Mirrors windowSlotCount() in jobs/schedule.mjs. Duplicated rather than fetched
// because the count has to update as you drag the time inputs, before anything is
// saved — and it is four lines of arithmetic. The server's value is what shows on
// the saved job.
function windowRuns(from: string, to: string, everyMinutes: number): number {
  const min = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const span = ((min(to) - min(from)) + 1440) % 1440
  return Math.floor(span / Math.max(1, everyMinutes)) + 1
}

// The point of this control is that what you pick is what runs. So it renders the
// resolved schedule back as a sentence, and the row it lives in shows the actual
// next run the server computed — not a promise, a timestamp.
export function ScheduleBuilder({ value, onChange }: { value: ScheduleValue; onChange: (v: ScheduleValue) => void }) {
  const type = value.type
  // Falling back through `from` keeps the time you already chose when you switch
  // a window back to a daily schedule, instead of silently resetting it to 08:00.
  const time = value.time || value.from || '08:00'
  const days = value.days || WEEKDAYS
  const everyMinutes = value.everyMinutes || 60
  // A window carries its own step, because 60 minutes is a sane default repeat
  // and a poor default poll. Seeded from the time already picked, so switching a
  // daily 07:00 job to a window starts the window at 07:00 rather than 08:00.
  const from = value.from || time
  const to = value.to || '11:30'
  const windowStep = value.everyMinutes || 30
  const runsPerDay = windowRuns(from, to, windowStep)

  return (
    <div className="sched-builder">
      <div className="sched-tabs" role="tablist" aria-label="How often this job runs">
        {([
          { id: 'daily', label: 'Every day' },
          { id: 'weekly', label: 'Certain days' },
          { id: 'interval', label: 'On a repeat' },
          { id: 'window', label: 'Keep checking' },
        ] as const).map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={type === opt.id}
            className={`sched-tab ${type === opt.id ? 'active' : ''}`}
            onClick={() => onChange(
              opt.id === 'interval'
                ? { type: 'interval', everyMinutes }
                : opt.id === 'window'
                  ? { type: 'window', from, to, everyMinutes: windowStep, days }
                  : opt.id === 'weekly'
                    ? { type: 'weekly', time, days }
                    : { type: 'daily', time },
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {(type === 'daily' || type === 'weekly') && (
        <label className="sched-time">
          <span>At</span>
          <input
            type="time"
            value={time}
            onChange={(e) => e.target.value && onChange({ ...value, type, time: e.target.value })}
            aria-label="Time of day to run"
          />
        </label>
      )}

      {type === 'window' && (
        <>
          <div className="sched-window">
            <label className="sched-time">
              <span>Between</span>
              <input
                type="time"
                value={from}
                onChange={(e) => e.target.value && onChange({ ...value, type, from: e.target.value, to, everyMinutes: windowStep, days })}
                aria-label="Time the window opens"
              />
            </label>
            <label className="sched-time">
              <span>and</span>
              <input
                type="time"
                value={to}
                onChange={(e) => e.target.value && onChange({ ...value, type, from, to: e.target.value, everyMinutes: windowStep, days })}
                aria-label="Time the window closes"
              />
            </label>
          </div>
          <div className="sched-intervals" role="group" aria-label="How often to check inside the window">
            <span className="sched-inline-label">Check</span>
            {WINDOW_STEPS.map((c) => (
              <button
                key={c.minutes}
                type="button"
                aria-pressed={windowStep === c.minutes}
                className={`sched-interval ${windowStep === c.minutes ? 'on' : ''}`}
                onClick={() => onChange({ ...value, type, from, to, everyMinutes: c.minutes, days })}
              >
                {c.label}
              </button>
            ))}
          </div>
          {/* The count is the thing that is easy to get wrong: "every 10 minutes
              from 7 to 11:30" is 28 runs, and if this job costs an AI call that
              matters. Say it before it is saved, not after. */}
          <p className="sched-note muted">
            {runsPerDay} run{runsPerDay === 1 ? '' : 's'} per day
            {to === from ? ' — the window has no length, so this is a single run.' : '.'}
            {' '}It stops at the end of the window and starts again the next day.
          </p>
        </>
      )}

      {(type === 'weekly' || type === 'window') && (
        <div className="sched-days" role="group" aria-label="Days to run">
          {DAY_LABELS.map((label, idx) => {
            const on = days.includes(idx)
            return (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                className={`sched-day ${on ? 'on' : ''}`}
                onClick={() => {
                  const next = on ? days.filter((d) => d !== idx) : [...days, idx].sort()
                  // Zero days selected means "never" — refuse rather than save a
                  // schedule that silently cannot fire.
                  if (!next.length) return
                  onChange({ ...value, type, time, from, to, everyMinutes: type === 'window' ? windowStep : everyMinutes, days: next })
                }}
              >
                {label}
              </button>
            )
          })}
          <button
            type="button"
            className="sched-day-preset"
            onClick={() => onChange({ ...value, type, time, from, to, everyMinutes: type === 'window' ? windowStep : everyMinutes, days: WEEKDAYS })}
          >
            Weekdays
          </button>
        </div>
      )}

      {type === 'interval' && (
        <div className="sched-intervals" role="group" aria-label="How often to repeat">
          {INTERVAL_CHOICES.map((c) => (
            <button
              key={c.minutes}
              type="button"
              aria-pressed={everyMinutes === c.minutes}
              className={`sched-interval ${everyMinutes === c.minutes ? 'on' : ''}`}
              onClick={() => onChange({ type: 'interval', everyMinutes: c.minutes })}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- run history -----------------------------------------------------------

export function RunHistory({ jobId }: { jobId: string }) {
  const [runs, setRuns] = useState<any[] | null>(null)
  const [err, setErr] = useState('')
  const { dayAndTime } = useJobTime()

  useEffect(() => {
    let alive = true
    getJobRuns(jobId, 20)
      .then((r) => { if (alive) setRuns(r.runs || []) })
      .catch((e) => { if (alive) setErr(e.message || String(e)) })
    return () => { alive = false }
  }, [jobId])

  if (err) return <div className="job-history"><div className="muted inline-warn"><Hi icon={ExclamationTriangleIcon} size={13} /> {err}</div></div>
  if (!runs) return <div className="job-history"><div className="muted">Loading history…</div></div>
  if (!runs.length) return <div className="job-history"><div className="muted">No runs recorded yet.</div></div>

  return (
    <div className="job-history">
      {runs.map((r: any, i: number) => (
        <div className={`job-run ${r.status}`} key={`${r.ts}-${i}`}>
          <span className="job-run-when">{dayAndTime(r.startedAt || r.ts)}</span>
          <span className={`run-pill ${r.status === 'ok' ? 'good' : r.status === 'error' ? 'bad' : 'warn'}`}>{r.status}</span>
          {r.trigger === 'manual' && <span className="job-run-tag">manual</span>}
          {r.late && <span className="job-run-tag late">caught up</span>}
          {r.provider && <span className="job-run-tag">{r.provider}</span>}
          {r.ms != null && <span className="job-run-ms">{formatMs(r.ms)}</span>}
          <span className="job-run-text">{r.error || r.preview || ''}</span>
        </div>
      ))}
    </div>
  )
}

