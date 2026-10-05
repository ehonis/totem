import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getTodos, getCalendar, getHabits, getJobs, getAssistantUsage, getProductivity, getInboxCount, getGoals,
  closeTodo, logHabit, AuthError,
} from '../api'
import { useAiUsageLive } from '../useAiUsageLive'
import { DayModal, HabitCheckButton, HabitMetricInput, HabitMetricSection, QuotaDots, type DaySave } from './HabitsView'
import { send, setActive } from '../chat/store'
import { TI, ProviderLogo } from '../chat/ui'
import type { NavTarget } from '../router'
import { pushError } from '../toast'
import {
  IconArrowUp, IconChevronRight, IconRefresh, IconCalendarEvent, IconChecklist, IconFlame, IconTarget,
  IconListCheck, IconMicrophone2, IconBrandGithub, IconBrain, IconHistory, IconWand, IconSettings, IconInbox,
  IconAlertTriangle, IconMapPin, IconPlus, IconMinus, IconMessageCircle, IconCheck, IconBolt,
} from './overview/icons'
import { clock, dueDiff, dueLabel, periodTotal, startOfDay, until } from './overview/time'
import './overview/overview.css'
import { useOwnerName } from '../useOwnerName'

// Usage lives partway down Settings ▸ Providers; Jobs is Studio's second pane,
// whose route id is still 'workflows' for the sake of old links.
const USAGE_SECTION: NavTarget = { tab: 'settings', sub: 'providers', hash: 'usage' }
const JOBS_SECTION: NavTarget = { tab: 'settings', sub: 'jobs' }

type Tabler = React.ComponentType<any>

// Everything Totem has, one tap away. Code, Brain, Logs and Studio are no longer
// in the side nav, so this row is the way in to them.
const APPS: { id: string; label: string; icon: Tabler; to: NavTarget }[] = [
  { id: 'todos', label: 'Todos', icon: IconChecklist, to: { tab: 'productivity', app: 'todos' } },
  { id: 'calendar', label: 'Calendar', icon: IconCalendarEvent, to: { tab: 'productivity', app: 'calendar' } },
  { id: 'habits', label: 'Habits', icon: IconFlame, to: { tab: 'productivity', app: 'habits' } },
  { id: 'goals', label: 'Goals', icon: IconTarget, to: { tab: 'productivity', app: 'goals' } },
  { id: 'lists', label: 'Lists', icon: IconListCheck, to: { tab: 'productivity', app: 'lists' } },
  { id: 'journal', label: 'Journal', icon: IconMicrophone2, to: { tab: 'productivity', app: 'journal' } },
  { id: 'code', label: 'Code', icon: IconBrandGithub, to: 'code' },
  { id: 'brain', label: 'Brain', icon: IconBrain, to: 'brain' },
  { id: 'logs', label: 'Logs', icon: IconHistory, to: { tab: 'settings', sub: 'logs' } },
  { id: 'studio', label: 'Skills', icon: IconWand, to: { tab: 'settings', sub: 'skills' } },
  { id: 'settings', label: 'Settings', icon: IconSettings, to: 'settings' },
]

// Stored priority is 1..4 with 4 meaning P1.
const PRIORITY_CLASS: Record<number, string> = { 4: 'p1', 3: 'p2', 2: 'p3' }

// One tone per calendar account, by the order the accounts are configured in.
const ACCOUNT_TONE = ['', 'var(--accent-2)']

interface OverviewViewProps {
  onNavigate: (target: NavTarget) => void
  onAuthError: () => void
}

// ---------------------------------------------------------------------------
// Pieces

function Section({ title, meta, onOpen, openLabel = 'Open', className = '', children }: {
  title: string
  meta?: React.ReactNode
  onOpen?: () => void
  openLabel?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`ovx-card ${className}`.trim()}>
      <header className="ovx-card-head">
        <h2>{title}</h2>
        {meta != null && meta !== '' && <span className="ovx-card-meta">{meta}</span>}
        {onOpen && (
          <button type="button" className="ovx-link" onClick={onOpen}>
            {openLabel}<TI icon={IconChevronRight} size={15} />
          </button>
        )}
      </header>
      {children}
    </section>
  )
}

const Quiet = ({ children }: { children: React.ReactNode }) => <div className="ovx-quiet">{children}</div>
const Failed = ({ msg }: { msg: string }) => (
  <div className="ovx-quiet ovx-failed"><TI icon={IconAlertTriangle} size={15} />{msg}</div>
)
const Loading = () => (
  <div className="ovx-skel" aria-label="Loading"><span /><span /><span /></div>
)

function AskBox({ onAsk }: { onAsk: (text: string) => void }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const submit = () => {
    const t = text.trim()
    if (!t) return
    onAsk(t)
    setText('')
  }
  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])
  return (
    <form className="ovx-ask" onSubmit={(e) => { e.preventDefault(); submit() }}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder="Ask Totem anything"
        aria-label="Ask Totem"
        enterKeyHint="send"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
        }}
      />
      <button type="submit" className="ovx-ask-send" disabled={!text.trim()} aria-label="Send">
        <TI icon={IconArrowUp} size={18} stroke={2.25} />
      </button>
    </form>
  )
}

// One habit in the inline check-in: the same controls as the Habits tab.
function HabitRow({ habit, entry, count, periodCount, busy, onLog, onValue, onNote }: {
  habit: any; entry: any; count: number; periodCount: number; busy: boolean
  onLog: (habit: any, delta: number) => void
  onValue: (habit: any, value: number | null) => void
  onNote: (habit: any) => void
}) {
  const done = periodCount >= habit.target
  return (
    <div className={`ovx-habit${done ? ' done' : ''}`}>
      <span className="ovx-habit-dot" style={{ background: habit.color }} />
      <div className="ovx-habit-main">
        <div className="ovx-habit-name">{habit.name}</div>
        {entry?.note && <div className="ovx-habit-note">{entry.note}</div>}
      </div>
      {habit.cadence !== 'daily' && <QuotaDots habit={habit} count={periodCount} compact />}
      {habit.metric && <HabitMetricInput habit={habit} entry={entry} busy={busy} onValue={onValue} />}
      <button
        type="button"
        className={`ovx-icon-btn${entry?.note ? ' on' : ''}`}
        title={entry?.note ? `Note: ${entry.note}` : 'Add a note'}
        aria-label={entry?.note ? `Edit note for ${habit.name}` : `Add a note to ${habit.name}`}
        onClick={() => onNote(habit)}
      >
        <TI icon={IconMessageCircle} size={17} />
      </button>
      {habit.cadence === 'daily' && habit.target > 1 ? (
        <div className="ovx-stepper">
          <button type="button" onClick={() => onLog(habit, -1)} disabled={busy || count <= 0} aria-label={`Undo one ${habit.name}`}>
            <TI icon={IconMinus} size={15} />
          </button>
          <span style={count > 0 ? { color: habit.color } : undefined}>{count}<small>/{habit.target}</small></span>
          <button type="button" onClick={() => onLog(habit, +1)} disabled={busy} aria-label={`Log one ${habit.name}`}>
            <TI icon={IconPlus} size={15} />
          </button>
        </div>
      ) : (
        <HabitCheckButton habit={habit} count={count} periodCount={periodCount} busy={busy} onLog={onLog} />
      )}
    </div>
  )
}

function Bar({ value, tone }: { value: number; tone?: string }) {
  return (
    <span className="ovx-bar" aria-hidden>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%`, ...(tone ? { background: tone } : {}) }} />
    </span>
  )
}

// Headroom colour: the bar is always "what's left", so short means trouble.
const headroomTone = (pct: number) => (pct <= 10 ? 'var(--red)' : pct <= 30 ? 'var(--amber)' : 'var(--ovx-bar)')

// ---------------------------------------------------------------------------

export default function OverviewView({ onNavigate, onAuthError }: OverviewViewProps) {
  const ownerName = useOwnerName()
  const [data, setData] = useState<any>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [doneIds, setDoneIds] = useState<Set<string>>(() => new Set())
  const [habitBusy, setHabitBusy] = useState<Set<string>>(() => new Set())
  const [habitNote, setHabitNote] = useState<{ habit: any; date: string } | null>(null)
  const { data: ai } = useAiUsageLive({ onAuthError })
  // A clock that ticks once a minute keeps "now" and "in 20m" honest.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t) }, [])

  const load = useCallback(async () => {
    setRefreshing(true)
    const run = async (key: string, fn: () => Promise<any>): Promise<[string, any, string | null]> => {
      try { return [key, await fn(), null] }
      catch (e: any) {
        if (e instanceof AuthError) { onAuthError(); return [key, null, 'auth'] }
        return [key, null, e?.message || String(e)]
      }
    }
    const results = await Promise.all([
      run('todos', getTodos),
      run('habits', () => getHabits(40)),
      run('cal', () => getCalendar(3)),
      run('inbox', getInboxCount),
      run('week', () => getGoals('this_week')),
      run('month', () => getGoals('this_month')),
      run('jobs', () => getJobs()),
      run('assistant', getAssistantUsage),
      run('prod', getProductivity),
    ])
    const d: any = {}, e: Record<string, string> = {}
    for (const [k, v, err] of results) { d[k] = v; if (err) e[k] = err }
    setData(d); setErrs(e); setDoneIds(new Set()); setLoaded(true); setRefreshing(false)
  }, [onAuthError])
  useEffect(() => { load() }, [load])

  const ask = useCallback((text: string) => {
    const id = send({ text, kind: 'regular' })
    setActive(id)
    onNavigate('chat')
  }, [onNavigate])

  const completeTodo = useCallback(async (t: any) => {
    setDoneIds((s) => new Set(s).add(t.id))
    try {
      await closeTodo(t.id)
    } catch (e: any) {
      if (e instanceof AuthError) { onAuthError(); return }
      setDoneIds((s) => { const n = new Set(s); n.delete(t.id); return n })
      // A GitHub/Sheet-owned task can't be closed here; say so rather than flicker.
      pushError(e?.message || 'Could not complete that task')
    }
  }, [onAuthError])

  const habitWrite = useCallback(async (habitId: string, fields: any) => {
    if (habitBusy.has(habitId)) return
    setHabitBusy((s) => new Set(s).add(habitId))
    try {
      const payload = await logHabit({ id: habitId, ...fields })
      setData((d: any) => ({ ...d, habits: payload }))
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError()
      else pushError(e?.message || 'Could not log that habit')
    } finally {
      setHabitBusy((s) => { const n = new Set(s); n.delete(habitId); return n })
    }
  }, [habitBusy, onAuthError])

  const habitDay: string = data.habits?.today || ''
  const logDelta = useCallback((h: any, delta: number) => habitDay && habitWrite(h.id, { date: habitDay, delta }), [habitDay, habitWrite])
  const logValue = useCallback((h: any, value: number | null) => habitDay && habitWrite(h.id, { date: habitDay, value, complete: value !== null }), [habitDay, habitWrite])
  const saveHabitDay = useCallback(async ({ count, note, value, parts }: DaySave) => {
    if (!habitNote) return
    try {
      const payload = await logHabit({ id: habitNote.habit.id, date: habitNote.date, count, note, value, parts })
      setData((d: any) => ({ ...d, habits: payload }))
      setHabitNote(null)
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return }
      throw e // the modal shows it inline
    }
  }, [habitNote, onAuthError])

  // ---- calendar --------------------------------------------------------
  const today0 = startOfDay(now)
  const events: any[] = useMemo(
    () => [...(data.cal?.events || [])].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    [data.cal],
  )
  const dayOf = (ev: any) => startOfDay(ev.allDay ? new Date(`${ev.start.slice(0, 10)}T00:00`) : ev.start).getTime()
  const todayEvents = events.filter((ev) => dayOf(ev) === today0.getTime())
  const tomorrow0 = new Date(today0); tomorrow0.setDate(tomorrow0.getDate() + 1)
  const tomorrowEvents = events.filter((ev) => dayOf(ev) === tomorrow0.getTime())
  const allDayToday = todayEvents.filter((ev) => ev.allDay)
  const timedToday = todayEvents.filter((ev) => !ev.allDay)
  const remaining = timedToday.filter((ev) => new Date(ev.end || ev.start) > now)
  // A long day drops what's already over; a short one keeps it, dimmed, so the
  // list still reads as the shape of the day.
  const timedShown = (timedToday.length > 5 ? remaining : timedToday).slice(0, 6)
  const showTomorrow = remaining.length < 3 && tomorrowEvents.length > 0

  // ---- todos -----------------------------------------------------------
  const todos: any[] = useMemo(() => (data.todos?.todos || []).filter((t: any) => !doneIds.has(t.id)), [data.todos, doneIds])
  const byUrgency = (a: any, b: any) => dueDiff(a.due) - dueDiff(b.due) || (b.priority || 1) - (a.priority || 1)
  const overdue = todos.filter((t) => t.due && dueDiff(t.due) < 0).sort(byUrgency)
  const dueToday = todos.filter((t) => t.due && dueDiff(t.due) === 0).sort(byUrgency)
  const focus = [...dueToday, ...overdue]
  // Nothing due: show what's next instead of a blank card.
  const upNext = focus.length ? [] : [...todos].sort((a, b) =>
    (a.due ? dueDiff(a.due) : 9999) - (b.due ? dueDiff(b.due) : 9999) || (b.priority || 1) - (a.priority || 1)).slice(0, 4)
  const taskShown = (focus.length ? focus : upNext).slice(0, 6)

  // ---- habits ----------------------------------------------------------
  const entries = data.habits?.entries || {}
  const habits: any[] = (data.habits?.habits || []).filter((h: any) => !h.archived)
  const habitsLeft = habits.filter((h) => periodTotal(h, entries, habitDay) < h.target && !(entries[habitDay]?.[h.id]?.count > 0))
  const habitsDoneToday = habits.length - habitsLeft.length
  const pinned = habits.filter((h) => h.metric?.pinned)

  // ---- goals -----------------------------------------------------------
  const live = (g: any) => !g.abandoned
  const weekGoals: any[] = (data.week?.goals || []).filter(live)
  const monthGoals: any[] = (data.month?.goals || []).filter(live)
  const goalGroups = [
    { key: 'week', label: 'This week', goals: weekGoals },
    { key: 'month', label: data.month?.period?.label || 'This month', goals: monthGoals },
  ].filter((g) => g.goals.length)

  // ---- system ----------------------------------------------------------
  const jobs: any[] = data.jobs?.jobs || []
  const jobsOn = jobs.filter((j) => j.enabled)
  const failing = jobsOn.filter((j) => j.lastRun?.status === 'error')
  const nextJob = jobsOn.filter((j) => j.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt)[0]
  const accounts: any[] = ai?.ok ? (ai.accounts || []) : []
  const tightest = (acct: any) => [...(acct.meters || [])].filter((m: any) => m.remainingPct != null)
    .sort((a: any, b: any) => a.remainingPct - b.remainingPct)[0]
  const lowAccounts = accounts.filter((a) => { const m = tightest(a); return m && m.remainingPct <= 15 })
  const inboxOpen: number = data.inbox?.open || 0

  const daily = useMemo(() => {
    const a: any[] = data.assistant?.daily || []
    const p: any[] = data.prod?.daily || []
    const byDate = new Map<string, { ai: number; work: number }>()
    for (const r of a) byDate.set(r.date, { ai: r.count || 0, work: 0 })
    for (const r of p) byDate.set(r.date, { ai: byDate.get(r.date)?.ai || 0, work: r.count || 0 })
    return [...byDate.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).slice(-14).map(([date, v]) => ({ date, ...v }))
  }, [data.assistant, data.prod])
  const dailyMax = Math.max(1, ...daily.map((d) => d.ai + d.work))

  // ---- header ----------------------------------------------------------
  const hour = now.getHours()
  const greeting = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const summary: string[] = []
  if (data.cal) summary.push(remaining.length ? `${remaining.length} ${remaining.length === 1 ? 'event' : 'events'} left today` : 'No more events today')
  if (data.todos) summary.push(focus.length ? `${focus.length} ${focus.length === 1 ? 'task' : 'tasks'} due` : 'nothing due')
  if (data.habits && habits.length) summary.push(habitsLeft.length ? `${habitsLeft.length} ${habitsLeft.length === 1 ? 'habit' : 'habits'} to go` : 'habits done')

  const attention: { key: string; icon: Tabler; text: React.ReactNode; tone: 'warn' | 'info'; to: NavTarget }[] = []
  if (inboxOpen) attention.push({
    key: 'inbox', icon: IconInbox, tone: 'info', to: 'inbox',
    text: <><b>{inboxOpen} {inboxOpen === 1 ? 'proposal' : 'proposals'}</b> waiting in your inbox</>,
  })
  for (const j of failing.slice(0, 2)) attention.push({
    key: `job-${j.id}`, icon: IconAlertTriangle, tone: 'warn', to: JOBS_SECTION,
    text: <><b>{j.name}</b> failed {j.lastRun?.ts ? relAgo(j.lastRun.ts) : ''}{j.lastRun?.error ? <span className="ovx-attn-sub"> · {j.lastRun.error}</span> : null}</>,
  })
  for (const a of lowAccounts) {
    const m = tightest(a)
    attention.push({
      key: `ai-${a.id}`, icon: IconBolt, tone: 'warn', to: USAGE_SECTION,
      text: <><b>{a.displayName || a.label}</b> is down to {Math.round(m.remainingPct)}% of its {m.label.toLowerCase()}{m.resetsAt ? `, resets ${until(m.resetsAt)}` : ''}</>,
    })
  }

  return (
    <div className="ovx">
      <div className="ovx-inner">
        <header className="ovx-head">
          <div className="ovx-head-text">
            <h1>{ownerName ? `${greeting}, ${ownerName}` : greeting}</h1>
            <p>
              {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
              {summary.length > 0 && (
                <span className="ovx-head-sum"><span className="ovx-sep"> · </span>{cap(summary.join(', '))}</span>
              )}
            </p>
          </div>
          <button
            type="button"
            className={`ovx-icon-btn ovx-refresh${refreshing ? ' spin' : ''}`}
            onClick={load}
            aria-label="Refresh"
            title="Refresh"
          >
            <TI icon={IconRefresh} size={18} />
          </button>
        </header>

        <AskBox onAsk={ask} />

        {attention.length > 0 && (
          <div className="ovx-attn">
            {attention.map((a) => (
              <button type="button" key={a.key} className={`ovx-attn-row ${a.tone}`} onClick={() => onNavigate(a.to)}>
                <span className="ovx-attn-ico"><TI icon={a.icon} size={16} /></span>
                <span className="ovx-attn-text">{a.text}</span>
                <TI icon={IconChevronRight} size={16} className="ovx-attn-go" />
              </button>
            ))}
          </div>
        )}

        <nav className="ovx-apps" aria-label="Apps">
          {APPS.map((app) => (
            <button type="button" key={app.id} className="ovx-app" onClick={() => onNavigate(app.to)}>
              <span className="ovx-app-ico"><TI icon={app.icon} size={21} /></span>
              <span className="ovx-app-label">{app.label}</span>
            </button>
          ))}
        </nav>

        <div className="ovx-grid">
          <div className="ovx-col">
            <Section
              title="Schedule"
              meta={data.cal ? (todayEvents.length ? `${todayEvents.length} today` : '') : null}
              onOpen={() => onNavigate({ tab: 'productivity', app: 'calendar' })}
            >
              {errs.cal ? <Failed msg={errs.cal} />
                : !data.cal ? <Loading />
                : (
                  <div className="ovx-events">
                    {allDayToday.length > 0 && (
                      <div className="ovx-allday">
                        {allDayToday.map((ev) => <span key={ev.id} className="ovx-chip">{ev.title}</span>)}
                      </div>
                    )}
                    {timedShown.map((ev) => {
                      const start = new Date(ev.start), end = new Date(ev.end || ev.start)
                      const past = end <= now
                      const current = start <= now && end > now
                      return (
                        <button
                          type="button"
                          key={ev.id}
                          className={`ovx-event${past ? ' past' : ''}${current ? ' now' : ''}`}
                          onClick={() => onNavigate({ tab: 'productivity', app: 'calendar' })}
                        >
                          <span className="ovx-event-time">{clock(start)}</span>
                          <span className="ovx-event-rule" style={{ background: ACCOUNT_TONE[(ev.accountIndex ?? 0) % ACCOUNT_TONE.length] || undefined }} />
                          <span className="ovx-event-main">
                            <span className="ovx-event-title">{ev.title}</span>
                            <span className="ovx-event-sub">
                              {current ? <span className="ovx-now">Now · until {clock(end)}</span>
                                : !past && start > now ? <span>{until(start.getTime())} · until {clock(end)}</span>
                                : <span>until {clock(end)}</span>}
                              {ev.location && <span className="ovx-event-loc"><TI icon={IconMapPin} size={12} />{ev.location.split(',')[0]}</span>}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                    {!timedShown.length && !allDayToday.length && <Quiet>Nothing on the calendar today.</Quiet>}
                    {showTomorrow && (
                      <>
                        <div className="ovx-subhead">Tomorrow</div>
                        {tomorrowEvents.slice(0, 3).map((ev) => (
                          <button type="button" key={ev.id} className="ovx-event later" onClick={() => onNavigate({ tab: 'productivity', app: 'calendar' })}>
                            <span className="ovx-event-time">{ev.allDay ? 'All day' : clock(new Date(ev.start))}</span>
                            <span className="ovx-event-rule" style={{ background: ACCOUNT_TONE[(ev.accountIndex ?? 0) % ACCOUNT_TONE.length] || undefined }} />
                            <span className="ovx-event-main"><span className="ovx-event-title">{ev.title}</span></span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
            </Section>

            <Section
              title="Tasks"
              meta={data.todos ? (overdue.length ? <span className="ovx-overdue">{overdue.length} overdue</span> : `${todos.length} open`) : null}
              onOpen={() => onNavigate({ tab: 'productivity', app: 'todos' })}
            >
              {errs.todos ? <Failed msg={errs.todos} />
                : !data.todos ? <Loading />
                : !todos.length ? <Quiet>No open tasks.</Quiet>
                : (
                  <div className="ovx-tasks">
                    {!focus.length && <div className="ovx-subhead first">Nothing due today. Up next</div>}
                    {taskShown.map((t) => {
                      const diff = t.due ? dueDiff(t.due) : null
                      return (
                        <div className="ovx-task" key={t.id}>
                          <button
                            type="button"
                            className={`ovx-check ${PRIORITY_CLASS[t.priority] || ''}`}
                            onClick={() => completeTodo(t)}
                            aria-label={`Complete ${t.content}`}
                            title="Mark complete"
                          >
                            <TI icon={IconCheck} size={13} stroke={2.5} />
                          </button>
                          <button type="button" className="ovx-task-open" onClick={() => onNavigate({ tab: 'productivity', app: 'todos' })}>
                            <span className="ovx-task-title">{t.content}</span>
                            {t.due && (
                              <span className={`ovx-due${diff! < 0 ? ' late' : diff === 0 ? ' today' : ''}`}>{dueLabel(t.due)}</span>
                            )}
                          </button>
                        </div>
                      )
                    })}
                    {focus.length > taskShown.length && (
                      <button type="button" className="ovx-more" onClick={() => onNavigate({ tab: 'productivity', app: 'todos' })}>
                        {focus.length - taskShown.length} more due
                      </button>
                    )}
                  </div>
                )}
            </Section>
            <Section title="Goals" meta={data.week?.period?.label} onOpen={() => onNavigate({ tab: 'productivity', app: 'goals' })}>
              {errs.week ? <Failed msg={errs.week} />
                : !data.week ? <Loading />
                : !goalGroups.length ? (
                  <div className="ovx-empty-action">
                    <Quiet>No goals set for this week or month.</Quiet>
                    <button type="button" className="ovx-pill-btn" onClick={() => onNavigate({ tab: 'productivity', app: 'goals' })}>
                      <TI icon={IconPlus} size={15} />Plan the week
                    </button>
                  </div>
                )
                : (
                  <div className="ovx-goals">
                    {goalGroups.map((group) => (
                      <div key={group.key} className="ovx-goal-group">
                        {goalGroups.length > 1 && <div className="ovx-subhead">{group.label}</div>}
                        {group.goals.slice(0, 4).map((g) => {
                          const pct = g.progress?.percent ?? (g.complete ? 100 : 0)
                          const steps = g.progress?.subGoalsTotal
                          return (
                            <button type="button" key={g.id} className={`ovx-goal${g.complete ? ' done' : ''}`} onClick={() => onNavigate({ tab: 'productivity', app: 'goals' })}>
                              <span className="ovx-goal-top">
                                <span className="ovx-goal-title">{g.title}</span>
                                <span className="ovx-goal-pct">{g.complete ? 'Done' : `${Math.round(pct)}%`}</span>
                              </span>
                              <Bar value={g.complete ? 100 : pct} tone={g.complete ? 'var(--green)' : undefined} />
                              {steps ? <span className="ovx-goal-sub">{g.progress.subGoalsDone} of {steps} steps</span> : null}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
            </Section>
          </div>

          <div className="ovx-col">
            <Section
              title="Habits"
              meta={data.habits && habits.length ? `${habitsDoneToday} of ${habits.length} done` : null}
              onOpen={() => onNavigate({ tab: 'productivity', app: 'habits' })}
            >
              {errs.habits ? <Failed msg={errs.habits} />
                : !data.habits ? <Loading />
                : !habits.length ? <Quiet>No habits yet. Add one in Habits, or ask Totem.</Quiet>
                : (
                  <div className="ovx-habits">
                    {habits.slice(0, 8).map((h) => (
                      <HabitRow
                        key={h.id}
                        habit={h}
                        entry={entries[habitDay]?.[h.id]}
                        count={entries[habitDay]?.[h.id]?.count || 0}
                        periodCount={periodTotal(h, entries, habitDay)}
                        busy={habitBusy.has(h.id)}
                        onLog={logDelta}
                        onValue={logValue}
                        onNote={(habit) => setHabitNote({ habit, date: habitDay })}
                      />
                    ))}
                    {habits.length > 8 && (
                      <button type="button" className="ovx-more" onClick={() => onNavigate({ tab: 'productivity', app: 'habits' })}>
                        {habits.length - 8} more
                      </button>
                    )}
                  </div>
                )}
            </Section>

          </div>
        </div>

        {pinned.length > 0 && (
          <div className="ovx-pinned">
            {pinned.map((h) => (
              <Section key={h.id} className="ovx-metric" title={h.metric.label} meta={h.name !== h.metric.label ? `from ${h.name}` : null} onOpen={() => onNavigate({ tab: 'productivity', app: 'habits' })}>
                <HabitMetricSection habit={h} entries={entries} today={habitDay} compact days={30} />
              </Section>
            ))}
          </div>
        )}

        <section className="ovx-system" aria-label="Totem">
          <button type="button" className="ovx-sys" onClick={() => onNavigate(USAGE_SECTION)}>
            <span className="ovx-sys-head">AI limits<TI icon={IconChevronRight} size={15} /></span>
            {!ai ? <Loading />
              : !ai.ok ? <span className="ovx-quiet">{(ai as any).error || 'Quota unavailable'}</span>
              : (
                <span className="ovx-quota">
                  {accounts.map((acct) => {
                    const m = tightest(acct)
                    return (
                      <span className="ovx-quota-row" key={acct.id}>
                        <ProviderLogo driver={acct.backend} name={acct.displayName || acct.label} size={15} />
                        <span className="ovx-quota-name">{acct.displayName || acct.label}</span>
                        {m ? (
                          <>
                            <Bar value={m.remainingPct} tone={headroomTone(m.remainingPct)} />
                            <span className="ovx-quota-pct">{Math.round(m.remainingPct)}%</span>
                          </>
                        ) : <span className="ovx-quota-pct muted">{acct.status === 'ok' ? '—' : 'error'}</span>}
                      </span>
                    )
                  })}
                </span>
              )}
          </button>

          <button type="button" className="ovx-sys" onClick={() => onNavigate(JOBS_SECTION)}>
            <span className="ovx-sys-head">Jobs<TI icon={IconChevronRight} size={15} /></span>
            {errs.jobs ? <span className="ovx-quiet">{errs.jobs}</span>
              : !data.jobs ? <Loading />
              : (
                <>
                  <span className="ovx-sys-value">
                    <span className={`ovx-dot ${failing.length ? 'bad' : 'good'}`} />
                    {failing.length ? `${failing.length} failing` : 'All healthy'}
                  </span>
                  <span className="ovx-sys-sub">{jobsOn.length} of {jobs.length} on</span>
                  {nextJob && <span className="ovx-sys-sub">Next: {nextJob.name} {until(nextJob.nextRunAt)}</span>}
                </>
              )}
          </button>

          <button type="button" className="ovx-sys" onClick={() => onNavigate(USAGE_SECTION)}>
            <span className="ovx-sys-head">Activity<TI icon={IconChevronRight} size={15} /></span>
            {!data.assistant && !data.prod ? (loaded ? <span className="ovx-quiet">Unavailable</span> : <Loading />)
              : (
                <>
                  <span className="ovx-sys-value">
                    {data.assistant?.today ?? 0} <small>requests today</small>
                  </span>
                  <span className="ovx-spark" role="img" aria-label="Requests and actions over the last 14 days">
                    {daily.map((d) => (
                      <span key={d.date} className="ovx-spark-col" title={`${d.date}: ${d.ai} AI requests, ${d.work} actions`}>
                        <span className="w" style={{ height: `${(d.work / dailyMax) * 100}%` }} />
                        <span className="a" style={{ height: `${(d.ai / dailyMax) * 100}%` }} />
                      </span>
                    ))}
                  </span>
                  <span className="ovx-sys-sub">
                    <span className="ovx-key a" />AI <span className="ovx-key w" />Actions · last 14 days
                  </span>
                </>
              )}
          </button>
        </section>
      </div>

      {habitNote && (
        <DayModal
          habit={habitNote.habit}
          date={habitNote.date}
          entry={entries[habitNote.date]?.[habitNote.habit.id]}
          onClose={() => setHabitNote(null)}
          onSave={saveHabitDay}
        />
      )}
    </div>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function relAgo(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
