// The drawer's By task order (web tasksnav/parts.tsx): the owner's tasks in the
// list's scope, read from the board store (features/work/state.ts), by the web's
// rules (lib/tasksnav/lists.ts, the web's file byte for byte). A task with chats in
// play heads them; under the chats come the next tasks by due day (Overdue, Today,
// Next 7 days, then Later and No date folded) and a folded Snoozed.
//
// A task's row: its ring (Done; a sheet row is done for him alone), title, folder
// and due day. A tap starts a chat for it in its folder; swiped right it is done,
// swiped left it shows Snooze (Tomorrow, 3 days, a week) and Open; a long-press has
// all of those. What can be undone gets the drawer's Undo line (work/undoDock.tsx).
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useChat } from '../../lib/chat/store'
import { chatsByTask, folderOf, type WorkTask } from '../../lib/work/groups'
import { scopedTasks, snoozedTasks, taskActivity, taskSections, wakeOf, type TaskGroup, type TaskSectionId } from '../../lib/tasksnav/lists'
import { wakeLabel } from '../../lib/todos/board'
import { snoozeTimes } from '../../lib/todos/format'
import type { SidebarScope } from '../../lib/chat/sidebar'
import type { ChatThread } from '../../lib/chat/types'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, tap } from '../../ui/haptics'
import { showActionTree } from '../../ui/menu'
import { drawerPan } from '../../shell/drawerGesture'
import { useBoard, loadBoard } from '../todos/store'
import { PERSONAL } from '../todos/folders'
import CheckCircle from '../todos/CheckCircle'
import { completeTask, snoozeTask, useWorkTasks } from '../work/state'
import { newTaskChat, openTask } from '../work/nav'
import { showUndo } from '../work/undoDock'
import { dueLook } from '../work/look'
import { ProjectIcon } from './ThreadIcon'
import { TI } from './ui'
import { IconAlarmOff, IconCheck, IconChecklist, IconChevronDown, IconChevronUp, IconTable, IconUser, IconZzz } from './icons'

const MUTED = 'rgba(138, 145, 163, 0.8)'
const WORKING = '#8ec5ff'
const SECTION_TONE: Partial<Record<TaskSectionId, string>> = { overdue: '#ff9aac', today: '#f3c969' }

/** The tasks in the drawer's scope, their chats, and what is picked for the chat being written. */
export function useDrawerTasks(scope: SidebarScope, now: number) {
  const tasks = useWorkTasks()
  const { loaded, error } = useBoard()
  const threads = useChat((s) => s.threads) as ChatThread[]
  const projects = useChat((s) => s.projects)
  const runs = useChat((s) => s.runs)
  const draftTaskId = useChat((s) => (!s.activeId ? s.draftTaskId : null))
  const scoped = useMemo(() => scopedTasks(tasks, scope, projects), [tasks, scope, projects])
  const sections = useMemo(() => taskSections(scoped, new Date(now)), [scoped, now])
  const snoozed = useMemo(() => snoozedTasks(scoped, now), [scoped, now])
  const byTask = useMemo(() => chatsByTask(threads, tasks), [threads, tasks])
  const live = useCallback((id: string) => !!runs[id], [runs])
  const open = sections.reduce((n, s) => n + s.tasks.length, 0)
  return { now, tasks, projects, live, loaded, error, draftTaskId, sections, snoozed, byTask, open }
}

export type DrawerTasks = ReturnType<typeof useDrawerTasks>

const snoozeActions = (now: Date): MenuAction[] =>
  snoozeTimes(now).map((o) => ({ id: `snooze:${o.value.toISOString()}`, title: o.label, subtitle: o.detail }))

async function finish(ref: string) {
  const undo = await completeTask(ref)
  if (undo) showUndo(undo)
  return !!undo
}

async function snooze(ref: string, until: Date | null) {
  const undo = await snoozeTask(ref, until)
  if (undo) showUndo(undo)
}

/** One task. `head`: it heads its chats in play, so no chat count. */
function TaskRow({ task, d, head = false }: { task: WorkTask; d: DrawerTasks; head?: boolean }) {
  const swipe = useRef<SwipeableMethods>(null)
  const [ticked, setTicked] = useState(false)
  const now = new Date(d.now)
  const sheet = task.kind === 'sheet'
  const chats = d.byTask.get(task.ref)
  const activity = taskActivity(chats, d.live)
  const selected = d.draftTaskId === task.ref
  const due = dueLook(task.dueDate, now, true)
  const folder = folderOf(task, d.projects)
  const done = () => {
    if (ticked) return
    setTicked(true)
    impact()
    void finish(task.ref).then((ok) => { if (!ok) setTicked(false) })
  }
  const run = (id: string) => {
    swipe.current?.close()
    tap()
    if (id === 'chat') newTaskChat(task.ref)
    else if (id === 'open') openTask(task.ref)
    else if (id === 'done') done()
    else if (id.startsWith('snooze:')) void snooze(task.ref, new Date(id.slice(7)))
  }
  const actions: MenuAction[] = [
    { id: 'chat', title: 'New chat for this task', image: 'plus.bubble' },
    { id: 'open', title: 'Open task', image: 'checklist' },
    { id: 'snooze', title: 'Snooze…', image: 'moon.zzz', subactions: snoozeActions(now) },
    { id: 'done', title: sheet ? 'Done for you' : 'Done', subtitle: sheet ? 'The sheet is unchanged' : undefined, image: 'checkmark.circle' },
  ]
  const row = (
    <View style={[st.task, selected ? st.on : st.off]}>
      <CheckCircle
        look="todo" checked={ticked} onPress={done}
        label={sheet ? `Mark ${task.title} done for you` : `Mark ${task.title} done`}
        hint={sheet ? 'The sheet is unchanged' : undefined}
      />
      <Press
        style={st.main}
        onPress={() => run('chat')}
        onLongPress={() => { impact(); showActionTree(actions, run, task.title) }}
        accessibilityRole="button"
        accessibilityLabel={`${task.title}, ${folder?.name || PERSONAL}${due ? `, ${due.text}` : ''}${activity === 'live' ? ', a chat is answering' : activity === 'waiting' ? ', a chat is waiting on you' : ''}`}
        accessibilityHint="Starts a chat for this task. Swipe or long-press for more"
        accessibilityState={{ selected }}
      >
        <View style={st.line}>
          {sheet ? <TI icon={IconTable} size={13} color={MUTED} /> : null}
          <T size={14.5} weight={head ? 600 : 400} numberOfLines={1} color={colors.text} style={{ flexShrink: 1 }}>{task.title}</T>
          {activity ? <View style={[st.dot, activity === 'live' && { backgroundColor: WORKING }]} /> : null}
        </View>
        <View style={st.line}>
          {folder ? <ProjectIcon p={folder} size={11} color={MUTED} /> : <TI icon={IconUser} size={11} color={MUTED} />}
          <T size={12} color={MUTED} numberOfLines={1} style={{ flexShrink: 1 }}>{folder?.name || PERSONAL}</T>
          {chats?.length && !head ? <T size={12} color={MUTED} style={{ flexShrink: 0 }}>· {chats.length} chat{chats.length === 1 ? '' : 's'}</T> : null}
        </View>
      </Press>
      {due ? <T size={12} weight={due.strong ? 600 : 400} color={due.color} style={st.due}>{due.text}</T> : null}
    </View>
  )
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.5}
      leftThreshold={72}
      rightThreshold={40}
      overshootLeft={false}
      overshootRight={false}
      blocksExternalGesture={drawerPan()}
      renderLeftActions={() => (
        <View style={[st.swipeLeft, { backgroundColor: colors.green }]}>
          <TI icon={IconCheck} size={18} color="#06210d" stroke={2.2} />
          <T size={12} weight={600} color="#06210d">Done</T>
        </View>
      )}
      renderRightActions={() => (
        <View style={st.swipe}>
          <MenuView title="Snooze" actions={snoozeActions(new Date())} themeVariant="dark" onOpenMenu={tap} onPressAction={({ nativeEvent }) => run(nativeEvent.event)} style={st.menuTall}>
            <View style={[st.swipeBtn, st.swipeFill, { backgroundColor: colors.amber }]} accessible accessibilityRole="button" accessibilityLabel={`Snooze ${task.title}`}>
              <TI icon={IconZzz} size={18} color="#1d1606" />
              <T size={11} weight={600} color="#1d1606">Snooze</T>
            </View>
          </MenuView>
          <Press style={[st.swipeBtn, st.swipeTall, { backgroundColor: colors.drawerOn }]} onPress={() => run('open')} accessibilityLabel={`Open ${task.title}`}>
            <TI icon={IconChecklist} size={18} color={colors.text} />
            <T size={11} weight={600} color={colors.text}>Open</T>
          </Press>
        </View>
      )}
      onSwipeableOpen={(direction) => {
        // RIGHT means the row travelled right, uncovering Done.
        if (direction !== 'right') return
        swipe.current?.close()
        done()
      }}
    >
      {row}
    </ReanimatedSwipeable>
  )
}

/** A task with its chats in play under it, on a thread line. `chat` draws one (the drawer's slim row). */
export function TaskGroupRows({ group, d, chat }: { group: TaskGroup; d: DrawerTasks; chat: (t: ChatThread) => React.ReactNode }) {
  return (
    <View style={st.group}>
      <TaskRow task={group.task} d={d} head />
      <View style={st.groupChats}>{group.chats.map(chat)}</View>
    </View>
  )
}

// Which sections are folded, per device, under the web's key.
const FOLDED_KEY = 'totem.nav.folded'
const readFolded = (): TaskSectionId[] => { try { const v = JSON.parse(localStorage.getItem(FOLDED_KEY) || 'null'); return Array.isArray(v) ? v : ['later', 'undated'] } catch { return ['later', 'undated'] } }

/** The next tasks: a folding heading per due section, then a folded Snoozed. `skip`: tasks already heading a group. */
export function NextTasks({ d, skip }: { d: DrawerTasks; skip: ReadonlySet<string> }) {
  const [folded, setFolded] = useState(readFolded)
  const [snoozedOpen, setSnoozedOpen] = useState(false)
  const toggle = (id: TaskSectionId) => {
    tap()
    setFolded((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      try { localStorage.setItem(FOLDED_KEY, JSON.stringify(next)) } catch { /* kept for this session */ }
      return next
    })
  }
  const now = new Date(d.now)
  if (d.error && !d.open) {
    return (
      <View style={st.next}>
        <T size={13} color={colors.amber} style={st.note}>Couldn’t load your tasks · {d.error}</T>
        <Press style={st.retry} onPress={() => { tap(); void loadBoard() }} accessibilityRole="button"><T size={13} color={colors.text}>Retry</T></Press>
      </View>
    )
  }
  return (
    <View style={st.next}>
      {d.sections.map((s) => {
        const tasks = s.tasks.filter((t) => !skip.has(t.ref))
        if (!tasks.length) return null
        const shut = folded.includes(s.id)
        // Folded, the task picked for the chat being written still shows.
        const rows = shut ? tasks.filter((t) => t.ref === d.draftTaskId) : tasks
        const tone = SECTION_TONE[s.id] ?? MUTED
        return (
          <View key={s.id}>
            <Press style={st.head} onPress={() => toggle(s.id)} accessibilityRole="button" accessibilityState={{ expanded: !shut }} accessibilityLabel={`${s.label}, ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}>
              <T size={12.5} weight={600} color={tone}>{s.label}</T>
              <T size={12} color={MUTED} style={{ fontVariant: ['tabular-nums'] }}>{tasks.length}</T>
              <View style={st.rule} />
              <TI icon={shut ? IconChevronDown : IconChevronUp} size={13} color={MUTED} />
            </Press>
            {rows.map((t) => <TaskRow key={t.ref} task={t} d={d} />)}
          </View>
        )
      })}
      {d.loaded && !d.open ? <T size={13} color={MUTED} style={st.note}>No open tasks.</T> : null}
      {d.snoozed.length ? (
        <View>
          <Press style={st.head} onPress={() => { tap(); setSnoozedOpen((v) => !v) }} accessibilityRole="button" accessibilityState={{ expanded: snoozedOpen }} accessibilityLabel={`Snoozed tasks, ${d.snoozed.length}`}>
            <TI icon={IconZzz} size={13} color={MUTED} />
            <T size={12.5} weight={600} color={MUTED}>Snoozed tasks</T>
            <T size={12} color={MUTED} style={{ fontVariant: ['tabular-nums'] }}>{d.snoozed.length}</T>
            <View style={st.rule} />
            <TI icon={snoozedOpen ? IconChevronUp : IconChevronDown} size={13} color={MUTED} />
          </Press>
          {snoozedOpen ? d.snoozed.map((t) => {
            const wake = wakeOf(t)
            return (
              <View key={t.ref} style={[st.task, st.off]}>
                <View style={st.snoozedGlyph}><TI icon={IconZzz} size={15} color={MUTED} /></View>
                <Press style={st.main} onPress={() => { tap(); openTask(t.ref) }} accessibilityRole="button" accessibilityHint="Opens the task">
                  <T size={14.5} numberOfLines={1} color={textAlpha(80)}>{t.title}</T>
                  {wake ? <T size={12} color={MUTED}>Back {wakeLabel(new Date(wake), now)}</T> : null}
                </Press>
                <Press style={st.wake} onPress={() => { tap(); void snooze(t.ref, null) }} accessibilityRole="button" accessibilityLabel={`Wake ${t.title} now`}>
                  <TI icon={IconAlarmOff} size={17} color={colors.accent} />
                </Press>
              </View>
            )
          }) : null}
        </View>
      ) : null}
    </View>
  )
}

/** Recent / By task, at the top of the drawer's list. `due`: tasks due today or overdue, a count on By task. */
export function OrderSwitch({ value, onChange, due }: { value: 'recent' | 'task'; onChange: (v: 'recent' | 'task') => void; due: number }) {
  const option = (id: 'recent' | 'task', label: string) => {
    const on = value === id
    return (
      <Press
        style={[st.seg, on && st.segOn]}
        onPress={() => { if (!on) { tap(); onChange(id) } }}
        accessibilityRole="radio"
        accessibilityState={{ checked: on }}
        accessibilityLabel={id === 'task' && due ? `${label}, ${due} due today or overdue` : label}
      >
        <T size={13} weight={500} color={on ? colors.text : colors.muted}>{label}</T>
        {id === 'task' && due ? <View style={st.badge}><T size={10.5} weight={600} color={colors.amber} style={{ fontVariant: ['tabular-nums'] }}>{due}</T></View> : null}
      </Press>
    )
  }
  return (
    <View style={st.segs} accessibilityRole="radiogroup" accessibilityLabel="Order chats">
      {option('recent', 'Recent')}
      {option('task', 'By task')}
    </View>
  )
}

const st = StyleSheet.create({
  task: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingRight: 10, borderRadius: 10 },
  on: { backgroundColor: 'rgba(91, 140, 255, 0.16)' },
  // Opaque, so the actions stay hidden until the row slides off them.
  off: { backgroundColor: colors.bg2 },
  main: { flex: 1, minWidth: 0, gap: 2, paddingVertical: 6, paddingRight: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  due: { flexShrink: 0, fontVariant: ['tabular-nums'] },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  group: { marginVertical: 2 },
  groupChats: { marginLeft: 22, paddingLeft: 6, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: 'rgba(255, 255, 255, 0.16)' },
  next: { marginTop: 10, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 40, paddingHorizontal: 12 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  note: { paddingVertical: 8, paddingHorizontal: 12 },
  retry: { alignSelf: 'flex-start', marginLeft: 8, minHeight: 36, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.bg3 },
  snoozedGlyph: { width: 44, alignItems: 'center' },
  wake: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  swipeLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 18, borderRadius: 10, marginBottom: 2 },
  swipe: { flexDirection: 'row', gap: 4, paddingLeft: 6, paddingBottom: 2 },
  swipeBtn: { width: 62, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 10 },
  swipeTall: { alignSelf: 'stretch' },
  swipeFill: { flex: 1 },
  menuTall: { alignSelf: 'stretch' },
  segs: { flexDirection: 'row', gap: 2, padding: 3, marginHorizontal: 4, marginBottom: 2, borderRadius: 11, backgroundColor: 'rgba(255, 255, 255, 0.05)' },
  seg: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 34, borderRadius: 8 },
  segOn: { backgroundColor: colors.bg3 },
  badge: { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(239, 199, 101, 0.2)' },
})
