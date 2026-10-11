// The landing screen: the web's OverviewView at its phone layout. A calm read of
// the day — greeting, ask box, what needs you, the apps row, then Schedule,
// Tasks, Goals and Habits, pinned habit charts, and the system strip.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, AppState, Easing, Image as RNImage, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { Image } from 'expo-image'
import { useFocusEffect } from 'expo-router'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { navigateTo, openChat } from '../../shell/nav'
import { colors, alpha, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Badge, Press } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import {
  getTodos, getCalendar, getHabits, getJobs, getAssistantUsage, getProductivity, getInboxCount, getGoals,
  closeTodo, moveBoardTodo, logHabit, AuthError,
} from '../../lib/api'
import { clearSecretStored } from '../../lib/connection'
import { useAiUsageLive } from '../../lib/useAiUsageLive'
import { useOwnerName } from '../../lib/useOwnerName'
import { send } from '../../lib/chat/store'
import { pushError, pushToast } from '../../lib/toast'
import { DRIVER_LOGOS } from '../../lib/providers'
import {
  IconArrowUp, IconChevronRight, IconRefresh, IconCalendarEvent, IconChecklist, IconFlame, IconTarget,
  IconListCheck, IconMicrophone2, IconHistory, IconWand, IconSettings, IconInbox,
  IconAlertTriangle, IconMapPin, IconPlus, IconCheck, IconBolt,
} from '../../lib/components/overview/icons'
import IconSearch from '@tabler/icons-react-native/dist/esm/icons/IconSearch.mjs'
import { clock, dueDiff, dueLabel, periodTotal, startOfDay, until } from '../../lib/components/overview/time'
import { ov, TI, Section, Quiet, Failed, Loading, Bar, Subhead, More } from './parts'
import { HabitRow } from './HabitRow'
import { HabitMetricSection } from './MetricTile'
import { openHabitDay, type DaySave } from './HabitDaySheet'

type NavTarget = Parameters<typeof navigateTo>[0]
type Tabler = React.ComponentType<any>

// Usage lives partway down Settings ▸ Providers; Jobs is its own settings pane.
const USAGE_SECTION: NavTarget = { tab: 'settings', sub: 'providers', hash: 'usage' }
const JOBS_SECTION: NavTarget = { tab: 'settings', sub: 'jobs' }

// The sidebar's Totems mark (the web's TotemsIcon), tinted like a Tabler glyph.
function TotemsGlyph({ size = 21, color }: { size?: number; color?: string }) {
  return <RNImage source={require('../../../assets/images/totems-icon.png')} style={{ width: size, height: size, tintColor: color }} />
}

// Everything Totem has, one tap away. The phone's drawer has no tabs, so this row
// is the way to every screen: Inbox, Search and Totems sit where the web lists Code
// and Brain, which the app has no screen for yet (left out rather than dead-ending).
const APPS: { id: string; label: string; icon: Tabler; to: NavTarget }[] = [
  { id: 'todos', label: 'Todos', icon: IconChecklist, to: { tab: 'productivity', app: 'todos' } },
  { id: 'calendar', label: 'Calendar', icon: IconCalendarEvent, to: { tab: 'productivity', app: 'calendar' } },
  { id: 'habits', label: 'Habits', icon: IconFlame, to: { tab: 'productivity', app: 'habits' } },
  { id: 'goals', label: 'Goals', icon: IconTarget, to: { tab: 'productivity', app: 'goals' } },
  { id: 'lists', label: 'Lists', icon: IconListCheck, to: { tab: 'productivity', app: 'lists' } },
  { id: 'journal', label: 'Journal', icon: IconMicrophone2, to: { tab: 'productivity', app: 'journal' } },
  { id: 'inbox', label: 'Inbox', icon: IconInbox, to: 'inbox' },
  { id: 'search', label: 'Search', icon: IconSearch, to: 'search' },
  { id: 'totems', label: 'Totems', icon: TotemsGlyph, to: 'totems' },
  { id: 'logs', label: 'Logs', icon: IconHistory, to: { tab: 'settings', sub: 'logs' } },
  { id: 'studio', label: 'Skills', icon: IconWand, to: { tab: 'settings', sub: 'skills' } },
  { id: 'settings', label: 'Settings', icon: IconSettings, to: 'settings' },
]

// Stored priority is 1..4 with 4 meaning P1.
const PRIORITY_TONE: Record<number, string> = { 4: colors.red, 3: colors.amber, 2: colors.accent }

// One tone per calendar account, by the order the accounts are configured in.
const ACCOUNT_TONE = [colors.accent, colors.accent2]
const toneOf = (ev: any) => ACCOUNT_TONE[(ev.accountIndex ?? 0) % ACCOUNT_TONE.length]

// The WHOOP-synced sleep habit is read in Bushido and logged by its sync, never by
// hand, so the Overview leaves it out (HabitsView.tsx isSyncedSleep).
const isSyncedSleep = (h: any) => h.metric?.source === 'whoop-sleep'

// Headroom colour: the bar is always "what's left", so short means trouble.
const headroomTone = (pct: number) => (pct <= 10 ? colors.red : pct <= 30 ? colors.amber : ov.bar)

// A reload when the screen comes back into view, unless the last one is this fresh.
const STALE_MS = 30_000

const onAuthError = () => { void clearSecretStored() }

export default function OverviewScreen() {
  const ownerName = useOwnerName()
  const [data, setData] = useState<any>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [doneIds, setDoneIds] = useState<Set<string>>(() => new Set())
  const [checking, setChecking] = useState<Set<string>>(() => new Set())
  const [habitBusy, setHabitBusy] = useState<Set<string>>(() => new Set())
  const { data: ai } = useAiUsageLive({ onAuthError })
  const loadedAt = useRef(0)
  // What is on screen now, for load() to fall back on (habit logs write to data too).
  const dataRef = useRef<any>({})
  dataRef.current = data
  // A clock that ticks once a minute keeps "now" and "in 20m" honest.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t) }, [])

  const load = useCallback(async () => {
    setRefreshing(true)
    loadedAt.current = Date.now()
    const run = async (key: string, fn: () => Promise<any>): Promise<[string, any, string | null]> => {
      try { return [key, await fn(), null] } catch (e: any) {
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
    // A refresh updates in place: a section whose reload fails keeps what it last
    // showed rather than turning into an error card, and only a section that never
    // loaded says it failed.
    const prev = dataRef.current
    const d: any = {}, e: Record<string, string> = {}
    for (const [k, v, err] of results) {
      d[k] = err && prev[k] != null ? prev[k] : v
      if (err && prev[k] == null) e[k] = err
    }
    setData(d); setErrs(e); setDoneIds(new Set()); setChecking(new Set()); setLoaded(true); setRefreshing(false); setPulling(false)
  }, [])
  useEffect(() => { load() }, [load])

  // Drawer screens stay mounted, so coming back here (or to the app) would show
  // whatever was true when it first opened. Refresh then, if it has gone stale.
  const loadIfStale = useCallback(() => { if (Date.now() - loadedAt.current > STALE_MS) load() }, [load])
  useFocusEffect(loadIfStale)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') { setNow(new Date()); loadIfStale() } })
    return () => sub.remove()
  }, [loadIfStale])

  const ask = useCallback((text: string) => {
    const id = send({ text, kind: 'regular' })
    openChat(id)
  }, [])

  const completeTodo = useCallback(async (t: any) => {
    success()
    // Fill the circle first so the tap reads as done, then let the row go.
    setChecking((s) => new Set(s).add(t.id))
    setTimeout(() => setDoneIds((s) => new Set(s).add(t.id)), 350)
    try {
      await closeTodo(t.id)
      // A recurring task rolls forward rather than closing, and a linked one is its
      // connector's to reopen, so only a plain local task offers Undo.
      const undoable = !t.isRecurring && !t.url
      pushToast(`Completed “${t.content}”`, 'success', {
        duration: 5000,
        action: undoable ? {
          label: 'Undo',
          onClick: async () => {
            try {
              await moveBoardTodo(t.id, 'todo')
              setDoneIds((s) => { const n = new Set(s); n.delete(t.id); return n })
              setChecking((s) => { const n = new Set(s); n.delete(t.id); return n })
            } catch (e: any) {
              if (e instanceof AuthError) onAuthError()
              else pushError(e?.message || 'Could not reopen that task')
            }
          },
        } : undefined,
      })
    } catch (e: any) {
      if (e instanceof AuthError) { onAuthError(); return }
      setDoneIds((s) => { const n = new Set(s); n.delete(t.id); return n })
      setChecking((s) => { const n = new Set(s); n.delete(t.id); return n })
      // A GitHub/Sheet-owned task can't be closed here; say so rather than flicker.
      pushError(e?.message || 'Could not complete that task')
    }
  }, [])

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
  }, [habitBusy])

  const habitDay: string = data.habits?.today || ''
  // A habit an app fills in (linkedApp) is never logged by hand; its row links out instead.
  const logDelta = useCallback((h: any, delta: number) => {
    if (!habitDay || h.linkedApp) return
    if (delta > 0) success(); else tap()
    habitWrite(h.id, { date: habitDay, delta })
  }, [habitDay, habitWrite])
  const logValue = useCallback((h: any, value: number | null) => {
    if (habitDay && !h.linkedApp) habitWrite(h.id, { date: habitDay, value, complete: value !== null })
  }, [habitDay, habitWrite])
  const openNote = useCallback((habit: any) => {
    if (!habitDay || habit.linkedApp) return
    openHabitDay({
      habit,
      date: habitDay,
      entry: data.habits?.entries?.[habitDay]?.[habit.id],
      onSave: async ({ count, note, value, parts }: DaySave) => {
        try {
          const payload = await logHabit({ id: habit.id, date: habitDay, count, note, value, parts })
          setData((d: any) => ({ ...d, habits: payload }))
        } catch (e) {
          if (e instanceof AuthError) { onAuthError(); return }
          throw e // the sheet shows it and stays open
        }
      },
    })
  }, [habitDay, data.habits])

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
  // A long day drops what's already over; a short one keeps it, dimmed.
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
  const habits: any[] = (data.habits?.habits || []).filter((h: any) => !h.archived && !isSyncedSleep(h))
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

  const B = ({ children }: { children: React.ReactNode }) => <T size={14} weight={600} color={colors.text}>{children}</T>
  const attention: { key: string; icon: Tabler; text: React.ReactNode; tone: 'warn' | 'info'; to: NavTarget }[] = []
  if (inboxOpen) attention.push({
    key: 'inbox', icon: IconInbox, tone: 'info', to: 'inbox',
    text: <><B>{inboxOpen} {inboxOpen === 1 ? 'proposal' : 'proposals'}</B> waiting in your inbox</>,
  })
  for (const j of failing.slice(0, 2)) attention.push({
    key: `job-${j.id}`, icon: IconAlertTriangle, tone: 'warn', to: JOBS_SECTION,
    text: <><B>{j.name}</B> failed {j.lastRun?.ts ? relAgo(j.lastRun.ts) : ''}{j.lastRun?.error ? <T size={14} color={ov.faint}> · {j.lastRun.error}</T> : null}</>,
  })
  for (const a of lowAccounts) {
    const m = tightest(a)
    attention.push({
      key: `ai-${a.id}`, icon: IconBolt, tone: 'warn', to: USAGE_SECTION,
      text: <><B>{a.displayName || a.label}</B> is down to {Math.round(m.remainingPct)}% of its {m.label.toLowerCase()}{m.resetsAt ? `, resets ${until(m.resetsAt)}` : ''}</>,
    })
  }

  const openCalendar = () => navigateTo({ tab: 'productivity', app: 'calendar' })
  const openTodos = () => navigateTo({ tab: 'productivity', app: 'todos' })
  const openGoals = () => navigateTo({ tab: 'productivity', app: 'goals' })
  const openHabits = () => navigateTo({ tab: 'productivity', app: 'habits' })

  return (
    <Screen title="Overview" glow="overview">
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={st.inner}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl refreshing={pulling} onRefresh={() => { setPulling(true); load() }} tintColor={colors.muted} />
        }
      >
        <View style={st.head}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={24} weight={600} color={colors.text} style={{ letterSpacing: -0.36 }} lineHeight={29}>
              {ownerName ? `${greeting}, ${ownerName}` : greeting}
            </T>
            <T size={14} color={ov.soft} style={{ marginTop: 4 }}>
              {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </T>
            {summary.length > 0 && <T size={14} color={ov.faint}>{cap(summary.join(', '))}</T>}
          </View>
          <RefreshButton spinning={refreshing} onPress={load} />
        </View>

        <AskBox onAsk={ask} />

        {attention.length > 0 && (
          <View style={st.attn}>
            {attention.map((a, i) => (
              <Press key={a.key} haptic onPress={() => navigateTo(a.to)} style={[st.attnRow, i > 0 && { borderTopWidth: 1, borderTopColor: ov.line }]}>
                <View style={[st.attnIco, { backgroundColor: alpha(a.tone === 'info' ? colors.accent : colors.amber, 0.14) }]}>
                  <TI icon={a.icon} size={16} color={a.tone === 'info' ? colors.accent : colors.amber} />
                </View>
                <T size={14} color={ov.soft} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{a.text}</T>
                <TI icon={IconChevronRight} size={16} color={ov.faint} />
              </Press>
            ))}
          </View>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.apps} contentContainerStyle={st.appsInner}>
          {APPS.map((app) => (
            <Press key={app.id} haptic onPress={() => navigateTo(app.to)} style={st.app} accessibilityRole="button" accessibilityLabel={app.label}>
              <View style={st.appIco}>
                <TI icon={app.icon} size={21} color={ov.soft} />
                {app.id === 'inbox' && inboxOpen ? <View style={st.appBadge}><Badge count={inboxOpen} /></View> : null}
              </View>
              <T size={12.5} color={ov.soft} numberOfLines={1}>{app.label}</T>
            </Press>
          ))}
        </ScrollView>

        <Section
          title="Schedule"
          meta={data.cal ? (todayEvents.length ? `${todayEvents.length} today` : '') : null}
          onOpen={openCalendar}
        >
          {errs.cal ? <Failed msg={errs.cal} />
            : !data.cal ? <Loading />
            : (
              <View>
                {allDayToday.length > 0 && (
                  <View style={st.allday}>
                    {allDayToday.map((ev) => (
                      <View key={ev.id} style={st.chip}><T size={12.5} color={ov.soft} numberOfLines={1}>{ev.title}</T></View>
                    ))}
                  </View>
                )}
                {timedShown.map((ev) => {
                  const start = new Date(ev.start), end = new Date(ev.end || ev.start)
                  const past = end <= now
                  const current = start <= now && end > now
                  return (
                    <Press key={ev.id} onPress={openCalendar} style={st.event}>
                      <T size={13.5} color={past ? ov.faint : ov.soft} style={st.eventTime}>{clock(start)}</T>
                      <View style={[st.rule, { backgroundColor: toneOf(ev), opacity: past ? 0.3 : 0.85 }]} />
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <T size={14.5} color={past ? ov.faint : colors.text} numberOfLines={1}>{ev.title}</T>
                        <View style={st.eventSub}>
                          {current ? <T size={12.5} color={colors.green}>Now · until {clock(end)}</T>
                            : !past && start > now ? <T size={12.5} color={ov.faint}>{until(start.getTime())} · until {clock(end)}</T>
                            : <T size={12.5} color={ov.faint}>until {clock(end)}</T>}
                          {ev.location ? (
                            <View style={st.loc}>
                              <TI icon={IconMapPin} size={12} color={ov.faint} />
                              <T size={12.5} color={ov.faint} numberOfLines={1} style={{ flexShrink: 1 }}>{ev.location.split(',')[0]}</T>
                            </View>
                          ) : null}
                        </View>
                      </View>
                    </Press>
                  )
                })}
                {!timedShown.length && !allDayToday.length && <Quiet>Nothing on the calendar today.</Quiet>}
                {showTomorrow && (
                  <>
                    <Subhead>Tomorrow</Subhead>
                    {tomorrowEvents.slice(0, 3).map((ev) => (
                      <Press key={ev.id} onPress={openCalendar} style={st.event}>
                        <T size={13.5} color={ov.soft} style={st.eventTime}>{ev.allDay ? 'All day' : clock(new Date(ev.start))}</T>
                        <View style={[st.rule, { backgroundColor: toneOf(ev), opacity: 0.4 }]} />
                        <T size={14.5} color={ov.soft} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{ev.title}</T>
                      </Press>
                    ))}
                  </>
                )}
              </View>
            )}
        </Section>

        <Section
          title="Tasks"
          meta={data.todos ? (overdue.length ? <T size={13} color={ov.overdue}>{overdue.length} overdue</T> : `${todos.length} open`) : null}
          onOpen={openTodos}
        >
          {errs.todos ? <Failed msg={errs.todos} />
            : !data.todos ? <Loading />
            : !todos.length ? <Quiet>No open tasks.</Quiet>
            : (
              <View>
                {!focus.length && <Subhead first>Nothing due today. Up next</Subhead>}
                {taskShown.map((t, i) => {
                  const diff = t.due ? dueDiff(t.due) : null
                  const tone = PRIORITY_TONE[t.priority] || ov.faint
                  const on = checking.has(t.id)
                  return (
                    <View key={t.id} style={[st.task, i > 0 && st.rowRule]}>
                      <Press
                        onPress={() => !on && completeTodo(t)}
                        accessibilityRole="button"
                        accessibilityLabel={`Complete ${t.content}`}
                        hitSlop={4}
                        style={st.check}
                      >
                        <View style={[st.checkRing, { borderColor: tone }, on && { backgroundColor: tone }]}>
                          {on && <TI icon={IconCheck} size={13} stroke={2.5} color={colors.bg} />}
                        </View>
                      </Press>
                      <Press onPress={openTodos} style={st.taskOpen}>
                        <T size={14.5} color={on ? ov.faint : colors.text} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{t.content}</T>
                        {t.due ? (
                          <T size={12.5} color={diff! < 0 ? ov.overdue : diff === 0 ? ov.soft : ov.faint}>{dueLabel(t.due)}</T>
                        ) : null}
                      </Press>
                    </View>
                  )
                })}
                {focus.length > taskShown.length && <More label={`${focus.length - taskShown.length} more due`} onPress={openTodos} />}
              </View>
            )}
        </Section>

        <Section title="Goals" meta={data.week?.period?.label} onOpen={openGoals}>
          {errs.week ? <Failed msg={errs.week} />
            : !data.week ? <Loading />
            : !goalGroups.length ? (
              <View style={st.emptyAction}>
                <Quiet>No goals set for this week or month.</Quiet>
                <Press haptic onPress={openGoals} style={st.pill}>
                  <TI icon={IconPlus} size={15} color={colors.text} />
                  <T size={13} color={colors.text}>Plan the week</T>
                </Press>
              </View>
            )
            : (
              <View>
                {goalGroups.map((group) => (
                  <View key={group.key}>
                    {goalGroups.length > 1 && <Subhead>{group.label}</Subhead>}
                    {group.goals.slice(0, 4).map((g) => {
                      const pct = g.progress?.percent ?? (g.complete ? 100 : 0)
                      const steps = g.progress?.subGoalsTotal
                      return (
                        <Press key={g.id} onPress={openGoals} style={st.goal}>
                          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
                            <T size={14.5} color={colors.text} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{g.title}</T>
                            <T size={13} color={g.complete ? colors.green : ov.soft}>{g.complete ? 'Done' : `${Math.round(pct)}%`}</T>
                          </View>
                          <View style={{ flexDirection: 'row' }}><Bar value={g.complete ? 100 : pct} tone={g.complete ? colors.green : undefined} /></View>
                          {steps ? <T size={12.5} color={ov.faint}>{g.progress.subGoalsDone} of {steps} steps</T> : null}
                        </Press>
                      )
                    })}
                  </View>
                ))}
              </View>
            )}
        </Section>

        <Section
          title="Habits"
          meta={data.habits && habits.length ? `${habitsDoneToday} of ${habits.length} done` : null}
          onOpen={openHabits}
        >
          {errs.habits ? <Failed msg={errs.habits} />
            : !data.habits ? <Loading />
            : !habits.length ? <Quiet>No habits yet. Add one in Habits, or ask Totem.</Quiet>
            : (
              <View>
                {habits.slice(0, 8).map((h, i) => (
                  <HabitRow
                    key={h.id}
                    first={i === 0}
                    habit={h}
                    entry={entries[habitDay]?.[h.id]}
                    count={entries[habitDay]?.[h.id]?.count || 0}
                    periodCount={periodTotal(h, entries, habitDay)}
                    busy={habitBusy.has(h.id)}
                    onLog={logDelta}
                    onValue={logValue}
                    onNote={openNote}
                  />
                ))}
                {habits.length > 8 && <More label={`${habits.length - 8} more`} onPress={openHabits} />}
              </View>
            )}
        </Section>

        {pinned.map((h) => (
          <Section key={h.id} title={h.metric.label} meta={h.name !== h.metric.label ? `from ${h.name}` : null} onOpen={openHabits}>
            <HabitMetricSection habit={h} entries={entries} today={habitDay} days={30} />
          </Section>
        ))}

        <Press onPress={() => navigateTo(USAGE_SECTION)} style={st.sys}>
          <SysHead label="AI limits" />
          {!ai ? <Loading />
            : !ai.ok ? <T size={14} color={ov.faint}>{ai.error || 'Quota unavailable'}</T>
            : (
              <View style={{ gap: 9, paddingTop: 2 }}>
                {accounts.map((acct) => {
                  const m = tightest(acct)
                  return (
                    <View key={acct.id} style={st.quotaRow}>
                      <ProviderLogo driver={acct.backend} name={acct.displayName || acct.label} size={15} />
                      <T size={13.5} color={ov.text} numberOfLines={1} style={{ width: 64 }}>{acct.displayName || acct.label}</T>
                      {m ? (
                        <>
                          <Bar value={m.remainingPct} tone={headroomTone(m.remainingPct)} />
                          <T size={12.5} color={ov.soft} align="right" style={{ width: 36 }}>{Math.round(m.remainingPct)}%</T>
                        </>
                      ) : (
                        <T size={12.5} color={ov.faint} align="right" style={{ marginLeft: 'auto', width: 36 }}>{acct.status === 'ok' ? '—' : 'error'}</T>
                      )}
                    </View>
                  )
                })}
              </View>
            )}
        </Press>

        <Press onPress={() => navigateTo(JOBS_SECTION)} style={st.sys}>
          <SysHead label="Jobs" />
          {errs.jobs ? <T size={14} color={ov.faint}>{errs.jobs}</T>
            : !data.jobs ? <Loading />
            : (
              <>
                <View style={st.sysValue}>
                  <View style={[st.dot, { backgroundColor: failing.length ? colors.red : colors.green }]} />
                  <T size={18} weight={600} color={colors.text}>{failing.length ? `${failing.length} failing` : 'All healthy'}</T>
                </View>
                <T size={12.5} color={ov.faint} numberOfLines={1}>{jobsOn.length} of {jobs.length} on</T>
                {nextJob && <T size={12.5} color={ov.faint} numberOfLines={1}>Next: {nextJob.name} {until(nextJob.nextRunAt)}</T>}
              </>
            )}
        </Press>

        <Press onPress={() => navigateTo(USAGE_SECTION)} style={st.sys}>
          <SysHead label="Activity" />
          {!data.assistant && !data.prod ? (loaded ? <T size={14} color={ov.faint}>Unavailable</T> : <Loading />)
            : (
              <>
                <T size={18} weight={600} color={colors.text}>
                  {data.assistant?.today ?? 0} <T size={13} color={ov.soft}>requests today</T>
                </T>
                <View style={st.spark} accessibilityLabel="Requests and actions over the last 14 days">
                  {daily.map((d) => (
                    <View key={d.date} style={st.sparkCol}>
                      <View style={{ height: `${(d.work / dailyMax) * 100}%`, borderRadius: 2, backgroundColor: colors.green, opacity: 0.75 }} />
                      <View style={{ height: `${(d.ai / dailyMax) * 100}%`, borderRadius: 2, backgroundColor: ov.sparkAi }} />
                    </View>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <View style={[st.key, { backgroundColor: ov.sparkAi }]} />
                  <T size={12.5} color={ov.faint}>AI</T>
                  <View style={[st.key, { backgroundColor: colors.green, opacity: 0.75, marginLeft: 6 }]} />
                  <T size={12.5} color={ov.faint}>Actions · last 14 days</T>
                </View>
              </>
            )}
        </Press>
      </ScrollView>
    </Screen>
  )
}

function SysHead({ label }: { label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <T size={13} color={ov.soft}>{label}</T>
      <TI icon={IconChevronRight} size={15} color={ov.faint} />
    </View>
  )
}

// The web inverts the black Codex/Cursor/OpenCode marks; a tint does the same here.
function ProviderLogo({ driver, name, size = 16 }: { driver?: string; name?: string; size?: number }) {
  const src = DRIVER_LOGOS[driver || '']
  if (!src) {
    return (
      <View style={{ width: size, height: size, borderRadius: 4, backgroundColor: ov.raise, alignItems: 'center', justifyContent: 'center' }}>
        <T size={10} weight={700} color={ov.soft}>{(name || '?').slice(0, 1).toUpperCase()}</T>
      </View>
    )
  }
  return (
    <Image
      source={src}
      style={{ width: size, height: size, borderRadius: 4 }}
      contentFit="contain"
      tintColor={driver === 'claude' ? undefined : '#d4d6db'}
    />
  )
}

function RefreshButton({ spinning, onPress }: { spinning: boolean; onPress: () => void }) {
  const turn = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!spinning) { turn.stopAnimation(); turn.setValue(0); return }
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }))
    loop.start()
    return () => loop.stop()
  }, [spinning, turn])
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <Press haptic onPress={onPress} accessibilityLabel="Refresh" accessibilityRole="button" style={st.iconBtn}>
      <Animated.View style={{ transform: [{ rotate }] }}>
        <TI icon={IconRefresh} size={18} color={ov.faint} />
      </Animated.View>
    </Press>
  )
}

// Sending starts a new chat with the text and opens it.
function AskBox({ onAsk }: { onAsk: (text: string) => void }) {
  const [text, setText] = useState('')
  const ref = useRef<TextInput>(null)
  const submit = () => {
    const t = text.trim()
    if (!t) return
    onAsk(t)
    setText('')
    ref.current?.blur()
  }
  const empty = !text.trim()
  return (
    <View style={st.ask}>
      <TextInput
        ref={ref}
        value={text}
        onChangeText={setText}
        placeholder="Ask Totem anything"
        placeholderTextColor={ov.faint}
        accessibilityLabel="Ask Totem"
        multiline
        numberOfLines={1}
        submitBehavior="submit"
        returnKeyType="send"
        onSubmitEditing={submit}
        keyboardAppearance="dark"
        selectionColor={colors.accent}
        style={st.askInput}
      />
      <Press onPress={submit} disabled={empty} accessibilityLabel="Send" style={[st.askSend, empty && { opacity: 0.18 }]}>
        <TI icon={IconArrowUp} size={18} stroke={2.25} color="#0f1115" />
      </Press>
    </View>
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

const st = StyleSheet.create({
  inner: { paddingTop: 12, paddingHorizontal: 16, paddingBottom: FAB_CLEARANCE, gap: 16 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  iconBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 2 },

  ask: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingVertical: 8, paddingRight: 8, paddingLeft: 18, borderRadius: 26,
    backgroundColor: ov.surface, borderWidth: 1, borderColor: ov.line,
  },
  appBadge: { position: 'absolute', top: -5, right: -6 },
  askInput: {
    flex: 1, minWidth: 0, color: colors.text, fontFamily: fonts[400], fontSize: 16, lineHeight: 22,
    paddingTop: 9, paddingBottom: 9, maxHeight: 140,
  },
  askSend: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },

  attn: { borderWidth: 1, borderColor: ov.line, borderRadius: 16, overflow: 'hidden', backgroundColor: ov.surface },
  attnRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 10, paddingLeft: 14, paddingRight: 12 },
  attnIco: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  // A sideways strip of apps, like a dock, bleeding to the screen edges.
  apps: { marginHorizontal: -16, flexGrow: 0 },
  appsInner: { paddingHorizontal: 12, gap: 2 },
  app: { width: 68, paddingVertical: 6, alignItems: 'center', gap: 7 },
  appIco: {
    width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: ov.surface, borderWidth: 1, borderColor: ov.line,
  },

  allday: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 2, paddingBottom: 8 },
  chip: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 999, backgroundColor: ov.raise, maxWidth: '100%' },
  event: { flexDirection: 'row', alignItems: 'stretch', gap: 12, marginHorizontal: -8, padding: 8, borderRadius: 10 },
  eventTime: { width: 64, paddingTop: 1 },
  rule: { width: 3, borderRadius: 2 },
  eventSub: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: '100%', minWidth: 0 },

  task: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 42 },
  rowRule: { borderTopWidth: 1, borderTopColor: ov.rowLine },
  check: { width: 34, height: 34, marginLeft: -8, alignItems: 'center', justifyContent: 'center' },
  checkRing: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  taskOpen: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },

  goal: { gap: 6, marginHorizontal: -8, paddingVertical: 9, paddingHorizontal: 8, borderRadius: 10 },
  emptyAction: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingLeft: 10, paddingRight: 14,
    borderRadius: 999, borderWidth: 1, borderColor: ov.line, backgroundColor: ov.raise, marginBottom: 8,
  },

  sys: { gap: 8, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: ov.line, backgroundColor: ov.tile },
  sysValue: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  quotaRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 28 },
  sparkCol: { flex: 1, height: '100%', flexDirection: 'column-reverse', gap: 1, minWidth: 0 },
  key: { width: 8, height: 8, borderRadius: 2 },
})
