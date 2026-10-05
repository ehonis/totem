import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Hi, BoltIcon, PlusIcon, TrashIcon, ClockIcon, XMarkIcon, PlayIcon, ArrowPathIcon,
  PencilSquareIcon, CheckCircleIcon, ExclamationTriangleIcon, ChevronRightIcon,
  ChevronDownIcon, InformationCircleIcon,
} from '../icons'
import { iconFor, listWorkflows, saveWorkflows } from '../studio'
import IconPicker from './IconPicker'
import {
  getJobs, createJob, updateJob, deleteJob, restoreJob, runJobNow, getJobRuns, AuthError,
} from '../api'
import { pushSuccess, pushError } from '../toast'

// Jobs — everything Totem does on a timer, and whether it actually did it.
//
// This replaced a Workflows tab whose user-authored jobs were saved to
// localStorage and read by nothing: you could build a job, see it listed, and it
// would never run, because the scheduler on the bridge had no idea it existed.
// Every job here is server-side, has a computed next run the UI shows you
// outright, and reports the outcome of its last attempt including the error text.
//
// The "Triggered"/event trigger type the old tab offered is gone rather than
// carried over. Its four event sources were never wired to anything, and an
// affordance that quietly does nothing is the whole problem being fixed.

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
const TimezoneContext = React.createContext<string | null>(null)

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
function tzLabel(tz: string): string {
  try {
    const abbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value
    return abbr ? `${tz} (${abbr})` : tz
  } catch {
    return tz
  }
}

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
function LastRunPill({ job }: { job: any }) {
  const run = job.lastRun
  if (!run) {
    return <span className="run-pill idle" title="This job has not run since it was created">Never run</span>
  }
  if (run.status === 'running') {
    return <span className="run-pill running">Running…</span>
  }
  const when = relativeTime(run.startedAt || run.ts)
  if (run.status === 'error') {
    return <span className="run-pill bad" title={run.error || ''}><Hi icon={ExclamationTriangleIcon} size={11} /> Failed {when}</span>
  }
  if (run.status === 'skipped') {
    return <span className="run-pill warn" title={run.error || run.preview || ''}>Skipped {when}</span>
  }
  return (
    <span className="run-pill good" title={run.preview || ''}>
      <Hi icon={CheckCircleIcon} size={11} /> Ran {when}{run.ms != null ? ` · ${formatMs(run.ms)}` : ''}
    </span>
  )
}

// Live per-AI health. The reason this exists: picking an AI you haven't used in
// weeks used to fail at run time with a raw CLI error, or worse, look fine.
function ProviderHealthStrip({ health, onRecheck, busy }: { health: any; onRecheck: () => void; busy: boolean }) {
  const providers = health?.providers || []
  if (!providers.length) return null
  const problems = providers.filter((p: any) => p.enabled && p.state !== 'ready' && p.state !== 'unknown')
  return (
    <div className="ai-health">
      <div className="ai-health-row">
        <span className="ai-health-label">AI status</span>
        {providers.map((p: any) => (
          <span
            key={p.id}
            className={`ai-chip ${p.state}`}
            title={`${p.detail || p.state}${p.fix ? `\nFix: ${p.fix}` : ''}`}
          >
            <span className="ai-dot" />
            {p.name}
            {p.default && <span className="ai-default">default</span>}
          </span>
        ))}
        <button className="btn compact ghost ai-recheck" onClick={onRecheck} disabled={busy}>
          <Hi icon={ArrowPathIcon} size={13} className={busy ? 'spin' : ''} /> {busy ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      {problems.map((p: any) => (
        <div className="ai-health-warn" key={p.id}>
          <Hi icon={ExclamationTriangleIcon} size={13} />
          <span><strong>{p.name}</strong> {p.detail}.{p.fix ? <> Run <code>{p.fix}</code> on the box.</> : null}</span>
        </div>
      ))}
    </div>
  )
}

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

// ---- editor ----------------------------------------------------------------

interface JobFormProps {
  initial?: any
  providers: any[]
  skills: any[]
  runners: any[]
  heading: string
  submitLabel: string
  onSubmit: (fields: any) => void
  onCancel: () => void
  onEditSkill: (skillId: string) => void
}

function JobForm({ initial, providers, skills, runners, heading, submitLabel, onSubmit, onCancel, onEditSkill }: JobFormProps) {
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [iconName, setIconName] = useState(initial?.iconName || 'clock')
  const [prompt, setPrompt] = useState(initial?.prompt || '')
  const [skillId, setSkillId] = useState(initial?.skillId || '')
  const [schedule, setSchedule] = useState<ScheduleValue>(initial?.schedule || { type: 'daily', time: '08:00' })
  const [provider, setProvider] = useState(initial?.provider || 'default')
  const [notify, setNotify] = useState(initial?.notify || 'errors')

  // What a job runs, in the same precedence the server uses: a code runner first,
  // then a skill, then an inline prompt. A job with a runner still gets a skill
  // picker where the runner takes one, because the runner is only the bookkeeping
  // around the prompt — the prompt itself is always yours to change.
  const runner = initial?.runner ? runners.find((r: any) => r.id === initial.runner) : null
  const runnerTakesSkill = Boolean(runner && initial?.skillId)
  const runsOwnCode = Boolean(runner && !initial?.skillId)
  const [source, setSource] = useState<'skill' | 'prompt'>(
    initial?.skillId || (!initial?.prompt && !initial) ? 'skill' : initial?.prompt ? 'prompt' : 'skill',
  )
  const usingSkill = runsOwnCode ? false : source === 'skill'
  const valid = name.trim() && (runsOwnCode || (usingSkill ? skillId : prompt.trim()))

  const chosen = providers.find((p: any) => p.id === provider)
  const defaultProvider = providers.find((p: any) => p.default)
  const chosenSkill = skills.find((s: any) => s.id === skillId)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    const fields: any = { name: name.trim(), description: description.trim(), iconName, schedule, notify }
    if (!runsOwnCode) {
      // Exactly one of the two is set, and the other is explicitly cleared —
      // otherwise a job that used to run a prompt would keep running it even after
      // you pointed it at a skill.
      fields.skillId = usingSkill ? skillId : null
      fields.prompt = usingSkill ? '' : prompt.trim()
    }
    // An agentless job has no AI to set; sending one would be meaningless.
    if (!initial?.agentless && !initial?.fixedProvider) fields.provider = provider
    onSubmit(fields)
  }

  return (
    <form className="job-form" onSubmit={submit}>
      <div className="skill-form-head">
        <strong>{heading}</strong>
        <button type="button" className="icon-btn small" onClick={onCancel} aria-label="Cancel"><Hi icon={XMarkIcon} size={15} /></button>
      </div>

      <label className="catalog-field">
        <span>Name</span>
        <div className="workflow-name-row">
          <IconPicker value={iconName} onChange={setIconName} />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Nightly repo digest"
            autoFocus
          />
        </div>
      </label>

      <label className="catalog-field">
        <span>Short description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this job is for, in a sentence"
        />
      </label>

      <div className="catalog-field">
        <span>When</span>
        <ScheduleBuilder value={schedule} onChange={setSchedule} />
      </div>

      <div className="catalog-field">
        <span>What it runs</span>
        {runsOwnCode ? (
          <div className="job-form-note">
            <Hi icon={InformationCircleIcon} size={14} />
            {runner?.detail || 'This one runs code rather than a prompt, so there is nothing to word.'}
          </div>
        ) : (
          <>
            <div className="segmented">
              <button type="button" className={usingSkill ? 'active' : ''} onClick={() => setSource('skill')}>A skill</button>
              <button type="button" className={!usingSkill ? 'active' : ''} onClick={() => setSource('prompt')}>A prompt written here</button>
            </div>
            {usingSkill ? (
              <>
                <select className="model-select" value={skillId} onChange={(e) => setSkillId(e.target.value)}>
                  <option value="">Choose a skill…</option>
                  {skills.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {chosenSkill && (
                  <em>
                    {chosenSkill.description || 'No description.'}{' '}
                    <button type="button" className="link-btn inline" onClick={() => onEditSkill(chosenSkill.id)}>
                      Edit this skill
                    </button>
                  </em>
                )}
                {runnerTakesSkill && (
                  <em><Hi icon={InformationCircleIcon} size={12} /> {runner?.detail}</em>
                )}
              </>
            ) : (
              <>
                <textarea
                  rows={5}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="What should Totem do each time this runs? Write it as you would in chat — it has your tools, memory, and calendar."
                />
                <em>Sent to the AI exactly as written, with Totem's usual context. Save it as a skill instead if you want to reuse it.</em>
              </>
            )}
          </>
        )}
      </div>

      {initial?.runnerMissing && (
        <div className="job-form-note warn">
          <Hi icon={ExclamationTriangleIcon} size={14} />
          This job runs <code>{initial.runner}</code>, which this version of Totem no longer has. Point it at a skill instead.
        </div>
      )}

      {initial?.agentless ? (
        <div className="catalog-field">
          <span>AI</span>
          <div className="job-form-note"><Hi icon={InformationCircleIcon} size={14} /> This job talks to an API directly and uses no AI.</div>
        </div>
      ) : initial?.fixedProvider ? (
        <div className="catalog-field">
          <span>AI</span>
          <div className="job-form-note">
            <Hi icon={InformationCircleIcon} size={14} />
            Always runs on the default AI{defaultProvider ? ` (${defaultProvider.name})` : ''} — this one's pipeline can't take an override.
          </div>
        </div>
      ) : (
        <label className="catalog-field">
          <span>AI</span>
          <select className="model-select" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="default">Default{defaultProvider ? ` (${defaultProvider.name})` : ''}</option>
            {providers.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.state === 'ready' ? '' : ` — ${p.state === 'missing' ? 'not installed' : p.state === 'logged-out' ? 'logged out' : p.state}`}
              </option>
            ))}
          </select>
          {chosen && chosen.state !== 'ready' && chosen.state !== 'unknown' && (
            <em className="field-warn">
              <Hi icon={ExclamationTriangleIcon} size={12} /> {chosen.name} {chosen.detail}. The job will fail until that's fixed{chosen.fix ? <> — run <code>{chosen.fix}</code></> : null}.
            </em>
          )}
        </label>
      )}

      <label className="catalog-field">
        <span>Notify me</span>
        <select className="model-select" value={notify} onChange={(e) => setNotify(e.target.value)}>
          {NOTIFY_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>
      {/* "Every run" is a fine choice for a job that runs once a day and a bad one
          for a poll — the two settings only conflict for the window type, so the
          warning only appears there. */}
      {schedule.type === 'window' && notify === 'always' && (
        <div className="job-form-note warn">
          <Hi icon={ExclamationTriangleIcon} size={13} />
          <span>
            That is {windowRuns(schedule.from || '08:00', schedule.to || '08:00', schedule.everyMinutes || 30)} notifications
            every day this runs. “Only when it fails” is usually what you want for a job that keeps checking.
          </span>
        </div>
      )}

      <div className="skill-form-actions">
        <button type="button" className="btn compact" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn compact primary" disabled={!valid}>{submitLabel}</button>
      </div>
    </form>
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

// ---- one job row -----------------------------------------------------------

interface JobRowProps {
  job: any
  providers: any[]
  busy: boolean
  expanded: boolean
  onToggle: (job: any, enabled: boolean) => void
  onRun: (job: any) => void
  onEdit: (job: any) => void
  onDelete: (job: any) => void
  onExpand: (id: string | null) => void
}

function JobRow({ job, providers, busy, expanded, onToggle, onRun, onEdit, onDelete, onExpand }: JobRowProps) {
  const { dayAndTime } = useJobTime()
  const repeating = job.schedule?.type === 'interval' || job.schedule?.type === 'window'
  const Icon = iconFor(job.iconName, repeating ? 'bolt' : 'clock')
  const run = job.lastRun
  const failing = run?.status === 'error'
  const providerId = job.agentless ? null : (job.provider === 'default' ? providers.find((p: any) => p.default)?.id : job.provider)
  const providerHealth = providerId ? providers.find((p: any) => p.id === providerId) : null
  // An AI that's dead is a job that will fail next time, before it ever runs.
  const willFail = job.enabled && providerHealth && providerHealth.state !== 'ready' && providerHealth.state !== 'unknown'

  return (
    <div className={`job-row ${job.enabled ? '' : 'off'} ${failing ? 'failing' : ''}`}>
      <div className="job-row-main">
        <span className={`workflow-glyph ${repeating ? 'event' : 'timed'}`}>
          <Hi icon={Icon} size={16} />
        </span>
        <div className="job-body">
          <div className="job-title">
            <strong>{job.name}</strong>
            <span className={`workflow-origin ${job.kind}`}>{job.kind === 'system' ? 'Built-in' : 'Yours'}</span>
            {job.consecutiveFailures > 1 && (
              <span className="job-streak" title={`${job.consecutiveFailures} failed runs in a row`}>{job.consecutiveFailures}× failed</span>
            )}
          </div>

          {job.description && <div className="job-desc">{job.description}</div>}

          <div className="job-meta">
            <span className="job-sched"><Hi icon={ClockIcon} size={12} /> {job.scheduleLabel}</span>
            {job.enabled ? (
              job.nextRunAt
                ? <span className="job-next">Next: <strong>{dayAndTime(job.nextRunAt)}</strong> <span className="muted">({relativeTime(job.nextRunAt)})</span></span>
                : <span className="job-next bad">Not scheduled</span>
            ) : <span className="job-next muted">Off — won’t run</span>}
            {providerId && <span className={`job-ai ${providerHealth?.state || ''}`}><span className="ai-dot" />{providerHealth?.name || providerId}</span>}
          </div>

          <div className="job-status-line">
            <LastRunPill job={job} />
            {failing && <span className="job-error">{run.error}</span>}
            {run?.status === 'skipped' && run.error && <span className="job-error muted">{run.error}</span>}
            {willFail && !failing && (
              <span className="job-error">
                {providerHealth.name} {providerHealth.detail} — this will fail on its next run.
              </span>
            )}
          </div>
        </div>

        <div className="job-actions">
          <Switch checked={job.enabled} disabled={busy} onChange={(v) => onToggle(job, v)} label={`Enable ${job.name}`} />
          <button className="icon-btn small" disabled={busy || run?.status === 'running'} onClick={() => onRun(job)} title="Run now (doesn’t change the schedule)">
            <Hi icon={PlayIcon} size={14} />
          </button>
          <button className="icon-btn small" onClick={() => onEdit(job)} title="Edit job">
            <Hi icon={PencilSquareIcon} size={14} />
          </button>
          <button
            className="icon-btn small danger"
            onClick={() => onDelete(job)}
            title={job.kind === 'seeded' ? 'Delete job (you can restore it later)' : 'Delete job'}
          >
            <Hi icon={TrashIcon} size={14} />
          </button>
          <button
            className="icon-btn small"
            onClick={() => onExpand(expanded ? null : job.id)}
            title="Run history"
            aria-expanded={expanded}
          >
            <Hi icon={expanded ? ChevronDownIcon : ChevronRightIcon} size={14} />
          </button>
        </div>
      </div>
      {expanded && <RunHistory jobId={job.id} />}
    </div>
  )
}

// ---- legacy import ---------------------------------------------------------

// Jobs authored in the old tab were written to localStorage and read by nothing.
// Rather than drop them on the floor, offer to turn them into real ones — this is
// most likely where someone's "I made a job and it never ran" job still lives.
function LegacyImport({ onImport, onDismiss }: { onImport: (jobs: any[]) => void; onDismiss: () => void }) {
  const legacy = useMemo(() => {
    try {
      return (listWorkflows() || []).filter((w: any) => w && w.name)
    } catch { return [] }
  }, [])
  if (!legacy.length) return null
  return (
    <div className="legacy-banner">
      <Hi icon={ExclamationTriangleIcon} size={16} />
      <div className="legacy-body">
        <strong>{legacy.length} job{legacy.length === 1 ? '' : 's'} saved in this browser never ran.</strong>
        <span>
          The old Workflows tab kept them here instead of on the server, so nothing scheduled them:{' '}
          {legacy.map((w: any) => w.name).join(', ')}. Import them as real jobs (off by default, so you can set the schedule first).
        </span>
      </div>
      <div className="legacy-actions">
        <button className="btn compact primary" onClick={() => onImport(legacy)}>Import</button>
        <button className="btn compact" onClick={onDismiss}>Discard</button>
      </div>
    </div>
  )
}

// ---- the view --------------------------------------------------------------

export default function JobsView({ onAuthError }: { onAuthError: () => void }) {
  const [payload, setPayload] = useState<any>(null)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [legacyDone, setLegacyDone] = useState(false)

  const load = useCallback(async ({ recheck = false } = {}) => {
    try {
      const p = await getJobs({ recheck })
      setPayload(p)
      setErr('')
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setErr(e.message || String(e))
    }
  }, [onAuthError])

  useEffect(() => { load() }, [load])

  // Keep next-run countdowns and in-flight runs honest without a manual refresh.
  useEffect(() => {
    const t = setInterval(() => load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  const jobs = payload?.jobs || []
  const providers = payload?.providers?.providers || []
  // What a job can be pointed at, and which defaults have been deleted. Both come
  // from the same payload as the jobs, so the picker can't offer a skill the
  // server doesn't have.
  const skills = payload?.skills || []
  const runners = payload?.runners || []
  const restorable = payload?.restorable || []

  const guard = useCallback(async (id: string, fn: () => Promise<any>, okMsg?: string) => {
    setBusyId(id)
    try {
      const p = await fn()
      if (p?.jobs) setPayload(p)
      else await load()
      if (okMsg) pushSuccess(okMsg)
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      pushError(e.message || String(e))
    } finally {
      setBusyId(null)
    }
  }, [load, onAuthError])

  const onToggle = (job: any, enabled: boolean) =>
    guard(job.id, () => updateJob(job.id, { enabled }), enabled ? `${job.name} is on` : `${job.name} is off`)

  const onRun = async (job: any) => {
    setBusyId(job.id)
    try {
      const p = await runJobNow(job.id)
      setPayload(p)
      const status = p?.run?.status
      if (status === 'error') pushError(`${job.name} failed: ${p.run.error}`)
      else if (status === 'skipped') pushSuccess(`${job.name}: ${p.run.preview || p.run.error || 'nothing to do'}`)
      else pushSuccess(`${job.name} ran in ${formatMs(p?.run?.ms)}`)
      setExpanded(job.id)
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      pushError(e.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  const onDelete = (job: any) => {
    const extra = job.kind === 'seeded'
      ? ' It ships with Totem, so it will not come back on restart — but you can restore it from the strip below.'
      : ''
    if (!window.confirm(`Delete "${job.name}"? Its run history is kept, but it will stop running.${extra}`)) return
    guard(job.id, () => deleteJob(job.id), `${job.name} deleted`)
  }

  const onRestore = (entry: any) =>
    guard(entry.id, () => restoreJob(entry.id), `${entry.name} restored`)

  // Jump from a job straight to the skill it runs. The two tabs are separate
  // routes, so this is a plain navigation rather than a nested editor.
  const editSkill = (skillId: string) => {
    window.history.pushState({}, '', '/studio/skills')
    window.dispatchEvent(new PopStateEvent('popstate'))
    pushSuccess(`Open “${skills.find((s: any) => s.id === skillId)?.name || skillId}” to edit what this job says`)
  }

  const recheck = async () => {
    setRechecking(true)
    try { await load({ recheck: true }) } finally { setRechecking(false) }
  }

  const importLegacy = async (legacy: any[]) => {
    let made = 0
    for (const w of legacy) {
      try {
        await createJob({
          name: w.name,
          description: w.description || '',
          iconName: w.iconName || 'clock',
          // The old free-text schedule ("Every weekday at 9am") was never parsed by
          // anything, so it can't be trusted into a real one. Import off, at a
          // neutral time, and let the schedule be picked deliberately.
          schedule: { type: 'daily', time: '09:00' },
          prompt: w.action || w.manualText || `Run the "${w.name}" workflow.`,
          enabled: false,
          notify: 'errors',
        })
        made++
      } catch { /* keep going; the banner reports the total that landed */ }
    }
    saveWorkflows([])
    setLegacyDone(true)
    await load()
    pushSuccess(`${made} job${made === 1 ? '' : 's'} imported — set a schedule, then switch each on`)
  }

  const failing = jobs.filter((j: any) => j.lastRun?.status === 'error')
  const enabledCount = jobs.filter((j: any) => j.enabled).length
  // Say so when the browser sits in a different zone than the scheduler. Every
  // time on this page is now the scheduler's, so without this the page and the
  // taskbar clock disagree with no explanation — which is how "the sync is in the
  // wrong timezone" gets diagnosed from times that were always right.
  const viewerOffset = (() => {
    const tz = payload?.timezone
    if (!tz) return null
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!here || here === tz) return null
    const at = (zone: string) => new Date().toLocaleString('en-US', { timeZone: zone, hour12: false, hour: '2-digit', minute: '2-digit' })
    return at(here) === at(tz) ? null : tzLabel(here)
  })()

  return (
    <TimezoneContext.Provider value={payload?.timezone || null}>
    <div className="studio-pane jobs-view">
      <header className="studio-pane-head">
        <div>
          <h2>Jobs</h2>
          <p>
            Everything Totem runs on a timer — {enabledCount} of {jobs.length} switched on.
            {payload?.timezone ? ` Times are ${tzLabel(payload.timezone)}.` : ''}
            {viewerOffset ? ` This device is on ${viewerOffset}, so they won’t match its clock.` : ''}
            {payload?.tickSeconds ? ` The scheduler checks every ${payload.tickSeconds} seconds, so a job fires within that of the minute you pick.` : ''}
          </p>
        </div>
        {!creating && (
          <button className="btn compact primary" onClick={() => { setCreating(true); setEditing(null) }}>
            <Hi icon={PlusIcon} size={15} /> New job
          </button>
        )}
      </header>

      {err && <div className="muted inline-warn"><Hi icon={ExclamationTriangleIcon} size={14} /> {err}</div>}

      {!legacyDone && <LegacyImport onImport={importLegacy} onDismiss={() => { saveWorkflows([]); setLegacyDone(true) }} />}

      <ProviderHealthStrip health={payload?.providers} onRecheck={recheck} busy={rechecking} />

      {failing.length > 0 && (
        <div className="jobs-alert">
          <Hi icon={ExclamationTriangleIcon} size={15} />
          <span>
            {failing.length === 1
              ? <><strong>{failing[0].name}</strong> failed: {failing[0].lastRun.error}</>
              : <><strong>{failing.length} jobs</strong> failed on their last run — see the red rows below.</>}
          </span>
        </div>
      )}

      {creating && (
        <JobForm
          heading="New job"
          submitLabel="Create job"
          providers={providers}
          skills={skills}
          runners={runners}
          onEditSkill={editSkill}
          onCancel={() => setCreating(false)}
          onSubmit={async (fields) => {
            setCreating(false)
            await guard('new', () => createJob(fields), `${fields.name} created`)
          }}
        />
      )}

      {!payload && !err && <div className="muted">Loading jobs…</div>}

      <div className="job-list">
        {jobs.map((job: any, idx: number) => (
          editing === job.id ? (
            <JobForm
              key={job.id}
              initial={job}
              heading={`Edit ${job.name}`}
              submitLabel="Save changes"
              providers={providers}
              skills={skills}
              runners={runners}
              onEditSkill={editSkill}
              onCancel={() => setEditing(null)}
              onSubmit={async (fields) => {
                setEditing(null)
                await guard(job.id, () => updateJob(job.id, fields), `${job.name} saved`)
              }}
            />
          ) : (
            <JobRow
              key={job.id}
              job={job}
              providers={providers}
              busy={busyId === job.id}
              expanded={expanded === job.id}
              onToggle={onToggle}
              onRun={onRun}
              onEdit={(j) => { setEditing(j.id); setCreating(false) }}
              onDelete={onDelete}
              onExpand={setExpanded}
            />
          )
        ))}
      </div>

      {payload && !jobs.length && <div className="ov-empty">No jobs yet.</div>}

      {restorable.length > 0 && (
        <div className="jobs-restorable">
          <div className="settings-section-title"><span /><strong>Defaults you deleted</strong></div>
          <p className="muted">
            These shipped with Totem and won't come back on their own. Restoring one brings it back at its
            original schedule, switched off.
          </p>
          {restorable.map((entry: any) => (
            <div key={entry.id} className="restorable-row">
              <div>
                <strong>{entry.name}</strong>
                <span className="muted">{entry.description}</span>
              </div>
              <button className="btn compact" disabled={busyId === entry.id} onClick={() => onRestore(entry)}>
                <Hi icon={ArrowPathIcon} size={13} /> Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
    </TimezoneContext.Provider>
  )
}
