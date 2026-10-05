import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  getHabits, createHabit, reorderHabits, updateHabit, deleteHabit, logHabit,
  syncSleep, AuthError,
} from '../api'
import { useWhoopStatus, WhoopConnectButton, WhoopStatusNote } from './WhoopConnection'
import { COMMANDS } from '../shortcuts'
import { useCommand } from '../useShortcuts'
import {
  Hi, PlusIcon, MinusIcon, ArrowPathIcon, XMarkIcon, TrashIcon,
  PencilSquareIcon, CheckIcon, ChatBubbleLeftEllipsisIcon, FireIcon, ArchiveBoxIcon, Bars3Icon,
} from '../icons'
import { useErrorToast, pushToast } from '../toast'
import {
  MetricChart, MetricStatsStrip, metricSeries, metricStats, fmtMetric,
  type MetricConfig, type MetricPart,
} from './MetricChart'

type Cadence = 'daily' | 'weekly' | 'monthly'

interface Habit {
  id: string
  name: string
  description: string
  color: string
  cadence: Cadence
  target: number // completions per cadence period (day / Sun–Sat week / calendar month)
  metric: MetricConfig | null // optional number tracked alongside the check mark
  createdAt: string
  archived: boolean
}

interface Entry { count: number; note?: string; value?: number | null; parts?: Record<string, number> }
type Entries = Record<string, Record<string, Entry>> // date -> habitId -> entry

interface HabitsPayload {
  today: string
  habits: Habit[]
  entries: Entries
  palette: string[]
}

// ---- date helpers (all on local "YYYY-MM-DD" strings; the bridge decides what
// "today" is in the owner's timezone, so we never call new Date() for the day key) ----
const toDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const toISO = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const addDays = (iso: string, n: number): string => {
  const d = toDate(iso)
  d.setDate(d.getDate() + n)
  return toISO(d)
}
const dayLabel = (iso: string): string =>
  toDate(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

// Cadence periods: weeks run Monday–Sunday (matching the grid, goals and Bushido),
// months are calendar months. Completions always live on the day they happened;
// these just sum a habit's counts over the period containing `date`.
const dayOfWeek = (iso: string): number => (toDate(iso).getDay() + 6) % 7 // 0 = Monday … 6 = Sunday
const weekStartOf = (iso: string): string => addDays(iso, -dayOfWeek(iso))
const prevMonthOf = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function periodTotal(habit: Habit, entries: Entries, date: string): number {
  if (habit.cadence === 'weekly') {
    const start = weekStartOf(date)
    let t = 0
    for (let i = 0; i < 7; i++) t += entries[addDays(start, i)]?.[habit.id]?.count || 0
    return t
  }
  if (habit.cadence === 'monthly') {
    const ym = date.slice(0, 7)
    let t = 0
    for (const [d, day] of Object.entries(entries)) if (d.startsWith(ym)) t += day[habit.id]?.count || 0
    return t
  }
  return entries[date]?.[habit.id]?.count || 0
}

const CADENCE_NOUN: Record<Cadence, string> = { daily: 'day', weekly: 'week', monthly: 'month' }
const periodLabel = (cadence: Cadence): string => (cadence === 'weekly' ? 'this week' : 'this month')

// GitHub-style intensity: 0 = empty, then quartiles of count/target up to 4.
function levelOf(count: number, target: number): number {
  if (!count) return 0
  const r = count / Math.max(target, 1)
  return r >= 1 ? 4 : r >= 0.75 ? 3 : r >= 0.5 ? 2 : 1
}
const LEVEL_MIX = [0, 32, 55, 78, 100] // % of the habit color mixed into the base cell

function cellStyle(color: string, level: number): React.CSSProperties {
  if (!level) return {}
  return { background: `color-mix(in srgb, ${color} ${LEVEL_MIX[level]}%, var(--bg-3))` }
}

// Streaks in the habit's own unit: consecutive days with any completion (daily),
// or consecutive weeks/months that met the target. The still-in-progress current
// period never breaks the streak — this is a nightly retro, after all.
function streakOf(habit: Habit, entries: Entries, today: string): number {
  let n = 0
  if (habit.cadence === 'weekly') {
    let ws = weekStartOf(today)
    if (periodTotal(habit, entries, ws) >= habit.target) n++
    ws = addDays(ws, -7)
    while (periodTotal(habit, entries, ws) >= habit.target) { n++; ws = addDays(ws, -7) }
    return n
  }
  if (habit.cadence === 'monthly') {
    let ym = today.slice(0, 7)
    if (periodTotal(habit, entries, `${ym}-01`) >= habit.target) n++
    ym = prevMonthOf(ym)
    while (periodTotal(habit, entries, `${ym}-01`) >= habit.target) { n++; ym = prevMonthOf(ym) }
    return n
  }
  let day = today
  if (!(entries[day]?.[habit.id]?.count)) day = addDays(day, -1)
  while (entries[day]?.[habit.id]?.count) { n++; day = addDays(day, -1) }
  return n
}

// ---------- add / edit habit modal ----------
interface HabitFormModalProps {
  initial?: Habit | null
  palette: string[]
  usedColors: string[]
  onClose: () => void
  onSubmit: (fields: any) => Promise<void>
  onDelete?: () => Promise<void>
}

// The metric half of the habit form, kept as loose strings so a half-typed
// "0.5" or a cleared bound doesn't fight the number inputs. Blank means "no
// bound"; the bridge takes null for those.
interface MetricDraft {
  on: boolean
  label: string
  unit: string
  min: string
  max: string
  goal: string
  decimals: string
  direction: 'higher' | 'lower'
  chart: 'line' | 'bar'
  source: 'manual' | 'whoop-sleep'
  pinned: boolean
  parts: string // comma-separated part labels, e.g. "Deep, Light, REM, Awake"
}

const PART_COLORS = ['#5b8cff', '#7c5cff', '#2dd4bf', '#f0506e', '#e3b341', '#40c463', '#fb923c', '#22d3ee']

function metricDraftFrom(metric: MetricConfig | null | undefined): MetricDraft {
  return {
    on: Boolean(metric),
    label: metric?.label || '',
    unit: metric?.unit || '',
    min: metric?.min != null ? String(metric.min) : '',
    max: metric?.max != null ? String(metric.max) : '',
    goal: metric?.goal != null ? String(metric.goal) : '',
    decimals: String(metric?.decimals ?? 0),
    direction: metric?.direction === 'lower' ? 'lower' : 'higher',
    chart: metric?.chart === 'bar' ? 'bar' : 'line',
    source: metric?.source === 'whoop-sleep' ? 'whoop-sleep' : 'manual',
    pinned: metric?.pinned === true,
    parts: (metric?.parts || []).map((p) => p.label).join(', '),
  }
}

// Parts keep their existing key/color when their label survives an edit, so
// renaming "REM" to "Rem sleep" doesn't orphan the numbers already logged.
function metricFromDraft(draft: MetricDraft, existing: MetricPart[] = []): MetricConfig | null {
  if (!draft.on || !draft.label.trim()) return null
  const num = (s: string): number | null => {
    const t = s.trim()
    if (!t) return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  const byLabel = new Map(existing.map((p) => [p.label.toLowerCase(), p]))
  const parts = draft.parts.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8)
    .map((label, i) => {
      const prior = byLabel.get(label.toLowerCase())
      return {
        key: prior?.key || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `part-${i + 1}`,
        label,
        color: prior?.color || PART_COLORS[i % PART_COLORS.length],
      }
    })
  return {
    label: draft.label.trim(),
    unit: draft.unit.trim(),
    min: num(draft.min),
    max: num(draft.max),
    goal: num(draft.goal),
    decimals: Math.min(Math.max(Number(draft.decimals) || 0, 0), 2),
    direction: draft.direction,
    chart: draft.chart,
    source: draft.source,
    pinned: draft.pinned,
    parts,
  }
}

function HabitFormModal({ initial, palette, usedColors, onClose, onSubmit, onDelete }: HabitFormModalProps) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    description: initial?.description || '',
    cadence: (initial?.cadence || 'daily') as Cadence,
    target: initial?.target || 1,
    color: initial?.color || '', // '' = auto-assign on create
    archived: initial?.archived || false,
  })
  const [metric, setMetric] = useState<MetricDraft>(() => metricDraftFrom(initial?.metric))
  const setMetricField = (k: keyof MetricDraft, v: any) => setMetric((m) => ({ ...m, [k]: v }))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useErrorToast(error)
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('A name is required.'); return }
    setBusy('save')
    setError(null)
    try {
      const fields: any = {
        name: form.name.trim(),
        description: form.description,
        cadence: form.cadence,
        target: Math.max(1, Number(form.target) || 1),
        archived: form.archived,
        metric: metricFromDraft(metric, initial?.metric?.parts),
      }
      if (form.color) fields.color = form.color
      await onSubmit(fields)
    } catch (err: any) { setError(err.message); setBusy(null) }
  }

  const remove = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBusy('delete')
    setError(null)
    try { await onDelete?.() } catch (err: any) { setError(err.message); setBusy(null) }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="event-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-kicker">{initial ? 'Edit habit' : 'New habit'}</div>
            <h2>{initial ? initial.name : 'Track something daily'}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>
        <form className="todo-form" onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus={!initial} placeholder="e.g. Read, Gym, No sugar" />
          </label>
          <label className="field">
            <span>Description (optional)</span>
            <input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What counts as done?" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>How often</span>
              <select value={form.cadence} onChange={(e) => set('cadence', e.target.value as Cadence)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="field">
              <span>Times per {CADENCE_NOUN[form.cadence]}</span>
              <input type="number" min={1} max={50} value={form.target} onChange={(e) => set('target', e.target.value)} />
            </label>
          </div>
          <span className="habit-field-hint">
            {form.cadence === 'daily'
              ? '1 = simple yes/no. Higher (e.g. 8 glasses of water) shades the day darker the closer you get.'
              : `e.g. gym 3× a week, or deep-clean once a month. You still check it off on the day you do it; the check-in shows ${periodLabel(form.cadence)}’s progress.`}
          </span>
          <div className="field">
            <span>Color</span>
            <div className="habit-swatches">
              {!initial && (
                <button
                  type="button"
                  className={`habit-swatch auto ${!form.color ? 'selected' : ''}`}
                  onClick={() => set('color', '')}
                  title="Pick the next free color for me"
                >Auto</button>
              )}
              {palette.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`habit-swatch ${form.color === c ? 'selected' : ''} ${usedColors.includes(c) && c !== initial?.color ? 'used' : ''}`}
                  style={{ background: c }}
                  onClick={() => set('color', c)}
                  title={usedColors.includes(c) && c !== initial?.color ? 'Already used by another habit' : c}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>
          {/* Optional metric: the number this habit is really about. */}
          <div className="habit-metric-form">
            <label className="checkbox-field">
              <input type="checkbox" checked={metric.on} onChange={(e) => setMetricField('on', e.target.checked)} />
              Track a number with this habit
            </label>
            {metric.on && (
              <>
                <div className="field-row">
                  <label className="field">
                    <span>What's measured</span>
                    <input value={metric.label} onChange={(e) => setMetricField('label', e.target.value)} placeholder="e.g. Sleep score" />
                  </label>
                  <label className="field">
                    <span>Unit (optional)</span>
                    <input value={metric.unit} onChange={(e) => setMetricField('unit', e.target.value)} placeholder="e.g. min, kg, %" />
                  </label>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>Scale min</span>
                    <input type="number" value={metric.min} onChange={(e) => setMetricField('min', e.target.value)} placeholder="auto" />
                  </label>
                  <label className="field">
                    <span>Scale max</span>
                    <input type="number" value={metric.max} onChange={(e) => setMetricField('max', e.target.value)} placeholder="auto" />
                  </label>
                  <label className="field">
                    <span>Goal line</span>
                    <input type="number" value={metric.goal} onChange={(e) => setMetricField('goal', e.target.value)} placeholder="none" />
                  </label>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>Better when</span>
                    <select value={metric.direction} onChange={(e) => setMetricField('direction', e.target.value)}>
                      <option value="higher">Higher</option>
                      <option value="lower">Lower</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Graph</span>
                    <select value={metric.chart} onChange={(e) => setMetricField('chart', e.target.value)}>
                      <option value="line">Line</option>
                      <option value="bar">Bars</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Decimals</span>
                    <select value={metric.decimals} onChange={(e) => setMetricField('decimals', e.target.value)}>
                      <option value="0">0</option>
                      <option value="1">0.0</option>
                      <option value="2">0.00</option>
                    </select>
                  </label>
                </div>
                <label className="field">
                  <span>Filled by</span>
                  <select value={metric.source} onChange={(e) => setMetricField('source', e.target.value)}>
                    <option value="manual">Me (or Totem, when I tell it)</option>
                    <option value="whoop-sleep">WHOOP sleep sync</option>
                  </select>
                </label>
                {metric.source === 'whoop-sleep' && (
                  <span className="habit-field-hint">
                    A scheduled job pulls last night's sleep performance and stages from the WHOOP API each late
                    morning (Studio → Workflows → WHOOP sleep sync). Nights you've already filled in are left alone.
                  </span>
                )}
                <label className="field">
                  <span>Breakdown (optional)</span>
                  <input value={metric.parts} onChange={(e) => setMetricField('parts', e.target.value)} placeholder="e.g. Deep, Light, REM, Awake" />
                </label>
                <span className="habit-field-hint">
                  Comma-separated components, logged in the metric's unit and stacked as bars under the line —
                  sleep stages in minutes, say. Leave empty for a single number.
                </span>
                <label className="checkbox-field">
                  <input type="checkbox" checked={metric.pinned} onChange={(e) => setMetricField('pinned', e.target.checked)} />
                  Pin this graph to the Home board
                </label>
              </>
            )}
          </div>
          {initial && (
            <label className="checkbox-field">
              <input type="checkbox" checked={form.archived} onChange={(e) => set('archived', e.target.checked)} />
              Archived (hidden from check-in, history kept)
            </label>
          )}
          <div className="modal-actions">
            {initial && onDelete && (
              <button type="button" className="btn danger" onClick={remove} disabled={Boolean(busy)}>
                <Hi icon={TrashIcon} size={15} /> {busy === 'delete' ? 'Deleting…' : confirmDelete ? 'Really delete history?' : 'Delete'}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" onClick={onClose} disabled={Boolean(busy)}>Cancel</button>
            <button className="btn primary" disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : initial ? 'Save' : 'Add habit'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------- edit one day (tap a grid cell, or the note button in check-in) ----------
// Exported so the Overview's habit card gets the identical note/count editor
// behind its own message button.
export interface DayModalProps {
  habit: Habit
  date: string
  entry: Entry | undefined
  onClose: () => void
  onSave: (fields: DaySave) => Promise<void>
}

export interface DaySave {
  count: number
  note: string
  /** null clears the day's number; undefined leaves it alone. */
  value?: number | null
  parts?: Record<string, number | null>
}

export function DayModal({ habit, date, entry, onClose, onSave }: DayModalProps) {
  const [count, setCount] = useState(entry?.count || 0)
  const [note, setNote] = useState(entry?.note || '')
  // Metric fields stay strings while being typed; '' means "cleared".
  const [value, setValue] = useState(entry?.value != null ? String(entry.value) : '')
  const [parts, setParts] = useState<Record<string, string>>(() =>
    Object.fromEntries((habit.metric?.parts || []).map((p) => [p.key, entry?.parts?.[p.key] != null ? String(entry.parts[p.key]) : ''])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useErrorToast(error)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const fields: DaySave = { count, note: note.trim() }
    if (habit.metric) {
      const trimmed = value.trim()
      if (trimmed && !Number.isFinite(Number(trimmed))) { setError(`${habit.metric.label} must be a number.`); setBusy(false); return }
      fields.value = trimmed ? Number(trimmed) : null
      fields.parts = Object.fromEntries(habit.metric.parts.map((p) => {
        const raw = (parts[p.key] || '').trim()
        return [p.key, raw ? Number(raw) : null]
      }))
      if (Object.values(fields.parts).some((n) => n != null && !Number.isFinite(n))) {
        setError('Breakdown values must be numbers.'); setBusy(false); return
      }
    }
    try { await onSave(fields) } catch (err: any) { setError(err.message); setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="event-modal habit-day-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-kicker"><span className="habit-dot" style={{ background: habit.color }} /> {habit.name}</div>
            <h2>{dayLabel(date)}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>
        <form className="todo-form" onSubmit={save}>
          <div className="field">
            <span>Completions {habit.target > 1 || habit.cadence !== 'daily' ? `(target ${habit.target}/${CADENCE_NOUN[habit.cadence]})` : ''}</span>
            <div className="habit-stepper big">
              <button type="button" className="habit-step" onClick={() => setCount((c) => Math.max(0, c - 1))} disabled={busy || count <= 0} aria-label="One less">
                <Hi icon={MinusIcon} size={18} />
              </button>
              <span className="habit-count" style={count > 0 ? { color: habit.color } : undefined}>{count}</span>
              <button type="button" className="habit-step" onClick={() => setCount((c) => Math.min(999, c + 1))} disabled={busy} aria-label="One more">
                <Hi icon={PlusIcon} size={18} />
              </button>
            </div>
          </div>
          {habit.metric && (
            <>
              <label className="field">
                <span>{habit.metric.label}{habit.metric.unit ? ` (${habit.metric.unit})` : ''}</span>
                <input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Leave empty for none"
                />
              </label>
              {habit.metric.parts.length > 0 && (
                <div className="field">
                  <span>Breakdown{habit.metric.unit ? ` (${habit.metric.unit})` : ''}</span>
                  <div className="habit-parts-grid">
                    {habit.metric.parts.map((p) => (
                      <label key={p.key} className="habit-part-input">
                        <span><span className="habit-dot" style={{ background: p.color }} /> {p.label}</span>
                        <input
                          type="number"
                          step="any"
                          inputMode="decimal"
                          value={parts[p.key] || ''}
                          onChange={(e) => setParts((s) => ({ ...s, [p.key]: e.target.value }))}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <label className="field">
            <span>Note</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="How did it go?" />
          </label>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save day'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------- history grids (daily dots vs weekly/monthly thermometer columns) ----
const GRID_WEEKS = 52
const weekStartsOf = (today: string, weeks = GRID_WEEKS): string[] => {
  const todayDow = dayOfWeek(today)
  return Array.from({ length: weeks }, (_, w) => {
    const offset = -((weeks - 1 - w) * 7 + todayDow)
    return addDays(today, offset)
  })
}

// Month labels aligned to week columns (same logic the dot grid used).
function monthLabelsForWeeks(weekStarts: string[]): { col: number; label: string }[] {
  const labels: { col: number; label: string }[] = []
  let prevMonth = -1
  weekStarts.forEach((ws, col) => {
    const m = toDate(ws).getMonth()
    if (m !== prevMonth) {
      labels.push({ col, label: toDate(ws).toLocaleDateString([], { month: 'short' }) })
      prevMonth = m
    }
  })
  if (labels.length >= 2 && labels[1].col - labels[0].col < 3) labels.shift()
  return labels
}

// ---------- edit a whole week/month (tap a period bar) ----------
// Every day of the period that has actually happened, so past days can be filled
// in after the fact and the notes left on them are all visible in one place.
// Days beyond today are omitted rather than shown disabled — the bridge rejects
// future logs anyway, and an empty row invites a tap that can't work.
interface PeriodModalProps {
  habit: Habit
  start: string
  end: string
  today: string
  entries: Entries
  title: string
  onClose: () => void
  onLog: (fields: { date: string; delta?: number; count?: number; note?: string }) => Promise<void>
}

function PeriodModal({ habit, start, end, today, entries, title, onClose, onLog }: PeriodModalProps) {
  const [busyDate, setBusyDate] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The note being typed, keyed by date, so a half-typed note isn't clobbered by
  // the refreshed payload that a count change pushes back in.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  useErrorToast(error)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const days: string[] = []
  for (let d = start; d <= end && d <= today; d = addDays(d, 1)) days.push(d)

  const total = days.reduce((sum, d) => sum + (entries[d]?.[habit.id]?.count || 0), 0)
  const gauge = periodGauge(habit.target, total)

  const run = async (date: string, fields: { delta?: number; count?: number; note?: string }): Promise<boolean> => {
    setBusyDate(date)
    setError(null)
    try {
      await onLog({ date, ...fields })
      return true
    } catch (e: any) {
      setError(e.message)
      return false
    } finally {
      setBusyDate(null)
    }
  }

  const dropDraft = (date: string) => setDrafts(({ [date]: _drop, ...rest }) => rest)

  // Notes save on blur; skip the round trip when nothing actually changed, and
  // hold onto the draft if the save fails so the typing isn't thrown away.
  const commitNote = async (date: string) => {
    const draft = drafts[date]
    if (draft === undefined) return
    if (draft.trim() === (entries[date]?.[habit.id]?.note || '')) return dropDraft(date)
    if (await run(date, { note: draft.trim() })) dropDraft(date)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="event-modal habit-period-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-kicker"><span className="habit-dot" style={{ background: habit.color }} /> {habit.name}</div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>

        <div className="habit-period-summary">
          <span className="habit-period-bar">
            {gauge.ratio > 0 && (
              <span className="habit-period-bar-fill" style={{ width: `${gauge.ratio * 100}%`, background: habit.color }} />
            )}
          </span>
          <span className="habit-period-total" style={gauge.met ? { color: habit.color } : undefined}>
            {total}/{habit.target} {periodLabel(habit.cadence)}
          </span>
        </div>

        <div className="habit-period-days">
          {days.map((date) => {
            const entry = entries[date]?.[habit.id]
            const count = entry?.count || 0
            const busy = busyDate === date
            return (
              <div key={date} className={`habit-day-row${count > 0 ? ' done' : ''}${date === today ? ' today' : ''}`}>
                <div className="habit-day-when">
                  <span className="habit-day-dow">{toDate(date).toLocaleDateString([], { weekday: 'short' })}</span>
                  <span className="habit-day-num">{toDate(date).getDate()}</span>
                </div>
                <input
                  className="habit-day-note"
                  value={drafts[date] ?? entry?.note ?? ''}
                  placeholder={count > 0 ? 'Add a note…' : 'Not done — note why?'}
                  onChange={(e) => setDrafts((d) => ({ ...d, [date]: e.target.value }))}
                  onBlur={() => { void commitNote(date) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                />
                <div className="habit-stepper">
                  <button
                    type="button"
                    className="habit-step"
                    onClick={() => run(date, { delta: -1 })}
                    disabled={busy || count <= 0}
                    aria-label={`One less on ${dayLabel(date)}`}
                  ><Hi icon={MinusIcon} size={15} /></button>
                  <span className="habit-count" style={count > 0 ? { color: habit.color } : undefined}>{count}</span>
                  <button
                    type="button"
                    className="habit-step"
                    onClick={() => run(date, { delta: +1 })}
                    disabled={busy}
                    aria-label={`One more on ${dayLabel(date)}`}
                  ><Hi icon={PlusIcon} size={15} /></button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="modal-actions">
          <span className="muted habit-period-hint">Notes save when you click away.</span>
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

// Weekly/monthly quota as a thermometer: one unbroken tube per period, the same
// height as the daily grid, filled bottom-up by `count / target`. No segments —
// the fill position itself carries the progress.
// A logged completion always shows at least this much of the tube, and an unmet
// period always leaves this much empty at the top, so "nearly there" never looks
// identical to "done".
const MIN_BAR_FILL = 0.07

interface Gauge {
  /** Filled share of the tube, 0–1. */
  ratio: number
  met: boolean
}

function periodGauge(target: number, count: number): Gauge {
  const t = Math.max(1, target)
  const met = count >= t
  const ratio = met ? 1
    : count > 0 ? Math.min(1 - MIN_BAR_FILL, Math.max(MIN_BAR_FILL, count / t))
    : 0
  return { ratio, met }
}

// Inline quota readout for the check-in list and card headers — the same bar,
// laid on its side to sit in a row. `compact` drops the bar for rows whose check
// button already draws the period as a pie.
export function QuotaDots({ habit, count, compact }: { habit: Habit; count: number; compact?: boolean }) {
  const gauge = periodGauge(habit.target, count)
  const label = `${count} of ${habit.target} ${periodLabel(habit.cadence)}`
  return (
    <span className={`habit-quota${gauge.met ? ' met' : ''}`} title={label} aria-label={label}>
      {!compact && (
        <span className="habit-quota-bar">
          {gauge.ratio > 0 && (
            <span className="habit-quota-fill" style={{ width: `${gauge.ratio * 100}%`, background: habit.color }} />
          )}
        </span>
      )}
      <span className="habit-quota-num" style={gauge.met ? { color: habit.color } : undefined}>
        {count}/{habit.target} {habit.cadence === 'weekly' ? 'wk' : 'mo'}
      </span>
    </span>
  )
}

// Inline number entry for a habit that carries a metric. Typing is local until
// blur/Enter so a refreshed payload can't clobber a half-typed number, and only
// a real change is sent.
export function HabitMetricInput({ habit, entry, busy, onValue }: {
  habit: Habit
  entry: Entry | undefined
  busy: boolean
  onValue: (habit: Habit, value: number | null) => void
}) {
  const metric = habit.metric!
  const [draft, setDraft] = useState<string | null>(null)
  const saved = entry?.value != null ? String(entry.value) : ''
  const shown = draft ?? saved

  const commit = () => {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)
    if (text && !Number.isFinite(Number(text))) return
    const next = text ? Number(text) : null
    if (next === (entry?.value ?? null)) return
    onValue(habit, next)
  }

  return (
    <span className="habit-metric-input" title={`${metric.label}${metric.unit ? ` (${metric.unit})` : ''}`}>
      <input
        type="number"
        step="any"
        inputMode="decimal"
        value={shown}
        placeholder="—"
        disabled={busy}
        aria-label={`${metric.label} for ${habit.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
        style={shown ? { color: habit.color } : undefined}
      />
      {metric.unit && <small>{metric.unit}</small>}
    </span>
  )
}

// The one big round toggle at the end of a check-in row.
// Daily habits fill solid the moment they're logged. Capped weekly/monthly ones
// fill as a pie — one slice per completion in the period — so the button only
// goes fully solid once the whole quota is met. The check mark is about *today*:
// it shows as soon as the day is logged, on top of whatever slice is filled.
interface HabitCheckButtonProps {
  habit: Habit
  /** Completions logged on the day being checked in. */
  count: number
  /** Completions in the whole cadence period (day / week / month). */
  periodCount: number
  busy: boolean
  onLog: (habit: Habit, delta: number) => void
}

export function HabitCheckButton({ habit, count, periodCount, busy, onLog }: HabitCheckButtonProps) {
  const capped = habit.cadence !== 'daily'
  const target = Math.max(1, habit.target)
  const ratio = capped ? Math.min(1, periodCount / target) : count > 0 ? 1 : 0
  const full = ratio >= 1
  const done = count > 0

  const progress = capped ? `, ${periodCount} of ${target} ${periodLabel(habit.cadence)}` : ''
  const label = done ? `${habit.name}: done — tap to undo${progress}` : `Mark ${habit.name} done${progress}`

  return (
    <button
      className={`habit-check${done ? ' on' : ''}${capped ? ' pie' : ''}${full ? ' full' : ''}`}
      style={{ '--habit-color': habit.color, '--habit-pie': `${ratio * 360}deg` } as React.CSSProperties}
      onClick={() => onLog(habit, done ? -1 : +1)}
      disabled={busy}
      aria-label={label}
      title={done ? 'Done — tap to undo' : 'Mark done'}
    >
      {done && <Hi icon={CheckIcon} size={20} />}
    </button>
  )
}

interface MonthSegment { ym: string; label: string; weekCols: number; start: string; end: string }

function monthSegmentsFromWeeks(weekStarts: string[], today: string): MonthSegment[] {
  const segs: MonthSegment[] = []
  weekStarts.forEach((ws) => {
    const ym = ws.slice(0, 7)
    const last = segs[segs.length - 1]
    if (last?.ym === ym) {
      last.weekCols++
      last.end = addDays(ws, 6)
    } else {
      segs.push({
        ym,
        label: toDate(`${ym}-01`).toLocaleDateString([], { month: 'short' }),
        weekCols: 1,
        start: ws,
        end: addDays(ws, 6),
      })
    }
  })
  // Clip ends to today and the real calendar-month boundary.
  return segs.map((s) => {
    const [y, m] = s.ym.split('-').map(Number)
    const monthEnd = toISO(new Date(y, m, 0))
    let end = s.end > monthEnd ? monthEnd : s.end
    if (end > today) end = today
    return { ...s, end }
  })
}

// Month captions above a grid. `style` overrides the default 52-week track sizing
// for grids whose columns are periods rather than weeks.
function MonthLabelRow({ labels, style }: { labels: { col: number; label: string; span?: number }[]; style?: React.CSSProperties }) {
  return (
    <div className="habit-months" style={style}>
      {labels.map((m) => (
        <span key={`${m.label}-${m.col}`} style={{ gridColumn: `${m.col + 1} / span ${m.span ?? 3}` }}>{m.label}</span>
      ))}
    </div>
  )
}

function useGridScroller() {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])
  return scroller
}

interface HabitGridProps {
  habit: Habit
  entries: Entries
  today: string
  /** Daily grids open one day. */
  onPick: (date: string) => void
  /** Weekly/monthly bars open the whole period, day by day. */
  onPickPeriod: (period: { start: string; end: string; title: string }) => void
}

// Daily habits: GitHub-style day dots (unchanged).
function HabitDayGrid({ habit, entries, today, onPick }: HabitGridProps) {
  const scroller = useGridScroller()

  const { cells, monthLabels } = useMemo(() => {
    const todayDow = dayOfWeek(today)
    const cells: { date: string; future: boolean }[] = []
    const labels = monthLabelsForWeeks(weekStartsOf(today))
    for (let w = 0; w < GRID_WEEKS; w++) {
      for (let d = 0; d < 7; d++) {
        const offset = -((GRID_WEEKS - 1 - w) * 7 + todayDow - d)
        cells.push({ date: addDays(today, offset), future: offset > 0 })
      }
    }
    return { cells, monthLabels: labels }
  }, [today])

  return (
    <div className="habit-grid-scroll" ref={scroller}>
      <div className="habit-grid-inner">
        <MonthLabelRow labels={monthLabels} />
        <div className="habit-grid" role="grid" aria-label={`${habit.name} daily history`}>
          {cells.map(({ date, future }) => {
            if (future) return <span key={date} className="habit-cell future" />
            const e = entries[date]?.[habit.id]
            const level = levelOf(e?.count || 0, habit.target)
            const title = `${dayLabel(date)}: ${e?.count || 0}×${e?.note ? ` — ${e.note}` : ''}`
            return (
              <button
                key={date}
                className={`habit-cell l${level} ${date === today ? 'today' : ''} ${e?.note ? 'noted' : ''}`}
                style={cellStyle(habit.color, level)}
                title={title}
                aria-label={title}
                onClick={() => onPick(date)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

// One period per column, each column a tube that fills bottom-up. Shared by the
// weekly and monthly grids — they differ only in how the periods are sliced and
// how far apart the columns sit.
interface PeriodColumn {
  key: string
  start: string
  end: string
  future: boolean
  count: number
  noted: boolean
  inCurrent: boolean
  label: string
  title: string
}

interface PeriodGridProps extends HabitGridProps {
  columns: PeriodColumn[]
  labels: { col: number; label: string; span?: number }[]
  /** Gap between period columns; months sit further apart than weeks. */
  columnGap?: string
}

function HabitPeriodGrid({ habit, onPickPeriod, columns, labels, columnGap }: PeriodGridProps) {
  const scroller = useGridScroller()
  const template = { gridTemplateColumns: `repeat(${columns.length}, var(--hab-cell))`, columnGap }

  return (
    <div className="habit-grid-scroll" ref={scroller}>
      <div className="habit-grid-inner">
        <MonthLabelRow labels={labels} style={template} />
        <div className="habit-period-grid" style={template} role="grid" aria-label={`${habit.name} ${habit.cadence} history`}>
          {columns.map((col, idx) => {
            const gauge = periodGauge(habit.target, col.count)
            return (
              <button
                key={col.key}
                type="button"
                className={`habit-period-col${col.future ? ' future' : ''}${col.inCurrent ? ' current' : ''}${gauge.met ? ' met' : ''}${col.noted ? ' noted' : ''}`}
                style={{ gridColumn: idx + 1, gridRow: '1 / -1' }}
                title={col.title}
                aria-label={col.title}
                disabled={col.future}
                onClick={() => onPickPeriod({ start: col.start, end: col.end, title: col.label })}
              >
                {!col.future && gauge.ratio > 0 && (
                  <span className="habit-bar-fill" style={{ height: `${gauge.ratio * 100}%`, background: habit.color }} />
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// Weekly habits: one column per Sun–Sat week, on the same 52-column footprint
// (and the same month labels) as the daily dot grid.
function HabitWeekGrid(props: HabitGridProps) {
  const { habit, entries, today } = props
  const { columns, labels } = useMemo(() => {
    const weekStarts = weekStartsOf(today)
    const columns = weekStarts.map((weekStart) => {
      const weekEnd = addDays(weekStart, 6)
      const future = weekStart > today
      const count = future ? 0 : periodTotal(habit, entries, weekStart)
      let noted = false
      if (!future) {
        for (let i = 0; i < 7; i++) {
          if (entries[addDays(weekStart, i)]?.[habit.id]?.note) { noted = true; break }
        }
      }
      return {
        key: weekStart,
        start: weekStart,
        end: weekEnd,
        future,
        count,
        noted,
        inCurrent: today >= weekStart && today <= weekEnd,
        label: `Week of ${dayLabel(weekStart)}`,
        title: future
          ? `Week of ${dayLabel(weekStart)}`
          : `Week of ${dayLabel(weekStart)}: ${count}/${habit.target}${count >= habit.target ? ' ✓' : ''}`,
      }
    })
    return { columns, labels: monthLabelsForWeeks(weekStarts).map((m) => ({ ...m, span: 3 })) }
  }, [habit, entries, today])

  return <HabitPeriodGrid {...props} columns={columns} labels={labels} />
}

// Monthly habits: one column per calendar month, spaced out so a year reads as
// twelve distinct stacks rather than one dense band.
function HabitMonthGrid(props: HabitGridProps) {
  const { habit, entries, today } = props
  const { columns, labels } = useMemo(() => {
    const segments = monthSegmentsFromWeeks(weekStartsOf(today), today)
    const columns = segments.map((seg) => {
      const future = seg.start > today
      const count = future ? 0 : periodTotal(habit, entries, seg.start)
      let noted = false
      if (!future) {
        for (const [d, day] of Object.entries(entries)) {
          if (d.startsWith(seg.ym) && day[habit.id]?.note) { noted = true; break }
        }
      }
      return {
        key: seg.ym,
        // Span the whole calendar month, not just the weeks that start inside it,
        // so tapping the column can land on the 1st–5th too.
        start: `${seg.ym}-01`,
        end: seg.end,
        future,
        count,
        noted,
        inCurrent: today.startsWith(seg.ym),
        label: toDate(`${seg.ym}-01`).toLocaleDateString([], { month: 'long', year: 'numeric' }),
        title: future ? seg.label : `${seg.label}: ${count}/${habit.target}${count >= habit.target ? ' ✓' : ''}`,
      }
    })
    return {
      columns,
      labels: columns.map((c, col) => ({ col, span: 1, label: toDate(`${c.key}-01`).toLocaleDateString([], { month: 'short' }) })),
    }
  }, [habit, entries, today])

  return <HabitPeriodGrid {...props} columns={columns} labels={labels} columnGap="16px" />
}

function HabitGrid(props: HabitGridProps) {
  if (props.habit.cadence === 'weekly') return <HabitWeekGrid {...props} />
  if (props.habit.cadence === 'monthly') return <HabitMonthGrid {...props} />
  return <HabitDayGrid {...props} />
}

// ---------- the metric graph under a habit's contribution grid ----------
const METRIC_RANGES = [
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
]

export function HabitMetricSection({ habit, entries, today, compact, days: fixedDays, onSync }: {
  habit: Habit
  entries: Entries
  today: string
  /** Home-board tile: no range switcher, no legend, shorter chart. */
  compact?: boolean
  days?: number
  /** Present on the Habits tab for metrics an importer fills. */
  onSync?: () => Promise<void>
}) {
  const metric = habit.metric!
  const [days, setDays] = useState(fixedDays || 30)
  const [syncing, setSyncing] = useState(false)
  const series = useMemo(() => metricSeries(entries, habit.id, today, days), [entries, habit.id, today, days])
  const stats = useMemo(() => metricStats(series), [series])

  // WHOOP has to be authorized before any sync can work, so the section asks for
  // that itself rather than letting the first Sync fail confusingly.
  const syncable = Boolean(onSync) && !compact
  const { status: whoop, reload: reloadWhoop } = useWhoopStatus(syncable)
  // Anything other than "as far as we know, this works" — a dead grant, a missing
  // scope, never connected, no credentials.
  const needsAttention = Boolean(whoop) && whoop.state !== 'ready'

  return (
    <div className="habit-metric">
      <div className="habit-metric-head">
        <span className="habit-metric-label">{metric.label}</span>
        {!compact && (
          <div className="habit-metric-actions">
            {/* Only when there's something to fix. Safe to gate on now in a way it
                wasn't before: `state` is a real health signal (including a latched
                `needs-reauth` set by the last failed refresh), not the old
                "a token file exists" check that hid this button precisely when the
                grant was dead. The permanent, always-available Reconnect lives in
                Studio → Connections. */}
            {syncable && needsAttention && <WhoopConnectButton status={whoop} onDone={reloadWhoop} />}
            {onSync && (
              <button
                className="btn compact"
                disabled={syncing}
                title="Pull the last few nights from WHOOP now"
                onClick={async () => {
                  setSyncing(true)
                  try { await onSync() } finally { setSyncing(false); reloadWhoop() }
                }}
              >
                <Hi icon={ArrowPathIcon} size={14} /> {syncing ? 'Syncing…' : 'Sync'}
              </button>
            )}
            <div className="cal-viewswitch habit-metric-range">
              {METRIC_RANGES.map((r) => (
                <button key={r.days} className={`seg ${days === r.days ? 'active' : ''}`} onClick={() => setDays(r.days)}>{r.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      {syncable && <WhoopStatusNote status={whoop} />}
      <MetricStatsStrip metric={metric} stats={stats} color={habit.color} />
      <MetricChart metric={metric} series={series} color={habit.color} height={compact ? 120 : 160} compact={compact} />
    </div>
  )
}

// ---------- one habit in the nightly check-in list ----------
interface CheckRowProps {
  habit: Habit
  entry: Entry | undefined
  periodCount: number // completions in this row's day/week/month, per cadence
  busy: boolean
  onLog: (habit: Habit, delta: number) => void
  onValue: (habit: Habit, value: number | null) => void
  onNote: (habit: Habit) => void
  dragging?: boolean
  dropTarget?: boolean
  onDragStart: (id: string) => void
  onDragOver: (id: string) => void
  onDrop: (id: string) => void
  onDragEnd: () => void
}

function CheckRow({ habit, entry, periodCount, busy, onLog, onValue, onNote, dragging, dropTarget, onDragStart, onDragOver, onDrop, onDragEnd }: CheckRowProps) {
  const count = entry?.count || 0
  const done = periodCount >= habit.target
  return (
    <div
      className={`habit-row ${done ? 'done' : ''} ${dragging ? 'dragging' : ''} ${dropTarget ? 'drop-target' : ''}`}
      onDragOver={(e) => { e.preventDefault(); onDragOver(habit.id) }}
      onDrop={(e) => { e.preventDefault(); onDrop(habit.id) }}
    >
      <button
        type="button"
        className="habit-drag-handle"
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(habit.id) }}
        onDragEnd={onDragEnd}
        aria-label={`Move ${habit.name}`}
        title="Drag to reorder"
      ><Hi icon={Bars3Icon} size={17} /></button>
      <span className="habit-dot" style={{ background: habit.color }} />
      <div className="habit-row-main">
        <div className="habit-row-name">{habit.name}</div>
        {(entry?.note || habit.description) && (
          <div className="habit-row-sub">{entry?.note || habit.description}</div>
        )}
      </div>
      {habit.cadence !== 'daily' && <QuotaDots habit={habit} count={periodCount} compact />}
      {habit.metric && <HabitMetricInput habit={habit} entry={entry} busy={busy} onValue={onValue} />}
      <button
        className={`icon-btn habit-note-btn ${entry?.note ? 'has-note' : ''}`}
        title={entry?.note ? `Note: ${entry.note}` : 'Add a note'}
        onClick={() => onNote(habit)}
      >
        <Hi icon={ChatBubbleLeftEllipsisIcon} size={17} />
      </button>
      {habit.cadence === 'daily' && habit.target > 1 ? (
        <div className="habit-stepper">
          <button className="habit-step" onClick={() => onLog(habit, -1)} disabled={busy || count <= 0} aria-label={`Undo one ${habit.name}`}>
            <Hi icon={MinusIcon} size={16} />
          </button>
          <span className="habit-count" style={count > 0 ? { color: habit.color } : undefined}>
            {count}<small>/{habit.target}</small>
          </span>
          <button className="habit-step" onClick={() => onLog(habit, +1)} disabled={busy} aria-label={`Log one ${habit.name}`}>
            <Hi icon={PlusIcon} size={16} />
          </button>
        </div>
      ) : (
        <HabitCheckButton habit={habit} count={count} periodCount={periodCount} busy={busy} onLog={onLog} />
      )}
    </div>
  )
}

// ---------- the view ----------
interface HabitsViewProps { onAuthError: () => void }

type Modal =
  | { type: 'add' }
  | { type: 'edit'; habit: Habit }
  | { type: 'day'; habit: Habit; date: string }
  | { type: 'period'; habit: Habit; start: string; end: string; title: string }
  | null

export default function HabitsView({ onAuthError }: HabitsViewProps) {
  const [data, setData] = useState<HabitsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useErrorToast(error)
  const [checkinDay, setCheckinDay] = useState<'today' | 'yesterday'>('today')
  const [modal, setModal] = useState<Modal>(null)
  // `g h h` — lands on Habits, then opens the new-habit dialog.
  useCommand(COMMANDS.habitNew, () => setModal({ type: 'add' }))
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const auth = useCallback((e: unknown) => { if (e instanceof AuthError) { onAuthError(); return true } return false }, [onAuthError])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setData(await getHabits()) } catch (e: any) { if (!auth(e)) setError(e.message) } finally { setLoading(false) }
  }, [auth])

  useEffect(() => { load() }, [load])

  const active = (data?.habits || []).filter((h) => !h.archived)
  const archived = (data?.habits || []).filter((h) => h.archived)
  const today = data?.today || ''
  const checkinDate = checkinDay === 'today' ? today : addDays(today, -1)

  const guard = <T,>(p: Promise<T>): Promise<T> =>
    p.catch((e) => { if (e instanceof AuthError) { onAuthError(); return Promise.reject(new Error('Session expired')) } throw e })

  // One-tap logging from the check-in list. The bridge write is local-disk fast,
  // so we just swap in the refreshed payload it returns; a per-habit busy flag
  // stops double-taps from racing.
  const logDelta = async (habit: Habit, delta: number) => {
    const key = `${habit.id}:${checkinDate}`
    if (busyKeys[key]) return
    setBusyKeys((b) => ({ ...b, [key]: true }))
    try {
      setData(await guard(logHabit({ id: habit.id, date: checkinDate, delta })))
      if (delta < 0) pushToast(`Undid ${habit.name}.`, 'info', { duration: 2500 })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusyKeys((b) => ({ ...b, [key]: false }))
    }
  }

  // Logging the habit's number from the check-in row. A number is evidence the
  // habit happened, so it ticks the day off too (`complete`); clearing it back
  // out leaves the check alone.
  const logValue = async (habit: Habit, value: number | null) => {
    const key = `${habit.id}:${checkinDate}`
    if (busyKeys[key]) return
    setBusyKeys((b) => ({ ...b, [key]: true }))
    try {
      setData(await guard(logHabit({ id: habit.id, date: checkinDate, value, complete: value !== null })))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusyKeys((b) => ({ ...b, [key]: false }))
    }
  }

  // Pull the last few nights from WHOOP on demand. Nights already filled in are
  // left alone by the bridge, so this is safe to mash.
  const syncSleepNow = async () => {
    try {
      const result = await guard(syncSleep())
      if (result.habits) setData(result.habits)
      const n = result.updated?.length || 0
      pushToast(
        n ? `Synced ${n} night${n === 1 ? '' : 's'} from WHOOP.` : 'WHOOP had nothing new to add.',
        n ? 'success' : 'info',
      )
      for (const e of result.errors || []) setError(String(e))
    } catch (e: any) {
      setError(e.message)
    }
  }

  const totalFor = (habit: Habit) => {
    let total = 0
    for (const day of Object.values(data?.entries || {})) total += day[habit.id]?.count || 0
    return total
  }

  const moveHabit = async (targetId: string) => {
    if (!draggedId || draggedId === targetId || !data) { setDraggedId(null); setDropTargetId(null); return }
    const current = data.habits
    const from = current.findIndex((h) => h.id === draggedId)
    const to = current.findIndex((h) => h.id === targetId)
    if (from < 0 || to < 0) return
    const reordered = [...current]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    setData({ ...data, habits: reordered })
    setDraggedId(null)
    setDropTargetId(null)
    try {
      setData(await guard(reorderHabits(reordered.filter((h) => !h.archived).map((h) => h.id))))
    } catch (e: any) {
      setData(data)
      setError(e.message)
    }
  }

  return (
    <div className="view habits-view">
      <div className="view-head">
        <h1>Habits {active.length ? <span className="muted">· {active.length}</span> : null}</h1>
        <div className="todo-head-actions">
          <button className="btn compact" onClick={load} title="Refresh"><Hi icon={ArrowPathIcon} size={15} /></button>
          <button className="btn primary compact" onClick={() => setModal({ type: 'add' })}>
            <Hi icon={PlusIcon} size={16} /> New
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="spinner">Loading…</div>
      ) : !active.length ? (
        <div className="empty">
          No habits yet. Add one here, or just tell Totem — “track a reading habit for me”.
        </div>
      ) : (
        <>
          {/* Nightly check-in: go through the day in retrospect and tap off what happened. */}
          <div className="card habit-checkin">
            <div className="habit-checkin-head">
              <div>
                <div className="habit-checkin-title">Check-in</div>
                <div className="habit-checkin-sub">{dayLabel(checkinDate)}</div>
              </div>
              <div className="cal-viewswitch habit-dayswitch">
                <button className={`seg ${checkinDay === 'yesterday' ? 'active' : ''}`} onClick={() => setCheckinDay('yesterday')}>Yesterday</button>
                <button className={`seg ${checkinDay === 'today' ? 'active' : ''}`} onClick={() => setCheckinDay('today')}>Today</button>
              </div>
            </div>
            {active.map((h) => (
              <CheckRow
                key={h.id}
                habit={h}
                entry={data?.entries[checkinDate]?.[h.id]}
                periodCount={data ? periodTotal(h, data.entries, checkinDate) : 0}
                busy={Boolean(busyKeys[`${h.id}:${checkinDate}`])}
                onLog={logDelta}
                onValue={logValue}
                onNote={(habit) => setModal({ type: 'day', habit, date: checkinDate })}
                dragging={draggedId === h.id}
                dropTarget={Boolean(draggedId && dropTargetId === h.id && draggedId !== h.id)}
                onDragStart={setDraggedId}
                onDragOver={setDropTargetId}
                onDrop={moveHabit}
                onDragEnd={() => { setDraggedId(null); setDropTargetId(null) }}
              />
            ))}
          </div>

          {/* One contribution grid per habit. */}
          {active.map((h) => {
            const streak = data ? streakOf(h, data.entries, today) : 0
            return (
              <div key={h.id} className="card habit-card">
                <div className="habit-card-head">
                  <span className="habit-dot" style={{ background: h.color }} />
                  <span className="habit-card-name">{h.name}</span>
                  <span className="habit-card-stats">
                    {streak > 1 && (
                      <span className="habit-streak" title={`Current streak (${CADENCE_NOUN[h.cadence]}s)`}>
                        <Hi icon={FireIcon} size={13} /> {streak}{h.cadence === 'weekly' ? ' wk' : h.cadence === 'monthly' ? ' mo' : ''}
                      </span>
                    )}
                    {h.cadence !== 'daily' && <QuotaDots habit={h} count={periodTotal(h, data!.entries, today)} />}
                    <span className="muted">{totalFor(h)} in the last year</span>
                  </span>
                  <button className="icon-btn" title="Edit habit" onClick={() => setModal({ type: 'edit', habit: h })}>
                    <Hi icon={PencilSquareIcon} size={16} />
                  </button>
                </div>
                <HabitGrid
                  habit={h}
                  entries={data!.entries}
                  today={today}
                  onPick={(date) => setModal({ type: 'day', habit: h, date })}
                  onPickPeriod={({ start, end, title }) => setModal({ type: 'period', habit: h, start, end, title })}
                />
                {h.metric && (
                  <HabitMetricSection
                    habit={h}
                    entries={data!.entries}
                    today={today}
                    onSync={h.metric.source === 'whoop-sleep' ? syncSleepNow : undefined}
                  />
                )}
              </div>
            )
          })}
        </>
      )}

      {archived.length > 0 && (
        <div className="habit-archived">
          <button className="link-btn" style={{ margin: 0 }} onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </button>
          {showArchived && (
            <div className="card">
              {archived.map((h) => (
                <div key={h.id} className="habit-row archived">
                  <span className="habit-dot" style={{ background: h.color }} />
                  <div className="habit-row-main"><div className="habit-row-name">{h.name}</div></div>
                  <button
                    className="btn compact"
                    onClick={async () => { try { setData(await guard(updateHabit(h.id, { archived: false }))) } catch (e: any) { setError(e.message) } }}
                  >
                    <Hi icon={ArchiveBoxIcon} size={14} /> Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {modal?.type === 'add' && data && (
        <HabitFormModal
          palette={data.palette}
          usedColors={data.habits.map((h) => h.color)}
          onClose={() => setModal(null)}
          onSubmit={async (fields) => { setData(await guard(createHabit(fields))); setModal(null) }}
        />
      )}

      {modal?.type === 'edit' && data && (
        <HabitFormModal
          initial={modal.habit}
          palette={data.palette}
          usedColors={data.habits.map((h) => h.color)}
          onClose={() => setModal(null)}
          onSubmit={async (fields) => { setData(await guard(updateHabit(modal.habit.id, fields))); setModal(null) }}
          onDelete={async () => { setData(await guard(deleteHabit(modal.habit.id))); setModal(null) }}
        />
      )}

      {modal?.type === 'day' && data && (
        <DayModal
          habit={modal.habit}
          date={modal.date}
          entry={data.entries[modal.date]?.[modal.habit.id]}
          onClose={() => setModal(null)}
          onSave={async ({ count, note, value, parts }) => {
            setData(await guard(logHabit({ id: modal.habit.id, date: modal.date, count, note, value, parts })))
            setModal(null)
          }}
        />
      )}

      {/* Stays open across edits: each day logs immediately and swaps in the
          refreshed payload, so the running period total updates underneath. */}
      {modal?.type === 'period' && data && (
        <PeriodModal
          habit={modal.habit}
          start={modal.start}
          end={modal.end}
          today={today}
          entries={data.entries}
          title={modal.title}
          onClose={() => setModal(null)}
          onLog={async (fields) => { setData(await guard(logHabit({ id: modal.habit.id, ...fields }))) }}
        />
      )}
    </div>
  )
}
