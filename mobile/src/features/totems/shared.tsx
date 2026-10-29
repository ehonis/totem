// What the Totems list, a totem's page and the builder share (web TotemsView.tsx,
// plus the pieces of JobsView.tsx it borrows: the schedule builder, run history,
// notify choices and relative times).
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { api, getJobs, getJobRuns, runJobNow, updateJob, AuthError } from '../../lib/api'
import { syncThreads, adoptThread } from '../../lib/chat/store'
import { THREAD_ICONS } from '../../lib/chat/threadIcons.gen'
import { pushError, pushToast } from '../../lib/toast'
import { IconPlayerPlay } from '../../lib/chat/icons'
import { TI, vc } from '../chat/ui'
import {
  Hi, SparklesIcon, BoltIcon, SunIcon, MoonIcon, PuzzlePieceIcon, CheckCircleIcon, CalendarDaysIcon, CalendarIcon,
  ViewColumnsIcon, CircleStackIcon, MagnifyingGlassIcon, PencilSquareIcon, PencilIcon, CommandLineIcon, ClockIcon,
  ChatBubbleLeftIcon, StarIcon, BookmarkIcon, BookmarkSquareIcon, HeartIcon, FlagIcon, GiftIcon, BuildingOffice2Icon,
  SquaresPlusIcon, TableCellsIcon, BriefcaseIcon, ServerStackIcon, InboxStackIcon, CubeIcon, FolderIcon, EnvelopeIcon,
  DocumentIcon, DocumentCheckIcon, BookOpenIcon, UserGroupIcon, PaperAirplaneIcon, WrenchIcon, ClipboardIcon, FireIcon,
  GlobeAmericasIcon, ExclamationTriangleIcon,
} from '../../lib/icons'
import { openChat } from '../../shell/nav'
import { colors, alpha, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { prompt } from '../../ui/menu'
import { tap } from '../../ui/haptics'

// --- the jobs store ------------------------------------------------------------
// The list and a totem's page read one copy, so a toggle on either shows on both.

let jobs: any[] | null = null
let timezone: string | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((fn) => fn())

export async function loadJobs() {
  try {
    const p: any = await getJobs()
    jobs = p.jobs || []
    timezone = p.timezone || null
    emit()
  } catch (e: any) {
    if (!(e instanceof AuthError)) pushError(e.message)
  }
}

export function replaceJob(job: any) {
  if (!job) return
  jobs = (jobs || []).some((j) => j.id === job.id) ? (jobs || []).map((j) => (j.id === job.id ? job : j)) : [...(jobs || []), job]
  emit()
}

export async function setEnabled(job: any, enabled: boolean) {
  // Optimistic, so the switch doesn't snap back while the bridge answers.
  replaceJob({ ...job, enabled })
  try { const r: any = await updateJob(job.id, { enabled }); replaceJob(r.job) }
  catch (e: any) { replaceJob(job); pushError(e.message) }
}

export function dropJob(id: string) {
  jobs = (jobs || []).filter((j) => j.id !== id)
  emit()
}

const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
export const useJobs = () => useSyncExternalStore(subscribe, () => jobs, () => jobs)
export const useJobTimezone = () => useSyncExternalStore(subscribe, () => timezone, () => timezone)

// --- run now (web totems/shared.tsx → TotemRunButton) -------------------------
// Runs this app started and is still waiting on, kept outside any screen so the
// button still shows the run after the owner leaves the chat and comes back.
const runningHere = new Set<string>()
let runsVersion = 0
const runSubs = new Set<() => void>()
const bumpRuns = () => { runsVersion++; runSubs.forEach((fn) => fn()) }
const subscribeRuns = (fn: () => void) => { runSubs.add(fn); return () => { runSubs.delete(fn) } }

/** Run a totem now; its report lands in its chat, which is refreshed. */
export async function startTotemRun(job: any) {
  if (runningHere.has(job.id)) return
  runningHere.add(job.id)
  bumpRuns()
  try {
    const r: any = await runJobNow(job.id)
    replaceJob((r.jobs || []).find((j: any) => j.id === job.id))
    const status = r.run?.status
    pushToast(
      status === 'error' ? `${job.name} failed: ${r.run?.error || 'no error text'}` : status === 'skipped' ? `${job.name} checked: nothing new` : `${job.name} ran. Its report is in its chat.`,
      status === 'error' ? 'error' : 'info',
    )
    await syncThreads()
  } catch (e: any) { pushError(e.message) } finally {
    runningHere.delete(job.id)
    bumpRuns()
  }
}

/** The play button in a totem's chat: run it now instead of waiting for its schedule or watch. */
export function TotemRunButton({ totemId, style }: { totemId: string; style?: any }) {
  const list = useJobs()
  useSyncExternalStore(subscribeRuns, () => runsVersion, () => runsVersion)
  useEffect(() => { if (!list) void loadJobs() }, [list])
  const job = list?.find((j) => j.id === totemId)
  if (!job) return null
  const running = runningHere.has(job.id) || job.lastRun?.status === 'running'
  return (
    <Press
      style={style} onPress={() => { if (running) return; tap(); void startTotemRun(job) }}
      accessibilityLabel={running ? `${job.name} is running` : `Run ${job.name} now`} accessibilityState={{ busy: running }}
    >
      {running ? <ActivityIndicator size="small" color={vc.soft} /> : <TI icon={IconPlayerPlay} size={20} color={vc.soft} />}
    </Press>
  )
}

// --- labels --------------------------------------------------------------------

export interface Rec { provider: string; model: string; effort: string; label: string; account: string; driver: string; cost: number; why: string }
export type WatchSource = { kind: 'git'; repo: string; ref: string } | { kind: 'url'; url: string; contains?: string }
/** What a totem watches (jobs/triggers.mjs). One check covers every source. */
export interface Watch { type: 'watch'; everyMinutes: number; sources: WatchSource[] }
/** A watch in the current shape; ones saved before a watch could list several hold a single `source`. */
export function asWatch(w: any): Watch | null {
  if (!w) return null
  return { type: 'watch', everyMinutes: w.everyMinutes, sources: Array.isArray(w.sources) ? w.sources : w.source ? [w.source] : [] }
}
/** The key the bridge keeps a source's baseline under (`sourceKey` in jobs/triggers.mjs). */
export const sourceKey = (s: WatchSource) => (s.kind === 'git' ? `git ${s.repo} ${s.ref}` : `url ${s.url}${s.contains ? ` ${s.contains}` : ''}`)
export interface Draft {
  name: string; summary?: string; icon: string; taskType: string; instructions: string; schedule: any; trigger: Watch | null; browser: boolean
  notify: string; recommendations: Rec[]; questions: string[]
}
/** Which model runs it. `provider: 'default'` is the default account's default model. */
export interface Choice { provider: string; model: string; effort: string }

export const COST: Record<number, string> = { 1: 'Low cost', 2: 'Medium cost', 3: 'High cost' }
export const TYPE_LABEL: Record<string, string> = {
  watcher: 'Watcher', researcher: 'Researcher', analyst: 'Analyst', writer: 'Writer', organiser: 'Organiser', coach: 'Coach', coder: 'Coder', other: 'Agent',
}
export const NOTIFY_CHOICES = [
  { id: 'agent', label: 'When the totem decides it matters' },
  { id: 'errors', label: 'Only when it fails' },
  { id: 'always', label: 'Every run' },
  { id: 'never', label: 'Never' },
]

export const kindOf = (job: any) => (job.runner ? 'Built-in' : job.skillId ? 'Skill' : TYPE_LABEL[job.taskType] || 'Agent')

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

export function statusLine(job: any) {
  if (job.lastRun?.status === 'running') return 'Running now…'
  if (!job.enabled) return 'Paused'
  if (job.trigger) {
    const w = job.watch
    if (w?.error) return `Can’t check: ${w.error}`
    if (!w?.checkedAt) return 'First check within a minute'
    return `Checked ${relativeTime(w.checkedAt)}${w.changedAt ? ` · last change ${relativeTime(w.changedAt)}` : ''}${job.lastRun?.status === 'error' ? ' · last run failed' : ''}`
  }
  const next = job.nextRunAt ? `Next ${relativeTime(job.nextRunAt)}` : 'Not scheduled'
  if (job.lastRun?.status === 'error') return `Last run failed · ${next}`
  return next
}

/** A totem's chat is `totem-<id>`; the bridge makes it on first open. */
/** The totem's own chat, made the first time it is needed. Null (and a toast) if that failed. */
export async function ensureTotemChat(job: any): Promise<string | null> {
  try {
    const { threadId } = await api<{ threadId: string }>(`/api/totems/${encodeURIComponent(job.id)}/thread`, { method: 'POST' })
    await syncThreads()
    return threadId
  } catch (e: any) { pushError(`Couldn't open the chat: ${e.message}`); return null }
}

export async function openTotemChat(job: any) {
  const id = await ensureTotemChat(job)
  if (id) openChat(id)
}

// --- icon ------------------------------------------------------------------------

// web studio.ts STUDIO_ICONS: the Heroicon names a skill or older job may carry.
const STUDIO_ICONS: Record<string, any> = {
  sparkles: SparklesIcon, bolt: BoltIcon, sun: SunIcon, moon: MoonIcon, puzzle: PuzzlePieceIcon, check: CheckCircleIcon,
  calendar: CalendarDaysIcon, calendar2: CalendarIcon, columns: ViewColumnsIcon, brain: CircleStackIcon, search: MagnifyingGlassIcon,
  note: PencilSquareIcon, pencil: PencilIcon, command: CommandLineIcon, clock: ClockIcon, chat: ChatBubbleLeftIcon, star: StarIcon,
  bookmark: BookmarkIcon, bookmark2: BookmarkSquareIcon, heart: HeartIcon, flag: FlagIcon, gift: GiftIcon, building: BuildingOffice2Icon,
  grid: SquaresPlusIcon, table: TableCellsIcon, briefcase: BriefcaseIcon, database: ServerStackIcon, inbox: InboxStackIcon, cube: CubeIcon,
  folder: FolderIcon, envelope: EnvelopeIcon, document: DocumentIcon, documentCheck: DocumentCheckIcon, book: BookOpenIcon,
  users: UserGroupIcon, send: PaperAirplaneIcon, wrench: WrenchIcon, clipboard: ClipboardIcon, fire: FireIcon, globe: GlobeAmericasIcon,
}

/** .tm-icon: the totem's glyph on a bg-3 tile. Tabler thread icons first, then Heroicons. */
export function TotemIcon({ name, large, small }: { name?: string; large?: boolean; small?: boolean }) {
  const icon = (name && THREAD_ICONS[name]) || STUDIO_ICONS[name || ''] || SparklesIcon
  const box = large ? 48 : small ? 24 : 38
  return (
    <View style={[st.icon, { width: box, height: box, borderRadius: large ? 12 : small ? 7 : 10 }]}>
      <Hi icon={icon} size={large ? 24 : small ? 14 : 20} color={textAlpha(78)} />
    </View>
  )
}

/** Agent totems (an inline prompt): the only ones that can talk in a chat. */
export const askable = (j: any) => !j.runner && !j.skillId && !!String(j.prompt || '').trim()

/** Make a group chat with these totems and open it (web TotemsView.tsx startGroupChat). */
export async function startGroupChat(ids: string[], title: string) {
  try {
    const { thread } = await api<{ thread: any }>('/api/totems/groups', { method: 'POST', body: JSON.stringify({ members: ids, title }) })
    adoptThread(thread)
    openChat(thread.id)
  } catch (e: any) { pushError(`Couldn't start the group chat: ${e.message}`) }
}

export function KindTag({ label }: { label: string }) {
  return (
    <View style={st.kind}><T size={11.5} lineHeight={16} color={textAlpha(70)}>{label}</T></View>
  )
}

// --- model recommendations ---------------------------------------------------------

const COST_TINT: Record<number, string> = { 1: '#6fdca1', 2: '#f0cd72', 3: '#f0879e' }

export function CostBadge({ cost }: { cost: number }) {
  const c = COST_TINT[cost] || colors.muted
  return (
    <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, backgroundColor: alpha(c, 0.1) }}>
      <T size={11.5} color={c}>{COST[cost] || 'Cost unknown'}</T>
    </View>
  )
}

export function Recommendations({ recs, value, onChange }: { recs: Rec[]; value: number; onChange: (i: number) => void }) {
  if (!recs.length) return <T muted size={13}>No model suggestions; it will use the default account.</T>
  return (
    <View style={{ gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Model">
      {recs.map((r, i) => {
        const on = value === i
        return (
          <Press
            key={`${r.provider}:${r.model}`}
            onPress={() => { tap(); onChange(i) }}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            style={[st.rec, on && st.recOn]}
          >
            <View style={[st.radio, on && { borderColor: colors.accent }]}>{on ? <View style={st.radioDot} /> : null}</View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T size={14} weight={500}>
                {r.label}
                <T size={12.5} muted>{`  ${r.account}${r.effort ? ` · ${r.effort} effort` : ''}`}</T>
              </T>
              {r.why ? <T size={13} lineHeight={19} color={textAlpha(68)}>{r.why}</T> : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <CostBadge cost={r.cost} />
                {i === 0 ? <T size={11.5} color={colors.accent}>Recommended</T> : null}
              </View>
            </View>
          </Press>
        )
      })}
    </View>
  )
}

// --- schedule builder (JobsView.tsx ScheduleBuilder) ---------------------------------

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]
const INTERVAL_CHOICES = [
  { minutes: 15, label: '15 min' }, { minutes: 30, label: '30 min' }, { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' }, { minutes: 360, label: '6 hours' }, { minutes: 720, label: '12 hours' },
]
const WINDOW_STEPS = [
  { minutes: 10, label: '10 min' }, { minutes: 15, label: '15 min' }, { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' }, { minutes: 120, label: '2 hours' },
]

interface ScheduleValue {
  type: 'daily' | 'weekly' | 'interval' | 'window'
  time?: string
  days?: number[]
  everyMinutes?: number
  from?: string
  to?: string
}

// Mirrors windowSlotCount() in jobs/schedule.mjs.
function windowRuns(from: string, to: string, everyMinutes: number): number {
  const min = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const span = ((min(to) - min(from)) + 1440) % 1440
  return Math.floor(span / Math.max(1, everyMinutes)) + 1
}

/** "07:30" as "7:30 AM", the way an <input type="time"> shows it. */
function clock(t: string) {
  const [h, m] = t.split(':').map(Number)
  const d = new Date(2000, 0, 1, h || 0, m || 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * A time of day. There is no date-time picker in the app's dependencies, so a tap
 * asks for "HH:MM" in the system prompt; anything unparseable is ignored.
 */
function TimeField({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  async function ask() {
    const v = await prompt(label, { message: '24-hour time, e.g. 07:30', defaultValue: value })
    const m = v?.match(/^(\d{1,2}):?(\d{2})$/)
    if (!m) return
    const h = Number(m[1]); const mm = Number(m[2])
    if (h > 23 || mm > 59) return
    onChange(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`)
  }
  return (
    <Press haptic onPress={ask} accessibilityLabel={label} style={st.time}>
      <T size={13}>{clock(value)}</T>
    </Press>
  )
}

function Pill({ label, on, onPress, accent }: { label: string; on?: boolean; onPress: () => void; accent?: boolean }) {
  return (
    <Press haptic onPress={onPress} accessibilityState={{ selected: !!on }} style={[st.pill, on && st.pillOn]}>
      <T size={12} weight={on ? 600 : 400} color={accent ? colors.accent : on ? colors.text : colors.muted}>{label}</T>
    </Press>
  )
}

export function ScheduleBuilder({ value, onChange }: { value: ScheduleValue; onChange: (v: ScheduleValue) => void }) {
  const type = value.type
  // Falling back through `from` keeps the time already chosen when a window goes
  // back to a daily schedule, instead of resetting it to 08:00.
  const time = value.time || value.from || '08:00'
  const days = value.days || WEEKDAYS
  const everyMinutes = value.everyMinutes || 60
  const from = value.from || time
  const to = value.to || '11:30'
  const windowStep = value.everyMinutes || 30
  const runsPerDay = windowRuns(from, to, windowStep)

  const tabs = [
    { id: 'daily', label: 'Every day' },
    { id: 'weekly', label: 'Certain days' },
    { id: 'interval', label: 'On a repeat' },
    { id: 'window', label: 'Keep checking' },
  ] as const

  return (
    <View style={{ gap: 10 }}>
      <View style={st.tabs} accessibilityRole="tablist" accessibilityLabel="How often this job runs">
        {tabs.map((opt, i) => {
          const on = type === opt.id
          return (
            <Press
              key={opt.id}
              haptic
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={[st.tab, i < tabs.length - 1 && { borderRightWidth: 1, borderRightColor: colors.line }, on && { backgroundColor: alpha(colors.accent, 0.2) }]}
              onPress={() => onChange(
                opt.id === 'interval'
                  ? { type: 'interval', everyMinutes }
                  : opt.id === 'window'
                    ? { type: 'window', from, to, everyMinutes: windowStep, days }
                    : opt.id === 'weekly'
                      ? { type: 'weekly', time, days }
                      : { type: 'daily', time },
              )}
            >
              <T size={12.5} weight={on ? 600 : 400} color={on ? colors.text : colors.muted} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{opt.label}</T>
            </Press>
          )
        })}
      </View>

      {type === 'daily' || type === 'weekly' ? (
        <View style={st.inline}>
          <T size={13} muted>At</T>
          <TimeField value={time} label="Time of day to run" onChange={(t) => onChange({ ...value, type, time: t })} />
        </View>
      ) : null}

      {type === 'window' ? (
        <>
          <View style={[st.inline, { gap: 14, flexWrap: 'wrap' }]}>
            <View style={st.inline}>
              <T size={13} muted>Between</T>
              <TimeField value={from} label="Time the window opens" onChange={(t) => onChange({ ...value, type, from: t, to, everyMinutes: windowStep, days })} />
            </View>
            <View style={st.inline}>
              <T size={13} muted>and</T>
              <TimeField value={to} label="Time the window closes" onChange={(t) => onChange({ ...value, type, from, to: t, everyMinutes: windowStep, days })} />
            </View>
          </View>
          <View style={st.wrap}>
            <T size={13} muted style={{ marginRight: 2 }}>Check</T>
            {WINDOW_STEPS.map((c) => (
              <Pill key={c.minutes} label={c.label} on={windowStep === c.minutes} onPress={() => onChange({ ...value, type, from, to, everyMinutes: c.minutes, days })} />
            ))}
          </View>
          {/* The count is the thing that is easy to get wrong: every 10 minutes from
              7 to 11:30 is 28 runs, and if each costs an AI call that matters. */}
          <T size={12.5} muted lineHeight={18}>
            {runsPerDay} run{runsPerDay === 1 ? '' : 's'} per day
            {to === from ? ' — the window has no length, so this is a single run.' : '.'}
            {' '}It stops at the end of the window and starts again the next day.
          </T>
        </>
      ) : null}

      {type === 'weekly' || type === 'window' ? (
        <View style={st.wrap} accessibilityLabel="Days to run">
          {DAY_LABELS.map((label, idx) => {
            const on = days.includes(idx)
            return (
              <Pill
                key={label}
                label={label}
                on={on}
                onPress={() => {
                  const next = on ? days.filter((d) => d !== idx) : [...days, idx].sort()
                  // Zero days means never: refuse rather than save a schedule that cannot fire.
                  if (!next.length) return
                  onChange({ ...value, type, time, from, to, everyMinutes: type === 'window' ? windowStep : everyMinutes, days: next })
                }}
              />
            )
          })}
          <Pill label="Weekdays" accent onPress={() => onChange({ ...value, type, time, from, to, everyMinutes: type === 'window' ? windowStep : everyMinutes, days: WEEKDAYS })} />
        </View>
      ) : null}

      {type === 'interval' ? (
        <View style={st.wrap} accessibilityLabel="How often to repeat">
          {INTERVAL_CHOICES.map((c) => (
            <Pill key={c.minutes} label={c.label} on={everyMinutes === c.minutes} onPress={() => onChange({ type: 'interval', everyMinutes: c.minutes })} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

// --- run history (JobsView.tsx RunHistory) -----------------------------------------------

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function civilDay(ts: number, tz?: string) {
  return new Date(ts).toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz })
}

// A job's clock times belong to the scheduler's timezone, not the phone's.
function dayAndTime(ts: number, tz?: string) {
  const clockTime = new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz })
  const today = civilDay(Date.now(), tz)
  const key = civilDay(ts, tz)
  const tomorrow = civilDay(Date.now() + 86_400_000, tz)
  const day = key === today ? 'Today' : key === tomorrow ? 'Tomorrow'
    : new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })
  return `${day} ${clockTime}`
}

function RunPill({ status }: { status: string }) {
  const c = status === 'ok' ? colors.green : status === 'error' ? colors.red : colors.amber
  return (
    <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: alpha(c, 0.38) }}>
      <T size={11} weight={600} color={c}>{status}</T>
    </View>
  )
}

function RunTag({ label, late }: { label: string; late?: boolean }) {
  return (
    <View style={{ paddingVertical: 1, paddingHorizontal: 5, borderRadius: 999, borderWidth: 1, borderColor: late ? alpha(colors.amber, 0.38) : colors.line }}>
      <T size={10} color={late ? colors.amber : colors.muted}>{label}</T>
    </View>
  )
}

export function RunHistory({ jobId }: { jobId: string }) {
  const tz = useJobTimezone() || undefined
  const [runs, setRuns] = useState<any[] | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    getJobRuns(jobId, 20)
      .then((r: any) => { if (alive) setRuns(r.runs || []) })
      .catch((e) => { if (alive) setErr(e.message || String(e)) })
    return () => { alive = false }
  }, [jobId])

  if (err) {
    return (
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <Hi icon={ExclamationTriangleIcon} size={13} color={colors.amber} />
        <T size={12} muted>{err}</T>
      </View>
    )
  }
  if (!runs) return <T size={12} muted>Loading history…</T>
  if (!runs.length) return <T size={12} muted>No runs recorded yet.</T>

  // On a phone each run is two lines: when and the tags, then what it said.
  return (
    <View>
      {runs.map((r: any, i: number) => (
        <View key={`${r.ts}-${i}`} style={[st.run, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T size={12}>{dayAndTime(r.startedAt || r.ts, tz)}</T>
            <RunPill status={r.status} />
            {r.trigger === 'manual' ? <RunTag label="manual" /> : null}
            {r.late ? <RunTag label="caught up" late /> : null}
            {r.provider ? <RunTag label={r.provider} /> : null}
            {r.ms != null ? <T size={12} muted>{formatMs(r.ms)}</T> : null}
          </View>
          {r.error || r.preview ? (
            <T size={12} lineHeight={17} numberOfLines={3} color={r.status === 'error' ? colors.red : colors.muted}>{r.error || r.preview}</T>
          ) : null}
        </View>
      ))}
    </View>
  )
}

export const st = StyleSheet.create({
  icon: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg3 },
  kind: { alignSelf: 'flex-start', paddingVertical: 1, paddingHorizontal: 7, borderRadius: 999, backgroundColor: colors.bg3 },
  rec: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 11, paddingHorizontal: 14,
    borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg2,
  },
  recOn: { borderColor: alpha(colors.accent, 0.6), backgroundColor: '#18203a' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  // Full width on a phone: four tabs at their natural width overflow 390pt.
  tabs: { flexDirection: 'row', borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: 'hidden' },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 7, paddingHorizontal: 4, backgroundColor: colors.bg3 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  time: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg3 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  pill: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg3 },
  pillOn: { backgroundColor: alpha(colors.accent, 0.22), borderColor: alpha(colors.accent, 0.45) },
  run: { paddingVertical: 8, gap: 4 },
})
