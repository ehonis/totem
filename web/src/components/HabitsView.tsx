import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  getHabits, createHabit, reorderHabits, updateHabit, deleteHabit, logHabit,
  syncSleep, AuthError,
} from '../api'
import { useWhoopStatus, WhoopBushidoLink, WhoopStatusNote } from './WhoopConnection'
import { COMMANDS } from '../shortcuts'
import { useCommand } from '../useShortcuts'
import {
  Hi, PlusIcon, MinusIcon, ArrowPathIcon, XMarkIcon, TrashIcon,
  PencilSquareIcon, CheckIcon, ChatBubbleLeftEllipsisIcon, FireIcon, ArchiveBoxIcon, Bars3Icon, ArrowTopRightOnSquareIcon,
  ChevronLeftIcon, ChevronRightIcon, ChevronDownIcon, ChatBubbleLeftRightIcon, MoonIcon, SunIcon, CheckBadgeSolidIcon,
} from '../icons'
import { foldGroups, flattenTree, groupProgress, groupToggle, groupWords, habitTree, handLogged, rowDone } from '../habits/groups'
import { startChatAbout } from '../chat/about/start'
import '../habits/habits.css'
import { useErrorToast, pushToast } from '../toast'
import { OPEN_HABIT_CHECKIN } from './HabitCheckin'
import ChatAbout from '../chat/about/ChatAbout'
import { habitContext } from '../chat/about/context'
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
  /** When it is answered: 'night' habits are done late and logged the next morning. */
  when?: HabitWhen
  /** A sibling app fills it in (Krakatoa, Bushido); it is never ticked by hand here. */
  linkedApp?: LinkedApp | null
  /** That app's address, from the bridge's env. */
  appUrl?: string | null
  /** The group it sits under (web/src/habits/groups.ts); one level deep. */
  parentId?: string | null
  createdAt: string
  archived: boolean
}

type HabitWhen = 'any' | 'morning' | 'night'
type LinkedApp = 'krakatoa' | 'bushido'
const APP_NAME: Record<LinkedApp, string> = { krakatoa: 'Krakatoa', bushido: 'Bushido' }

/** In place of a check mark or a number box: where the habit is really logged. */
export function LinkedAppButton({ habit, compact }: { habit: Pick<Habit, 'linkedApp' | 'appUrl' | 'name'>; compact?: boolean }) {
  const name = APP_NAME[habit.linkedApp as LinkedApp] || 'its app'
  if (!habit.appUrl) {
    return <span className="habit-linked off" title={`${habit.name} is filled in by ${name}; set ${habit.linkedApp?.toUpperCase()}_URL to link to it`}>From {name}</span>
  }
  return (
    <a className="habit-linked" href={habit.appUrl} target="_blank" rel="noreferrer" title={`${habit.name} is filled in by ${name}`}>
      {compact ? name : `Open ${name}`}<Hi icon={ArrowTopRightOnSquareIcon} size={13} />
    </a>
  )
}

// The WHOOP-synced sleep habit isn't shown here or on the Overview: nobody logs
// it by hand, and Bushido is where it is read. The habit, its nightly sync and its
// history stay in the habit store, so agents and search still see every night.
// Bushido reads WHOOP itself; it holds the grant.
export const isSyncedSleep = (h: { metric?: { source?: string } | null }) => h.metric?.source === 'whoop-sleep'

interface Entry { count: number; skipped?: boolean; note?: string; value?: number | null; parts?: Record<string, number> }
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
  /** Habits this one may sit under: active, top-level, filled by hand. */
  parents?: Habit[]
  /** The group a new habit starts in. */
  defaultParent?: string | null
  /** It is a group already, so it cannot go under another habit. */
  hasChildren?: boolean
  /** Close this and start a new habit inside it. */
  onAddSub?: () => void
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

function HabitFormModal({ initial, palette, usedColors, onClose, onSubmit, onDelete, parents = [], defaultParent = null, hasChildren = false, onAddSub }: HabitFormModalProps) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    description: initial?.description || '',
    cadence: (initial?.cadence || 'daily') as Cadence,
    target: initial?.target || 1,
    color: initial?.color || '', // '' = auto-assign on create
    archived: initial?.archived || false,
    when: (initial?.when || 'any') as HabitWhen,
    linkedApp: (initial?.linkedApp || '') as LinkedApp | '',
    parentId: (initial ? initial.parentId : defaultParent) || '',
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
        when: form.when,
        linkedApp: form.linkedApp || null,
      }
      // Only when it changed: a sub-habit of an archived group arrives with no parent
      // (the bridge lets it out until the group returns), and saving that back would
      // detach it for good.
      const parentNow = form.parentId || null
      if (parentNow !== ((initial && initial.parentId) || null)) fields.parentId = parentNow
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
            <div className="modal-kicker">{initial ? (hasChildren ? 'Edit group' : 'Edit habit') : 'New habit'}</div>
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
          {hasChildren ? (
            <div className="habit-group-note">
              <span>
                {initial?.name} is a group: it is done for a day when all its sub-habits are, and its check marks the ones you tick by hand (an app fills in its own).
              </span>
              {onAddSub && <button type="button" className="pk-btn pk-compact" onClick={onAddSub}><Hi icon={PlusIcon} size={14} /> Add a sub-habit</button>}
            </div>
          ) : parents.length > 0 || form.parentId ? (
            <label className="field">
              <span>Part of</span>
              <select value={form.parentId} onChange={(e) => set('parentId', e.target.value)}>
                <option value="">Nothing, a habit of its own</option>
                {parents.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
              <span className="habit-field-hint">
                {form.parentId
                  ? 'A sub-habit: it shows inside that habit, which becomes a group if it is not one yet: done for the day once all of its sub-habits are, its own check and history set aside.'
                  : 'Put it under another habit to group them, e.g. sleep hygiene under a nightly routine.'}
              </span>
            </label>
          ) : null}
          {/* A group's day is its sub-habits': how often, when, who fills it and a number are theirs. */}
          {!hasChildren && (<>
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
            <div className="field-row">
              <label className="field">
                <span>When</span>
                <select value={form.when} onChange={(e) => set('when', e.target.value as HabitWhen)}>
                  <option value="any">Any time</option>
                  <option value="morning">Morning</option>
                  <option value="night">Night, logged next morning</option>
                </select>
              </label>
              <label className="field">
                <span>Filled by</span>
                <select value={form.linkedApp} onChange={(e) => set('linkedApp', e.target.value)}>
                  <option value="">Me</option>
                  <option value="krakatoa">Krakatoa</option>
                  <option value="bushido">Bushido</option>
                </select>
              </label>
            </div>
            <span className="habit-field-hint">
              {form.linkedApp
                ? `${APP_NAME[form.linkedApp as LinkedApp]} fills this in on its own; here it links to the app instead of a check mark.`
                : form.when === 'night'
                  ? 'The morning check-in asks about it the next day and logs it to the night before.'
                  : form.when === 'morning'
                    ? 'The morning check-in asks about it for that day.'
                    : 'The morning check-in asks about it if yesterday went unanswered.'}
            </span>
            <span className="habit-field-hint">
              {form.cadence === 'daily'
                ? '1 = simple yes/no. Higher (e.g. 8 glasses of water) shades the day darker the closer you get.'
                : `e.g. gym 3× a week, or deep-clean once a month. You still check it off on the day you do it; the check-in shows ${periodLabel(form.cadence)}’s progress.`}
            </span>
          </>)}
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
          {!hasChildren && (<>
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
                      A scheduled job pulls last night's sleep performance and stages from WHOOP (through Bushido) each late
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
          </>)}
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
  if (habit.linkedApp) {
    return (
      <span className="habit-metric-input readonly" title={`${metric.label}, from ${APP_NAME[habit.linkedApp]}`}>
        <span style={entry?.value != null ? { color: habit.color } : undefined}>{entry?.value != null ? entry.value.toLocaleString() : '—'}</span>
        {metric.unit && <small>{metric.unit}</small>}
      </span>
    )
  }
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

  // An app fills this one in: the same circle, filling as it does, but not a
  // button; the link beside it goes to the app.
  if (habit.linkedApp) {
    const name = APP_NAME[habit.linkedApp]
    return (
      <span className="habit-linked-pair">
        <LinkedAppButton habit={habit} compact />
        <span
          className={`habit-check readonly${done ? ' on' : ''}${capped ? ' pie' : ''}${full ? ' full' : ''}`}
          style={{ '--habit-color': habit.color, '--habit-pie': `${ratio * 360}deg` } as React.CSSProperties}
          role="img"
          aria-label={`${habit.name}: ${done ? 'done' : 'not yet'}${progress}, from ${name}`}
          title={done ? `Done, from ${name}` : `Not yet; ${name} fills this in`}
        >
          {done && <Hi icon={CheckIcon} size={20} />}
        </span>
      </span>
    )
  }

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

  // WHOOP has to be connected (in Bushido) before any sync can work, so the
  // section says so itself rather than letting the first Sync fail confusingly.
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
                grant was dead. The grant is Bushido's, so this links there; the
                permanent link lives in Settings → Connections. */}
            {syncable && needsAttention && <WhoopBushidoLink status={whoop} />}
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

// ---------- the page, drawn as the iPhone app draws it ----------
// mobile/src/features/productivity/HabitsView.tsx and features/habits/{TodayPanel,
// HabitRow}.tsx: a Today card (the day being answered, a bar that fills per row,
// Check in and New), then one card per habit: tick the day on the right, open the
// card for its history. A group (a habit with sub-habits, web/src/habits/groups.ts)
// is one card holding its sub-habits' rows; its own check marks them all.

/** One day in a card's week strip. */
interface StripDay { date: string; letter: string; level: number; skipped: boolean }

function recentDays(habit: Habit, entries: Entries, end: string, days = 7): StripDay[] {
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(end, i - (days - 1))
    const e = entries[date]?.[habit.id]
    const count = e?.count || 0
    return {
      date,
      letter: toDate(date).toLocaleDateString([], { weekday: 'narrow' }),
      // A weekly or monthly habit has no per-day target, so any completion is a full dot.
      level: habit.cadence === 'daily' ? levelOf(count, habit.target) : count > 0 ? 4 : 0,
      skipped: !count && e?.skipped === true,
    }
  })
}

/** Done for the day: a daily habit at its target; a weekly or monthly one logged that day or with its quota met. */
function doneOn(habit: Habit, entries: Entries, date: string): boolean {
  const count = entries[date]?.[habit.id]?.count || 0
  if (habit.cadence === 'daily') return count >= Math.max(1, habit.target)
  return count > 0 || periodTotal(habit, entries, date) >= Math.max(1, habit.target)
}

const nextMonthOf = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** The longest streak in the loaded history, never less than the current one. */
function bestStreakOf(habit: Habit, entries: Entries, today: string): number {
  const current = streakOf(habit, entries, today)
  const logged = Object.keys(entries).filter((d) => d <= today && (entries[d]?.[habit.id]?.count || 0) > 0).sort()
  if (!logged.length) return current
  let best = 0
  let run = 0
  if (habit.cadence === 'daily') {
    let prev = ''
    for (const d of logged) {
      run = prev && addDays(prev, 1) === d ? run + 1 : 1
      if (run > best) best = run
      prev = d
    }
    return Math.max(best, current)
  }
  const met = (start: string) => periodTotal(habit, entries, start) >= habit.target
  if (habit.cadence === 'weekly') {
    for (let ws = weekStartOf(logged[0]); ws <= weekStartOf(today); ws = addDays(ws, 7)) {
      run = met(ws) ? run + 1 : 0
      if (run > best) best = run
    }
    return Math.max(best, current)
  }
  for (let ym = logged[0].slice(0, 7); ym <= today.slice(0, 7); ym = nextMonthOf(ym)) {
    run = met(`${ym}-01`) ? run + 1 : 0
    if (run > best) best = run
  }
  return Math.max(best, current)
}

/**
 * A group's streaks and totals count whole days only: a day with every sub-habit
 * done. (Its strip and grid still shade partial days.)
 */
function wholeDays(habit: Habit, entries: Entries): Entries {
  const out: Entries = {}
  for (const [date, day] of Object.entries(entries)) {
    const count = day[habit.id]?.count || 0
    out[date] = { ...day, [habit.id]: { count: count >= habit.target ? 1 : 0 } }
  }
  return out
}

function WhenMark({ habit }: { habit: Habit }) {
  if (habit.when !== 'morning' && habit.when !== 'night') return null
  const night = habit.when === 'night'
  return (
    <span className="hb-when" title={night ? 'Done at night, logged the next morning' : 'A morning habit'}>
      <Hi icon={night ? MoonIcon : SunIcon} size={13} />
    </span>
  )
}

/** The flame and its count, brighter once it is a week or more (three periods for weekly and monthly). */
function StreakChip({ habit, streak }: { habit: Habit; streak: number }) {
  if (streak < 2) return null
  const proud = habit.cadence === 'daily' ? streak >= 7 : streak >= 3
  const unit = habit.cadence === 'daily' ? '' : habit.cadence === 'weekly' ? ' wk' : ' mo'
  return (
    <span className={`hb-streak${proud ? ' proud' : ''}`} title={`${streak}-${CADENCE_NOUN[habit.cadence]} streak`}>
      <Hi icon={FireIcon} size={12} />{streak}{unit}
    </span>
  )
}

/** The last seven days, ending on the day being answered: a glance, not a control. */
function WeekStrip({ habit, entries, date }: { habit: Habit; entries: Entries; date: string }) {
  const days = recentDays(habit, entries, date)
  return (
    <span className="hb-strip" aria-hidden="true">
      {days.map((d, i) => (
        <span key={d.date} className={`hb-strip-day${i === days.length - 1 ? ' last' : ''}`}>
          <span
            className={`hb-strip-dot${d.level ? ' on' : ''}${d.skipped ? ' skipped' : ''}`}
            style={d.level ? { background: `color-mix(in srgb, ${habit.color} ${LEVEL_MIX[d.level]}%, var(--bg-3))` } : undefined}
          />
          <span className="hb-strip-letter">{d.letter}</span>
        </span>
      ))}
    </span>
  )
}

/** A group's own check: a pie of its sub-habits done, the mark once all are. */
export function GroupCheck({ habit, done, total, action, busy, onLog }: {
  habit: Habit; done: number; total: number
  /** What a tap does, in words (groups.ts groupWords), so the label never promises more. */
  action: string
  busy: boolean; onLog: () => void
}) {
  const all = total > 0 && done >= total
  const label = action
  return (
    <button
      type="button"
      className={`habit-check pie${all ? ' on full' : ''}`}
      style={{ '--habit-color': habit.color, '--habit-pie': `${(total ? done / total : 0) * 360}deg` } as React.CSSProperties}
      onClick={onLog}
      disabled={busy}
      aria-label={label}
      title={action}
    >
      {all && <Hi icon={CheckIcon} size={20} />}
    </button>
  )
}

/** What a row can do; the page owns every write. */
interface RowActions {
  onLog: (habit: Habit, delta: number) => void
  onLogGroup: (habit: Habit) => void
  onValue: (habit: Habit, value: number | null) => void
  onNote: (habit: Habit) => void
  onEdit: (habit: Habit) => void
  onChat: (habit: Habit) => void
  onPickDay: (habit: Habit, date: string) => void
  onPickPeriod: (habit: Habit, period: { start: string; end: string; title: string }) => void
  onSyncSleep: () => Promise<void>
}

interface DragProps {
  dragging: boolean
  dropTarget: boolean
  onDragStart: (id: string) => void
  onDragOver: (id: string) => void
  onDrop: (id: string) => void
  onDragEnd: () => void
}

function HabitHistory({ habit, entries, today, group, actions }: {
  habit: Habit
  entries: Entries
  today: string
  group: boolean
  actions: RowActions
}) {
  const counted = group ? wholeDays(habit, entries) : entries
  const shape = group ? { ...habit, target: 1 } : habit
  const streak = streakOf(shape, counted, today)
  const best = bestStreakOf(shape, counted, today)
  let total = 0
  for (const day of Object.values(counted)) total += day[habit.id]?.count || 0
  return (
    <div className="hb-history">
      <div className="hb-stats">
        <div className="hb-stat">
          <span className={`hb-stat-n${streak > 1 ? ' hot' : ''}`}>{streak}</span>
          <span className="hb-stat-l">{CADENCE_NOUN[habit.cadence]} streak</span>
        </div>
        <div className="hb-stat"><span className="hb-stat-n">{best}</span><span className="hb-stat-l">best streak</span></div>
        <div className="hb-stat">
          <span className="hb-stat-n">{total}</span>
          <span className="hb-stat-l">{group ? 'full days, past year' : 'past year'}</span>
        </div>
      </div>
      {habit.cadence !== 'daily' && <div className="hb-quota-line"><QuotaDots habit={habit} count={periodTotal(habit, entries, today)} /></div>}
      <HabitGrid
        habit={habit}
        entries={entries}
        today={today}
        onPick={(date) => actions.onPickDay(habit, date)}
        onPickPeriod={(period) => actions.onPickPeriod(habit, period)}
      />
      {group && <p className="hb-hint">Pick a day to answer its sub-habits for that day.</p>}
      {habit.metric && (
        <HabitMetricSection
          habit={habit}
          entries={entries}
          today={today}
          onSync={habit.metric.source === 'whoop-sleep' ? actions.onSyncSleep : undefined}
        />
      )}
      <div className="hb-history-actions">
        <button type="button" className="pk-btn pk-compact" onClick={() => actions.onEdit(habit)}>
          <Hi icon={PencilSquareIcon} size={14} /> Edit {group ? 'group' : 'habit'}
        </button>
        <button type="button" className="pk-btn pk-compact" onClick={() => actions.onChat(habit)}>
          <Hi icon={ChatBubbleLeftRightIcon} size={14} /> Chat about it
        </button>
      </div>
    </div>
  )
}

/**
 * One habit: its name, chips and week strip open its history; the controls on the
 * right answer the day. `nested` is a sub-habit's row inside its group's card.
 */
function HabitCard({ habit, entries, date, today, open, busy, nested, group, actions, drag, onToggle }: {
  habit: Habit
  /** Entries with groups folded in (foldGroups). */
  entries: Entries
  date: string
  today: string
  open: boolean
  busy: (habit: Habit) => boolean
  nested?: boolean
  /** For a group: its sub-habits' rows, drawn inside the card. */
  group?: { children: Habit[]; done: number; total: number; action: string; renderChild: (h: Habit) => React.ReactNode }
  actions: RowActions
  drag: DragProps
  onToggle: (habit: Habit) => void
}) {
  const entry = entries[date]?.[habit.id]
  const count = entry?.count || 0
  const periodCount = periodTotal(habit, entries, date)
  const counted = group ? wholeDays(habit, entries) : entries
  const streak = streakOf(group ? { ...habit, target: 1 } : habit, counted, today)
  const multi = !group && habit.cadence === 'daily' && habit.target > 1
  const finished = group ? group.done >= group.total : doneOn(habit, entries, date)
  const sub = (!group && entry?.note) || habit.description
  const recent = recentDays(habit, entries, date).filter((d) => d.level >= (group ? 4 : 1)).length
  const spoken = [
    habit.name,
    group ? `a group of ${group.total}, ${group.done} done` : '',
    habit.when === 'night' ? 'a night habit, logged the next morning' : habit.when === 'morning' ? 'a morning habit' : '',
    sub,
    streak > 1 ? `${streak}-${CADENCE_NOUN[habit.cadence]} streak` : '',
    !group && habit.cadence !== 'daily' ? `${periodCount} of ${habit.target} ${periodLabel(habit.cadence)}` : '',
    `done ${recent} of the last 7 days`,
    open ? 'history shown' : 'open for its history',
  ].filter(Boolean).join(', ')

  let control: React.ReactNode
  if (group) {
    // A group whose sub-habits are all filled by apps has nothing for its check to write.
    control = <GroupCheck habit={habit} done={group.done} total={group.total} action={group.action} busy={busy(habit) || !group.children.some(handLogged)} onLog={() => actions.onLogGroup(habit)} />
  } else if (multi && !habit.linkedApp) {
    control = (
      <div className="habit-stepper hb-stepper">
        <button type="button" className="habit-step" onClick={() => actions.onLog(habit, -1)} disabled={busy(habit) || count <= 0} aria-label={`Undo one ${habit.name}`}>
          <Hi icon={MinusIcon} size={16} />
        </button>
        <span className="habit-count" style={count > 0 ? { color: habit.color } : undefined}>
          {count}<small>/{habit.target}</small>
        </span>
        <button type="button" className="habit-step" onClick={() => actions.onLog(habit, +1)} disabled={busy(habit)} aria-label={`Log one ${habit.name}`}>
          <Hi icon={PlusIcon} size={16} />
        </button>
      </div>
    )
  } else {
    control = <HabitCheckButton habit={habit} count={count} periodCount={periodCount} busy={busy(habit)} onLog={actions.onLog} />
  }

  return (
    <div
      className={`hb-card${nested ? ' nested' : ''}${group ? ' group' : ''}${finished ? ' done' : ''}${open ? ' open' : ''}${drag.dragging ? ' dragging' : ''}${drag.dropTarget ? ' drop-target' : ''}`}
      style={{ '--hc': habit.color } as React.CSSProperties}
      data-land={habit.id}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); drag.onDragOver(habit.id) }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drag.onDrop(habit.id) }}
    >
      <div className="hb-row">
        <button
          type="button"
          className="hb-drag"
          draggable
          onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; drag.onDragStart(habit.id) }}
          onDragEnd={drag.onDragEnd}
          aria-label={`Move ${habit.name}`}
          title="Drag to reorder"
        ><Hi icon={Bars3Icon} size={16} /></button>
        <button type="button" className="hb-main" onClick={() => onToggle(habit)} aria-expanded={open} aria-label={spoken}>
          <span className="hb-head">
            <span className="hb-title">
              <span className="hb-dot" />
              <span className="hb-name">{habit.name}</span>
              <WhenMark habit={habit} />
              <StreakChip habit={habit} streak={streak} />
              {group && <span className="hb-of">{group.done}/{group.total}</span>}
              {!group && habit.cadence !== 'daily' && <QuotaDots habit={habit} count={periodCount} compact />}
              <span className={`hb-chev${open ? ' up' : ''}`}><Hi icon={ChevronDownIcon} size={14} /></span>
            </span>
            {sub ? <span className="hb-sub">{sub}</span> : null}
          </span>
          <WeekStrip habit={habit} entries={entries} date={date} />
        </button>
        <span className="hb-controls">
          {habit.metric && !group && <HabitMetricInput habit={habit} entry={entry} busy={busy(habit)} onValue={actions.onValue} />}
          {!habit.linkedApp && !group && (
            <button
              type="button"
              className={`hb-note${entry?.note ? ' has-note' : ''}`}
              title={entry?.note ? `Note: ${entry.note}` : 'Add a note'}
              aria-label={entry?.note ? `Note on ${habit.name}: ${entry.note}` : `Add a note to ${habit.name}`}
              onClick={() => actions.onNote(habit)}
            >
              <Hi icon={ChatBubbleLeftEllipsisIcon} size={18} />
            </button>
          )}
          {control}
        </span>
      </div>
      {group && <div className="hb-subs" role="group" aria-label={`${habit.name}: sub-habits`}>{group.children.map(group.renderChild)}</div>}
      {open && <HabitHistory habit={habit} entries={entries} today={today} group={Boolean(group)} actions={actions} />}
      <ChatAbout of={() => habitContext(habit, entries, today, { streak, periodCount: periodTotal(habit, entries, today) })} host=".hb-card" />
    </div>
  )
}

/** The day being answered, a bar that fills per row, and the page's actions. */
function TodayCard({ date, daysBack, rows, onStep, onToday, onRefresh }: {
  date: string
  daysBack: number
  /** One segment per row, done by groups.ts rowDone, as the Overview and the app count. */
  rows: { habit: Habit; done: boolean }[]
  onStep: (delta: 1 | -1) => void
  onToday: () => void
  onRefresh: () => void
}) {
  const segments = rows.map(({ habit: h, done }) => ({ id: h.id, color: h.color, done }))
  const done = segments.filter((s) => s.done).length
  const total = segments.length
  const all = total > 0 && done === total
  const title = daysBack === 0 ? 'Today' : daysBack === 1 ? 'Yesterday' : toDate(date).toLocaleDateString([], { weekday: 'long' })
  return (
    <section className="pk-card hb-today" aria-label="The day being answered">
      <div className="hb-today-line">
        <div className="hb-today-title">
          <h1 className="pk-title">{title}</h1>
          <span className="pk-sub">{dayLabel(date)}</span>
        </div>
        {daysBack > 0 && <button type="button" className="pk-btn pk-ghost hb-today-back" onClick={onToday}>Today</button>}
        <button type="button" className="pk-icon-btn" onClick={() => onStep(1)} disabled={daysBack >= MAX_DAYS_BACK} aria-label="Previous day" title="Previous day">
          <Hi icon={ChevronLeftIcon} size={18} />
        </button>
        <button type="button" className="pk-icon-btn" onClick={() => onStep(-1)} disabled={daysBack === 0} aria-label="Next day" title="Next day">
          <Hi icon={ChevronRightIcon} size={18} />
        </button>
      </div>
      {total > 0 && (
        <div className="hb-bar" role="progressbar" aria-label={`${done} of ${total} habits done`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          {segments.map((seg) => (
            <span key={seg.id} className="hb-seg"><span className={seg.done ? 'on' : ''} style={{ background: seg.color }} /></span>
          ))}
        </div>
      )}
      <div className="hb-today-foot">
        <span className="hb-count" aria-live="polite">
          {all
            ? <><Hi icon={CheckBadgeSolidIcon} size={18} /> <strong className="hb-all">All done</strong></>
            : total > 0 ? <><strong>{done}</strong> of {total} done</> : null}
        </span>
        <button type="button" className="pk-icon-btn pk-ghost" onClick={onRefresh} aria-label="Refresh" title="Refresh">
          <Hi icon={ArrowPathIcon} size={17} />
        </button>
        <button type="button" className="pk-btn" onClick={() => window.dispatchEvent(new Event(OPEN_HABIT_CHECKIN))} title="Morning check-in: yesterday and this morning">
          <Hi icon={SunIcon} size={16} /> Check in
        </button>
        <button type="button" className="pk-btn pk-primary" onClick={() => window.dispatchEvent(new Event(NEW_HABIT))}>
          <Hi icon={PlusIcon} size={16} /> New
        </button>
      </div>
    </section>
  )
}

// The check-in steps back as far as the loaded history (a year).
const MAX_DAYS_BACK = 365
const NEW_HABIT = 'totem:habit-new'
// Which cards are open, per browser; a convenience, so a lost value just closes them.
const OPEN_KEY = 'totem.habits.open'
const readOpen = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}
const writeOpen = (ids: string[]) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(ids)) } catch { /* per-browser nicety only */ } }

const openLinkedApp = (h: Habit) => { if (h.appUrl) window.open(h.appUrl, '_blank', 'noopener') }

// ---------- the view ----------
interface HabitsViewProps { onAuthError: () => void }

type Modal =
  | { type: 'add'; parentId?: string | null }
  | { type: 'edit'; habit: Habit }
  | { type: 'day'; habit: Habit; date: string }
  | { type: 'period'; habit: Habit; start: string; end: string; title: string }
  | null

export default function HabitsView({ onAuthError }: HabitsViewProps) {
  const [data, setData] = useState<HabitsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useErrorToast(error)
  // How many days back the page is answering: 0 is today. The arrows step it.
  const [daysBack, setDaysBack] = useState(0)
  const [modal, setModal] = useState<Modal>(null)
  // `g h h` lands on Habits, then opens the new-habit dialog.
  useCommand(COMMANDS.habitNew, () => setModal({ type: 'add' }))
  useEffect(() => {
    const on = () => setModal({ type: 'add' })
    window.addEventListener(NEW_HABIT, on)
    return () => window.removeEventListener(NEW_HABIT, on)
  }, [])
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [open, setOpen] = useState<string[]>(readOpen)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const auth = useCallback((e: unknown) => { if (e instanceof AuthError) { onAuthError(); return true } return false }, [onAuthError])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setData(await getHabits()) } catch (e: any) { if (!auth(e)) setError(e.message) } finally { setLoading(false) }
  }, [auth])

  useEffect(() => { load() }, [load])
  // The morning check-in logs from outside this view.
  useEffect(() => {
    const on = () => { load() }
    window.addEventListener('totem:habits-changed', on)
    return () => window.removeEventListener('totem:habits-changed', on)
  }, [load])

  const raw = data?.habits || []
  // Every view reads groups as daily habits counting their sub-habits (groups.ts).
  const folded = useMemo(() => foldGroups(raw, data?.entries || {}, data?.today), [raw, data?.entries, data?.today])
  const entries = folded.entries
  const byId = useMemo(() => new Map(folded.habits.map((h) => [h.id, h])), [folded.habits])
  const tree = useMemo(() => habitTree(raw), [raw])
  const rows = tree.filter((r) => !isSyncedSleep(r.habit))
  const archived = raw.filter((h) => h.archived)
  const sleepHidden = raw.some((h) => !h.archived && isSyncedSleep(h))
  const today = data?.today || ''
  const checkinDate = today ? addDays(today, -daysBack) : ''

  const guard = <T,>(p: Promise<T>): Promise<T> =>
    p.catch((e) => { if (e instanceof AuthError) { onAuthError(); return Promise.reject(new Error('Session expired')) } throw e })

  const keyOf = (habit: Habit) => `${habit.id}:${checkinDate}`
  const busy = (habit: Habit) => Boolean(busyKeys[keyOf(habit)])
  const withBusy = async (habit: Habit, run: () => Promise<void>) => {
    const key = keyOf(habit)
    if (busyKeys[key]) return
    setBusyKeys((b) => ({ ...b, [key]: true }))
    try { await run() } catch (e: any) { setError(e.message) } finally { setBusyKeys((b) => ({ ...b, [key]: false })) }
  }

  // One-tap logging. The bridge write is local-disk fast, so the refreshed payload
  // it returns is swapped in; a per-habit busy flag stops double taps racing.
  const logDelta = (habit: Habit, delta: number, { offerUndo = true } = {}) => withBusy(habit, async () => {
    const before = data?.entries[checkinDate]?.[habit.id]?.count || 0
    const date = checkinDate
    setData(await guard(logHabit({ id: habit.id, date, delta })))
    // Unticking is the step that loses something, so it is the one with an undo.
    if (delta < 0 && offerUndo && before + delta <= 0) {
      pushToast(`Unticked ${habit.name}.`, 'info', {
        duration: 4000,
        action: { label: 'Undo', onClick: () => { void guard(logHabit({ id: habit.id, date, delta: -delta })).then(setData, (e) => setError(e.message)) } },
      })
    }
  })

  // A group's check marks every hand-logged sub-habit done, or clears them once
  // all are; either way the toast can put the day back exactly.
  const logGroup = (group: Habit) => withBusy(group, async () => {
    if (!data) return
    const t = groupToggle(raw, group.id, data.entries, checkinDate)
    if (!t.changes) { pushToast(`Nothing logged for ${group.name} on this day to clear.`, 'info', { duration: 3000 }); return }
    setData(await guard(logHabit({ id: group.id, date: checkinDate, complete: t.complete })))
    pushToast(groupWords(group.name, t, 0, 0).result, 'info', {
      duration: 4000,
      action: { label: 'Undo', onClick: () => { void guard(logHabit(t.undo)).then(setData, (e) => setError(e.message)) } },
    })
  })

  // A number is evidence the habit happened, so it ticks the day off too
  // (`complete`); clearing it back out leaves the check alone.
  const logValue = (habit: Habit, value: number | null) => withBusy(habit, async () => {
    setData(await guard(logHabit({ id: habit.id, date: checkinDate, value, complete: value !== null })))
  })

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

  const toggleOpen = (habit: Habit) => setOpen((ids) => {
    const next = ids.includes(habit.id) ? ids.filter((id) => id !== habit.id) : [...ids, habit.id]
    writeOpen(next)
    return next
  })

  const isGroupId = (id: string) => tree.some((r) => r.habit.id === id && r.children.length > 0)
  const actions: RowActions = {
    onLog: (habit, delta) => { if (!habit.linkedApp) void logDelta(habit, delta) },
    onLogGroup: (habit) => { void logGroup(habit) },
    onValue: (habit, value) => { if (!habit.linkedApp) void logValue(habit, value) },
    onNote: (habit) => setModal({ type: 'day', habit: raw.find((h) => h.id === habit.id) || habit, date: checkinDate }),
    onEdit: (habit) => setModal({ type: 'edit', habit: raw.find((h) => h.id === habit.id) || habit }),
    onChat: (habit) => {
      if (!data) return
      // A group's streak counts whole days, as its card does.
      const streak = isGroupId(habit.id) ? streakOf({ ...habit, target: 1 }, wholeDays(habit, entries), today) : streakOf(habit, entries, today)
      void startChatAbout(habitContext(habit, entries, today, { streak, periodCount: periodTotal(habit, entries, today) }))
        .catch((e) => (e instanceof AuthError ? onAuthError() : setError(e?.message || 'Could not start that chat')))
    },
    // A group's days are its sub-habits': picking one steps the page to that day.
    onPickDay: (habit, date) => {
      if (isGroupId(habit.id)) { setDaysBack(Math.max(0, Math.min(MAX_DAYS_BACK, diffDays(today, date)))); return }
      if (habit.linkedApp) { openLinkedApp(habit); return }
      setModal({ type: 'day', habit: raw.find((h) => h.id === habit.id) || habit, date })
    },
    onPickPeriod: (habit, period) => {
      if (isGroupId(habit.id)) return
      if (habit.linkedApp) { openLinkedApp(habit); return }
      setModal({ type: 'period', habit: raw.find((h) => h.id === habit.id) || habit, ...period })
    },
    onSyncSleep: syncSleepNow,
  }

  // Drag to reorder: a row among the rows, or a sub-habit within its group.
  const moveHabit = async (targetId: string) => {
    const dragged = draggedId
    setDraggedId(null)
    setDropTargetId(null)
    if (!dragged || dragged === targetId || !data) return
    const next = tree.map((r) => ({ habit: r.habit, children: [...r.children] }))
    const top = (id: string) => next.findIndex((r) => r.habit.id === id)
    const from = top(dragged)
    const to = top(targetId)
    if (from >= 0 && to >= 0) {
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
    } else {
      const row = next.find((r) => r.children.some((c) => c.id === dragged) && r.children.some((c) => c.id === targetId))
      if (!row) return
      const a = row.children.findIndex((c) => c.id === dragged)
      const b = row.children.findIndex((c) => c.id === targetId)
      const [moved] = row.children.splice(a, 1)
      row.children.splice(b, 0, moved)
    }
    const ids = flattenTree(next)
    const order = new Map(ids.map((id, i) => [id, i]))
    const before = data
    setData({ ...data, habits: [...data.habits].sort((x, y) => (order.get(x.id) ?? 1e9) - (order.get(y.id) ?? 1e9)) })
    try {
      setData(await guard(reorderHabits(ids)))
    } catch (e: any) {
      setData(before)
      setError(e.message)
    }
  }
  const dragFor = (id: string): DragProps => ({
    dragging: draggedId === id,
    dropTarget: Boolean(draggedId && dropTargetId === id && draggedId !== id),
    onDragStart: setDraggedId,
    onDragOver: setDropTargetId,
    onDrop: moveHabit,
    onDragEnd: () => { setDraggedId(null); setDropTargetId(null) },
  })

  const card = (h: Habit, nested: boolean, group?: { children: Habit[] }) => {
    const shown = byId.get(h.id) || h
    const progress = group ? groupProgress(raw, h.id, data?.entries || {}, checkinDate) : null
    return (
      <HabitCard
        key={h.id}
        habit={shown}
        entries={entries}
        date={checkinDate}
        today={today}
        open={open.includes(h.id)}
        busy={busy}
        nested={nested}
        group={group && progress ? {
          children: group.children,
          done: progress.done,
          total: progress.total,
          action: groupWords(h.name, groupToggle(raw, h.id, data?.entries || {}, checkinDate), progress.done, progress.total).action,
          renderChild: (c) => card(c, true),
        } : undefined}
        actions={actions}
        drag={dragFor(h.id)}
        onToggle={toggleOpen}
      />
    )
  }

  // A group's own check is derived, so only a habit ticked by hand can hold sub-habits (the bridge's rule).
  const parentChoices = raw.filter((h) => !h.archived && !h.parentId && handLogged(h))

  return (
    <div className="pk-page habits-view hb-view">
      {loading && !data ? (
        <div className="spinner">Loading…</div>
      ) : !rows.length ? (
        <div className="pk-card pk-empty">
          <Hi icon={FireIcon} size={28} />
          <strong className="hb-empty-title">No habits yet</strong>
          <span>
            Add one here, or just tell Totem: “track a reading habit for me”.
            {sleepHidden && ' Sleep syncs from WHOOP on its own and shows in Bushido.'}
          </span>
          <span className="pk-actions">
            <button type="button" className="pk-btn pk-primary" onClick={() => setModal({ type: 'add' })}><Hi icon={PlusIcon} size={16} /> New habit</button>
            <button type="button" className="pk-btn" onClick={() => window.dispatchEvent(new Event(OPEN_HABIT_CHECKIN))}><Hi icon={SunIcon} size={16} /> Check in</button>
          </span>
        </div>
      ) : (
        <>
          <TodayCard
            date={checkinDate}
            daysBack={daysBack}
            rows={rows.map((r) => ({ habit: r.habit, done: rowDone(raw, r, data?.entries || {}, checkinDate) }))}
            onStep={(d) => setDaysBack((n) => Math.min(Math.max(n + d, 0), MAX_DAYS_BACK))}
            onToday={() => setDaysBack(0)}
            onRefresh={load}
          />
          <div className="hb-list">
            {rows.map((r) => card(r.habit, false, r.children.length ? { children: r.children } : undefined))}
          </div>
        </>
      )}

      {sleepHidden && rows.length > 0 && (
        <p className="hb-footnote">Sleep syncs from WHOOP on its own and shows in Bushido.</p>
      )}

      {archived.length > 0 && (
        <div className="hb-archived">
          <button type="button" className="hb-archived-head" aria-expanded={showArchived} onClick={() => setShowArchived((s) => !s)}>
            <Hi icon={ArchiveBoxIcon} size={15} />
            <span>Archived · {archived.length}</span>
            <span className={`hb-chev${showArchived ? ' up' : ''}`}><Hi icon={ChevronDownIcon} size={14} /></span>
          </button>
          {showArchived && (
            <div className="pk-card hb-archived-list">
              {archived.map((h) => (
                <div key={h.id} className="hb-archived-row">
                  <button type="button" className="hb-archived-name" onClick={() => setModal({ type: 'edit', habit: h })} aria-label={`${h.name}, edit habit`}>
                    <span className="hb-dot" style={{ background: h.color }} />
                    <span>{h.name}</span>
                  </button>
                  <button
                    type="button"
                    className="pk-btn pk-compact"
                    onClick={async () => { try { setData(await guard(updateHabit(h.id, { archived: false }))) } catch (e: any) { setError(e.message) } }}
                  >
                    <Hi icon={ArrowPathIcon} size={14} /> Restore
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
          parents={parentChoices}
          defaultParent={modal.parentId || null}
          onClose={() => setModal(null)}
          onSubmit={async (fields) => { setData(await guard(createHabit(fields))); setModal(null) }}
        />
      )}

      {modal?.type === 'edit' && data && (
        <HabitFormModal
          initial={modal.habit}
          palette={data.palette}
          usedColors={data.habits.map((h) => h.color)}
          parents={parentChoices.filter((h) => h.id !== modal.habit.id)}
          hasChildren={raw.some((h) => h.parentId === modal.habit.id && !h.archived)}
          onAddSub={() => setModal({ type: 'add', parentId: modal.habit.id })}
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

/** Whole days from `from` back to `to` (positive when `to` is earlier). */
function diffDays(from: string, to: string): number {
  return Math.round((toDate(from).getTime() - toDate(to).getTime()) / 86_400_000)
}
