// Productivity (#177): every tool is its own drawer page (src/app/(app)/productivity/<id>.tsx,
// the web's own paths), and /productivity is the hub that launches them.
//
// The pages are drawer screens rather than a stack pushed over the hub: a drawer
// keeps each page mounted once it has been opened, so going back to a tool is
// instant and keeps its scroll, drafts and a Journal recording in progress (what
// the old pager's hidden apps did), and the left-edge swipe means one thing on
// every page: open the drawer.
//
// The hub answers "what is waiting in each tool" from data the app already holds
// (glance.ts): a tool's store once its page has loaded, so a check-in made there
// shows here at once, else the GET cache. It never asks the bridge for anything itself.
import React, { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { router, useIsFocused, useLocalSearchParams, useNavigation } from 'expo-router'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { ToolIcon } from '../../shell/ToolIcon'
import { navigateTo } from '../../shell/nav'
import { PRODUCTIVITY_APPS, TOOL_LABELS, isProductivityApp, productivityPath, type ProductivityApp } from '../../shell/routes'
import { tap } from '../../ui/haptics'
import { showMenu } from '../../ui/menu'
import { useSettings } from '../../lib/settings'
import { peekCalendar, peekGoals, peekHabits, peekLists, peekTodoBoard, peekTodos } from '../../lib/api'
import { ov } from '../overview/parts'
// Read only: each tool's own store, for numbers that match the page just left.
import { useBoard } from '../todos/store'
import { useHabits } from '../habits/store'
import { useGoals } from '../goals/store'
import { useLists } from '../lists/store'
import { calendarGlance, count, firstGlance, goalsGlance, habitsGlance, listsGlance, liveWeekGoals, tasksGlance } from './glance'
import TodosView from './TodosView'
import HabitsView from './HabitsView'
import GoalsView from './GoalsView'
import ListsView from './ListsView'
import RecsView from './RecsView'
import JournalView from './JournalView'
import CalendarView from './CalendarView'

const VIEWS: Record<ProductivityApp, React.ComponentType<{ active: boolean }>> = {
  todos: TodosView,
  calendar: CalendarView,
  habits: HabitsView,
  goals: GoalsView,
  lists: ListsView,
  recs: RecsView,
  journal: JournalView,
}

/**
 * One tool, full screen: its name in the top bar, its own glow, and its view
 * mounted unchanged. `active` is whether this page is the one in view, so a tool
 * polls and reloads only while it is looked at.
 */
export function ToolPage({ app }: { app: ProductivityApp }) {
  const focused = useIsFocused()
  const ToolView = VIEWS[app]
  return (
    <Screen title={TOOL_LABELS[app]} glow={app}>
      <ToolView active={focused} />
    </Screen>
  )
}

// ---- the hub -----------------------------------------------------------

/** What a tile says when there is no number to show. */
const ABOUT: Record<ProductivityApp, string> = {
  todos: 'Your task board',
  calendar: 'Your schedule',
  habits: 'Daily check-ins',
  goals: 'Week, month and year',
  lists: 'Checklists',
  recs: 'What agents suggest',
  journal: 'Voice notes',
}

interface Face {
  /** The big number, when there is one worth reading. */
  value?: string
  /** How VoiceOver should say the number ("2 of 4", not "2/4"). */
  spoken?: string
  /** What the number counts, or a plain sentence instead of one. */
  caption: string
  /** A second line: what is next, or the wider count. */
  detail?: string
  /** Something late, said in the warning colour. */
  alert?: string
  /** 0..1 for a thin bar under the number. */
  progress?: number
}

/**
 * The data each tile reads, freshest first: a tool's live store where it has
 * loaded, then the cache. A candidate a glance turns down (an earlier day's or
 * week's) falls through to the next.
 */
interface Sources { board: any; habits: any[]; goals: any[]; lists: any }


const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const ratio = (done: number, total: number) => ({ value: `${done}/${total}`, spoken: `${done} of ${total}`, progress: done / total })

/** Every tile's face. */
function readFaces(now: Date, src: Sources): Record<ProductivityApp, Face> {
  const faces = Object.fromEntries(PRODUCTIVITY_APPS.map((a) => [a, { caption: ABOUT[a] }])) as Record<ProductivityApp, Face>

  const tasks = tasksGlance(src.board, peekTodos(), now)
  if (tasks) {
    const late = tasks.overdue ? `${tasks.overdue} overdue` : undefined
    faces.todos = tasks.today
      ? { value: String(tasks.today), caption: 'due today', alert: late, detail: `${tasks.open} open` }
      : { caption: 'Nothing due today', alert: late, detail: tasks.open ? `${tasks.open} open` : 'Board is clear' }
  }

  const cal = calendarGlance(peekCalendar(3) ?? peekCalendar(), now)
  if (cal) {
    const allDay = cal.allDayTitle ? `All day · ${cal.allDayTitle}${cal.allDay > 1 ? ` +${cal.allDay - 1}` : ''}` : undefined
    faces.calendar = cal.left
      ? {
          value: String(cal.left),
          // All-day ones are counted beside the timed, never hidden by the next timed one.
          caption: `${cal.left === 1 ? 'event' : 'events'} left${cal.allDay ? ` · ${cal.allDay} all day` : ' today'}`,
          detail: cal.next ? `${clock(cal.next.start)} · ${cal.next.title}` : allDay,
        }
      : { caption: allDay || 'Nothing else today' }
  }

  const habits = firstGlance(src.habits, (c) => habitsGlance(c, now))
  if (habits) {
    faces.habits = habits.total
      ? { ...ratio(habits.done, habits.total), caption: habits.done === habits.total ? 'all done today' : 'done today' }
      : { caption: 'No habits yet' }
  }

  const goals = firstGlance(src.goals, (c) => goalsGlance(c, now))
  if (goals) {
    faces.goals = goals.total
      ? { ...ratio(goals.done, goals.total), caption: 'done this week' }
      : { caption: 'None set this week' }
  }

  const lists = listsGlance(src.lists)
  if (lists) {
    faces.lists = lists.lists
      ? { value: String(lists.open), caption: lists.open === 1 ? 'open item' : 'open items', detail: count(lists.lists, 'list') }
      : { caption: 'No lists yet' }
  }
  return faces
}

/** Holding a tile: open it, or start something new in it where the app has a sheet for that. */
const SHORTCUTS: Partial<Record<ProductivityApp, { label: string; open: () => void }>> = {
  todos: { label: 'New task', open: () => router.push('/todo/new') },
  habits: { label: 'New habit', open: () => router.push('/habit/new') },
  goals: { label: 'New goal this week', open: () => router.push({ pathname: '/goal/new', params: { period: 'this_week' } }) },
}

function openTool(app: ProductivityApp) {
  tap()
  navigateTo(app)
}

/** The page first, so closing the sheet lands where the new thing now is. */
function startNew(app: ProductivityApp) {
  navigateTo(app)
  SHORTCUTS[app]?.open()
}

function toolMenu(app: ProductivityApp) {
  const shortcut = SHORTCUTS[app]
  showMenu([
    { label: `Open ${TOOL_LABELS[app]}`, onPress: () => navigateTo(app) },
    ...(shortcut ? [{ label: shortcut.label, onPress: () => startNew(app) }] : []),
  ], { title: TOOL_LABELS[app] })
}

function Tile({ app, face, wide, index, still }: { app: ProductivityApp; face: Face; wide?: boolean; index: number; still: boolean }) {
  const scale = useSharedValue(1)
  const pressed = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))
  const label = [
    TOOL_LABELS[app], face.value ? `${face.spoken || face.value} ${face.caption}` : face.caption, face.alert, face.detail,
  ].filter(Boolean).join(', ')
  const shortcut = SHORTCUTS[app]
  return (
    <Animated.View
      entering={still ? undefined : FadeIn.duration(220).delay(index * 25)}
      style={[wide ? st.wide : st.half, pressed]}
    >
      <Pressable
        onPress={() => openTool(app)}
        onLongPress={() => toolMenu(app)}
        delayLongPress={350}
        onPressIn={() => { if (!still) scale.value = withTiming(0.97, { duration: 90 }) }}
        onPressOut={() => { if (!still) scale.value = withSpring(1, { damping: 18, stiffness: 320 }) }}
        style={({ pressed: down }) => [st.tile, face.value ? st.tileTall : null, down && st.tileDown]}
        accessibilityRole="button"
        accessibilityLabel={label}
        // VoiceOver reaches the hold menu's shortcut as an action (swipe up or down).
        accessibilityActions={shortcut ? [{ name: 'new', label: shortcut.label }] : undefined}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'new') startNew(app) }}
      >
        <View style={st.tileHead}>
          <ToolIcon app={app} size={wide ? 30 : 26} />
          <T size={16} weight={600} color={colors.text} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{TOOL_LABELS[app]}</T>
        </View>
        {face.value ? (
          <View style={st.body}>
            <View style={wide ? st.valueRow : undefined}>
              <T size={wide ? 34 : 28} weight={600} color={colors.text} lineHeight={wide ? 40 : 34} style={st.num} numberOfLines={1}>
                {face.value}
              </T>
              <T size={13.5} color={ov.soft} numberOfLines={wide ? 1 : 2} style={wide ? { flexShrink: 1 } : undefined}>{face.caption}</T>
            </View>
            {face.progress != null ? (
              <View style={st.track}><View style={[st.fill, { width: `${Math.round(Math.min(1, Math.max(0, face.progress)) * 100)}%` }]} /></View>
            ) : null}
          </View>
        ) : (
          // No number: say what is there (or what the tool is for) right under its name.
          <T size={14} color={ov.soft} numberOfLines={2} style={{ marginTop: 8 }}>{face.caption}</T>
        )}
        {face.alert || face.detail ? (
          <T size={13} color={ov.faint} numberOfLines={1} style={{ marginTop: 6 }}>
            {face.alert ? <T size={13} weight={600} color={ov.overdue}>{face.alert}</T> : null}
            {face.alert && face.detail ? ' · ' : null}
            {face.detail}
          </T>
        ) : null}
      </Pressable>
    </Animated.View>
  )
}

const [FIRST, ...REST] = PRODUCTIVITY_APPS
/** Tasks across the top, then the rest two by two. */
const PAIRS: ProductivityApp[][] = []
for (let i = 0; i < REST.length; i += 2) PAIRS.push(REST.slice(i, i + 2))

export default function ProductivityScreen() {
  const navigation = useNavigation()
  const focused = useIsFocused()
  const { reduceMotion } = useSettings()
  const still = useReducedMotion() || reduceMotion
  const [now, setNow] = useState(() => new Date())

  // The old pager's link named the tool in the query; open that tool's page instead.
  const { app } = useLocalSearchParams<{ app?: string }>()
  useEffect(() => {
    if (!app) return
    navigation.setParams({ app: undefined } as never)
    if (isProductivityApp(app)) router.navigate(productivityPath(app) as any)
  }, [app, navigation])

  // The stores push their changes here; the cache is re-read each time the hub
  // comes into view, and the clock ticks while it stays in view so "left today" holds.
  const board = useBoard()
  const habitStore = useHabits().data
  const goalStore = useGoals()
  const listStore = useLists()
  useEffect(() => {
    if (!focused) return
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [focused])
  const faces = useMemo(() => readFaces(now, {
    board: board.loaded ? board : peekTodoBoard({ snoozed: false }),
    // Overview refreshes the 40-day answer, so it is the fresher of the two cached ones.
    habits: [habitStore, peekHabits(40), peekHabits()],
    goals: [liveWeekGoals(goalStore), peekGoals('this_week')],
    lists: listStore.loaded ? listStore : peekLists(),
  }), [now, board, habitStore, goalStore, listStore])

  return (
    <Screen title="Productivity" glow="productivity">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={st.inner}>
        <Tile app={FIRST} face={faces[FIRST]} wide index={0} still={still} />
        {PAIRS.map((pair, r) => (
          <View key={pair[0]} style={st.row}>
            {pair.map((a, i) => <Tile key={a} app={a} face={faces[a]} index={1 + r * 2 + i} still={still} />)}
            {pair.length === 1 ? <View style={st.half} /> : null}
          </View>
        ))}
      </ScrollView>
    </Screen>
  )
}

const st = StyleSheet.create({
  inner: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: FAB_CLEARANCE, gap: 12 },
  row: { flexDirection: 'row', gap: 12 },
  wide: { width: '100%' },
  half: { flex: 1, minWidth: 0 },
  tile: { flexGrow: 1, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: ov.line, backgroundColor: ov.surface },
  // A tile with a number holds its height so the numbers in a row line up.
  tileTall: { minHeight: 124 },
  tileDown: { backgroundColor: alpha(colors.bg3, 0.85) },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  body: { marginTop: 'auto', paddingTop: 12 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  num: { fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  track: { height: 4, borderRadius: 2, marginTop: 8, backgroundColor: ov.raise, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: ov.bar },
})
