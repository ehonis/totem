// One task on the board (web/src/todos/TodoCard.tsx). The web's three popovers —
// snooze, the overdue reschedule and the "…" actions — are native menus on their own
// small buttons, the card long-presses into the same actions as action sheets (a
// MenuView wrapped round the card swallowed its taps on a phone), and a board card swipes:
// right to move it on (start, finish, reopen), left for snooze and the recycle bin.
import React, { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { confirm, showActionTree, showMenu } from '../../ui/menu'
import { success, tap } from '../../ui/haptics'
import {
  Hi, ArrowRightIcon, ArrowTopRightOnSquareIcon, ArrowUturnLeftIcon, CalendarDaysIcon, CheckIcon, ClockIcon,
  EllipsisHorizontalIcon, PlusIcon, TrashIcon,
} from '../../lib/icons'
import { useVentureTags } from '../../lib/todos/ventureTags'
import { priorityLabel, priorityMarks, todoSource, type Todo, type TodoStatus } from '../../lib/todos/types'
import { SOURCE_LABEL, STATUS_LABEL, dateLabel, dueDateChoices, dueTone, snoozeTimes } from './format'
import { PickWhenSheet, STATUS_COLOR, tone } from './ui'
import { openUrl } from '../../lib/siblingApps'

export interface TodoCardProps {
  todo: Todo
  onOpen?: (todo: Todo) => void
  onAddNote?: (todo: Todo) => void
  onMove?: (todo: Todo, status: TodoStatus) => void
  onReorder?: (todo: Todo, direction: -1 | 1) => void
  onSnooze?: (todo: Todo, until: string) => void
  onNotDoing?: (todo: Todo) => void
  onDueDate?: (todo: Todo, dueDate: string | null) => void
  onPriority?: (todo: Todo, priority: Todo['priority']) => void
  onDelete?: (todo: Todo) => void
  now?: () => Date
  selected?: boolean
  onSelect?: (todo: Todo, selected: boolean) => void
  /** Board cards swipe; archive and panel cards do not. */
  swipeable?: boolean
  /** Archived cards sit back a little (.todo-archive .todo-board-card). */
  dim?: boolean
}

const PRIORITY_TONE = { P1: tone.red, P2: tone.amber, P3: tone.blue, P4: tone.grey } as const
const DUE_TONE = { overdue: tone.red, today: tone.amber, upcoming: tone.grey, '': tone.grey } as const
// Where a right swipe takes a card: on to the next column, and a finished card back to the start.
const NEXT: Record<TodoStatus, { status: TodoStatus; label: string; icon: typeof CheckIcon; color: string }> = {
  todo: { status: 'doing', label: 'Start', icon: ArrowRightIcon, color: colors.amber },
  doing: { status: 'done', label: 'Done', icon: CheckIcon, color: colors.green },
  done: { status: 'todo', label: 'Reopen', icon: ArrowUturnLeftIcon, color: colors.accent },
}

/** The web's due-date options, as menu rows. Shared by the overdue shortcut and "Due date…". */
function dueActions(todo: Todo, now: Date): MenuAction[] {
  return [
    ...dueDateChoices(now).map((option): MenuAction => ({
      id: `due:${option.key}`, title: option.label, subtitle: option.detail,
      attributes: todo.dueDate === option.key ? { disabled: true } : undefined,
    })),
    {
      id: 'due-more', title: '', displayInline: true, subactions: [
        { id: 'due:pick', title: 'Pick a due date', image: 'calendar' },
        ...(todo.dueDate ? [{ id: 'due:none', title: 'Remove due date', image: 'arrow.uturn.left' }] : []),
      ],
    },
  ]
}

export default function TodoCard({
  todo, onOpen, onAddNote, onMove, onReorder, onSnooze, onDueDate, onNotDoing, onPriority, onDelete,
  now = () => new Date(), selected, onSelect, swipeable, dim,
}: TodoCardProps) {
  const source = todoSource(todo)
  const link = todo.externalLinks[0]
  const latestNote = todo.notes.reduce<Todo['notes'][number] | null>((latest, item) => (
    !latest || item.createdAt > latest.createdAt || (item.createdAt === latest.createdAt && item.id > latest.id) ? item : latest
  ), null)
  const [pick, setPick] = useState<'snooze' | 'due' | null>(null)
  const swipe = useRef<SwipeableMethods>(null)
  const ventureTags = useVentureTags()
  const toneNow = dueTone(todo.dueDate, now(), todo.status)
  const notDoing = todo.outcome === 'not_doing'
  const overdue = toneNow === 'overdue'
  const label = priorityLabel(todo.priority)
  const marks = priorityMarks(todo.priority)
  const ventureColor = todo.area === 'Ventures' ? ventureTags.find((tag) => tag.name === todo.ventureTag)?.color : null

  const actions: MenuAction[] = [
    {
      id: 'move', title: 'Move…', subtitle: STATUS_LABEL[todo.status], image: 'arrow.left.arrow.right',
      subactions: (['todo', 'doing', 'done'] as TodoStatus[]).map((status) => ({
        id: `move:${status}`, title: `Move to ${STATUS_LABEL[status]}`,
        state: todo.status === status ? 'on' : 'off', attributes: todo.status === status ? { disabled: true } : undefined,
      })),
    },
    {
      id: 'priority', title: 'Priority…', subtitle: marks || label, image: 'flag',
      subactions: ([4, 3, 2, 1] as Todo['priority'][]).map((priority) => ({
        id: `priority:${priority}`, title: `Set priority to ${priorityLabel(priority)}`, subtitle: priorityMarks(priority) || undefined,
        state: todo.priority === priority ? 'on' : 'off', attributes: todo.priority === priority ? { disabled: true } : undefined,
      })),
    },
    ...(onDueDate ? [{
      id: 'due', title: 'Due date…', subtitle: todo.dueDate ? dateLabel(todo.dueDate) : 'None', image: 'calendar',
      subactions: dueActions(todo, now()),
    }] : []),
    {
      id: 'order', title: '', displayInline: true, subactions: [
        { id: 'up', title: 'Move task up', image: 'arrow.up' },
        { id: 'down', title: 'Move task down', image: 'arrow.down' },
      ],
    },
    {
      id: 'more', title: '', displayInline: true, subactions: [
        ...(onNotDoing && !notDoing ? [{ id: 'notdoing', title: 'Not doing this', image: 'nosign' }] : []),
        { id: 'edit', title: 'Edit task', image: 'square.and.pencil' },
        { id: 'delete', title: 'Move task to recycle bin', image: 'trash', attributes: { destructive: true } },
      ],
    },
  ]

  function act(id: string) {
    tap()
    if (id.startsWith('move:')) return onMove?.(todo, id.slice(5) as TodoStatus)
    if (id.startsWith('priority:')) return onPriority?.(todo, Number(id.slice(9)) as Todo['priority'])
    // The calendar sheet waits for the menu or action sheet to finish closing: iOS
    // refuses to present a modal while another presentation is still animating.
    if (id === 'due:pick') return void setTimeout(() => setPick('due'), 400)
    if (id === 'due:none') return onDueDate?.(todo, null)
    if (id.startsWith('due:')) return onDueDate?.(todo, id.slice(4))
    if (id === 'snooze:pick') return void setTimeout(() => setPick('snooze'), 400)
    if (id.startsWith('snooze:')) return onSnooze?.(todo, id.slice(7))
    if (id === 'up') return onReorder?.(todo, -1)
    if (id === 'down') return onReorder?.(todo, 1)
    if (id === 'notdoing') return onNotDoing?.(todo)
    if (id === 'edit') return onOpen?.(todo)
    if (id === 'delete') return onDelete?.(todo)
  }

  const openActions = onMove ? () => showActionTree(actions, act, todo.title) : undefined

  const snoozeActions: MenuAction[] = [
    ...snoozeTimes(now(), todo.dueDate).map((option): MenuAction => ({
      id: `snooze:${option.value.toISOString()}`, title: option.label, subtitle: option.detail,
    })),
    { id: 'snooze-more', title: '', displayInline: true, subactions: [{ id: 'snooze:pick', title: 'Pick a date and time', image: 'calendar' }] },
  ]

  const tools = (
    <View style={st.tools}>
      {todo.status !== 'done' && onSnooze ? (
        <MenuView title="Snooze until" actions={snoozeActions} themeVariant="dark" onPressAction={({ nativeEvent }) => act(nativeEvent.event)}>
          <View style={st.tool} accessibilityRole="button" accessibilityLabel={`Snooze ${todo.title}`}>
            <Hi icon={ClockIcon} size={17} color={colors.muted} />
          </View>
        </MenuView>
      ) : null}
      {todo.status !== 'done' && onDueDate && overdue ? (
        <MenuView title="Due date" actions={dueActions(todo, now())} themeVariant="dark" onPressAction={({ nativeEvent }) => act(nativeEvent.event)}>
          <View style={st.tool} accessibilityRole="button" accessibilityLabel={`Reschedule ${todo.title}`}>
            <Hi icon={CalendarDaysIcon} size={17} color="#ff7f95" />
          </View>
        </MenuView>
      ) : null}
      {onMove ? (
        <MenuView actions={actions} themeVariant="dark" onPressAction={({ nativeEvent }) => act(nativeEvent.event)}>
          <View style={st.tool} accessibilityRole="button" accessibilityLabel={`More actions for ${todo.title}`}>
            <Hi icon={EllipsisHorizontalIcon} size={19} color={colors.muted} />
          </View>
        </MenuView>
      ) : null}
    </View>
  )

  const sourceTone = source === 'sheet' ? tone.sheet : source === 'github' ? tone.github : tone.grey
  const sourcePill = (
    <View style={[st.source, { borderColor: sourceTone.borderColor, backgroundColor: source === 'local' ? colors.bg3 : sourceTone.backgroundColor }]}>
      <T size={11.5} weight={700} lineHeight={16} color={sourceTone.color}>{SOURCE_LABEL[source]}</T>
      {link?.externalUrl ? <Hi icon={ArrowTopRightOnSquareIcon} size={11} color={sourceTone.color} /> : null}
    </View>
  )

  const card = (
    <View style={[st.card, { borderLeftColor: STATUS_COLOR[todo.status] }, dim && { opacity: 0.82 }]}>
      <View style={st.sourceRow}>
        {onSelect ? (
          <Press haptic onPress={() => onSelect(todo, !selected)} accessibilityRole="checkbox" accessibilityState={{ checked: !!selected }} accessibilityLabel={`Select ${todo.title}`} hitSlop={8}
            style={[st.check, selected && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
            {selected ? <Hi icon={CheckIcon} size={12} color={colors.white} strokeWidth={3} /> : null}
          </Press>
        ) : null}
        {link?.externalUrl
          ? <Press onPress={() => void openUrl(link.externalUrl!)} accessibilityRole="link">{sourcePill}</Press>
          : sourcePill}
        {notDoing ? <View style={st.outcome}><T size={11.5} weight={700} muted lineHeight={16}>Not doing</T></View> : null}
        {todo.syncState.status !== 'idle' && todo.syncState.status !== 'synced' ? (
          <View style={st.source}>
            <T size={11.5} weight={700} lineHeight={16} color={['error', 'conflict', 'missing'].includes(todo.syncState.status) ? colors.red : colors.amber}>{todo.syncState.status}</T>
          </View>
        ) : null}
        {tools}
      </View>
      {/* The body opens the task (or ticks it while selecting) and long-presses into the actions. */}
      <Press
        onPress={() => (onSelect ? onSelect(todo, !selected) : onOpen?.(todo))}
        onLongPress={openActions}
        delayLongPress={350}
        style={st.body}
        accessibilityRole="button"
        accessibilityLabel={todo.title}
        accessibilityHint={onSelect ? undefined : 'Opens the task. Hold for actions.'}
      >
        <View style={{ gap: 3 }}>
          <T size={14} lineHeight={19} style={notDoing ? { color: colors.muted, textDecorationLine: 'line-through' } : undefined}>{todo.title}</T>
          {todo.description ? <T size={11.5} muted lineHeight={16} numberOfLines={2}>{todo.description}</T> : null}
        </View>
        <View style={st.meta}>
          {marks ? <View style={[st.pill, { borderColor: PRIORITY_TONE[label].borderColor, backgroundColor: PRIORITY_TONE[label].backgroundColor, paddingHorizontal: 5 }]} accessibilityLabel={`${label} priority`}>
            <T size={9} lineHeight={12} color={PRIORITY_TONE[label].color}>{marks}</T>
          </View> : null}
          <View style={[st.pill, ventureColor ? { borderColor: `${ventureColor}45`, backgroundColor: `${ventureColor}12` } : null]}>
            <T size={10.5} lineHeight={14} color={ventureColor || colors.muted}>{todo.area === 'Ventures' ? todo.ventureTag : todo.area}</T>
          </View>
          {todo.dueDate ? <View style={[st.pill, toneNow && toneNow !== 'upcoming' ? { borderColor: DUE_TONE[toneNow].borderColor, backgroundColor: DUE_TONE[toneNow].backgroundColor } : null]}>
            <T size={10.5} lineHeight={14} color={toneNow ? DUE_TONE[toneNow].color : colors.muted}>{dateLabel(todo.dueDate)}</T>
          </View> : null}
          {todo.recurrence ? <View style={st.pill}><T size={10.5} lineHeight={14} muted>Repeats</T></View> : null}
          {todo.tags.slice(0, 2).map((tag) => <View style={st.pill} key={tag.id}><T size={10.5} lineHeight={14} muted>#{tag.name}</T></View>)}
        </View>
      </Press>
      {onAddNote ? (
        <Press onPress={() => onAddNote(todo)} style={st.addNote} accessibilityLabel={`Add a note to ${todo.title}`}>
          <Hi icon={PlusIcon} size={13} color={colors.muted} />
          <T size={11.5} muted>Add a note</T>
        </Press>
      ) : null}
      {latestNote ? (
        <View style={st.note}>
          <T size={11.5} lineHeight={16} color="#b8becc" numberOfLines={2}>{latestNote.body}</T>
          <T size={10} muted>{new Date(latestNote.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</T>
        </View>
      ) : null}
      {onSnooze || onDueDate ? (
        <PickWhenSheet
          visible={pick !== null}
          title={pick === 'snooze' ? 'Custom snooze time' : 'Custom due date'}
          mode={pick === 'snooze' ? 'datetime' : 'date'}
          submitLabel={pick === 'snooze' ? 'Snooze until selected time' : 'Set due date'}
          initial={pick === 'snooze' ? new Date(now().getTime() + 60 * 60_000) : now()}
          minimum={pick === 'snooze' ? now() : undefined}
          onClose={() => setPick(null)}
          onSubmit={(value) => {
            const which = pick
            setPick(null)
            if (which === 'snooze') onSnooze?.(todo, value.toISOString())
            else onDueDate?.(todo, `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`)
          }}
        />
      ) : null}
    </View>
  )

  if (!swipeable || !onMove) return card

  const next = NEXT[todo.status]
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      leftThreshold={72}
      rightThreshold={48}
      overshootLeft={false}
      renderLeftActions={() => (
        <View style={[st.swipeLeft, { backgroundColor: next.color }]}>
          <Hi icon={next.icon} size={20} color={colors.white} strokeWidth={2.2} />
          <T size={13} weight={600} color={colors.white}>{next.label}</T>
        </View>
      )}
      renderRightActions={() => (
        <View style={st.swipeRight}>
          {todo.status !== 'done' && onSnooze ? (
            <Press
              style={[st.swipeBtn, { backgroundColor: colors.amber }]}
              accessibilityLabel={`Snooze ${todo.title}`}
              onPress={() => {
                swipe.current?.close()
                showMenu([
                  ...snoozeTimes(now(), todo.dueDate).map((option) => ({ label: `${option.label} · ${option.detail}`, onPress: () => onSnooze(todo, option.value.toISOString()) })),
                  { label: 'Pick a date and time', onPress: () => void setTimeout(() => setPick('snooze'), 400) },
                ], { title: 'Snooze until' })
              }}
            >
              <Hi icon={ClockIcon} size={20} color="#1d1606" />
              <T size={12} weight={600} color="#1d1606">Snooze</T>
            </Press>
          ) : null}
          <Press
            style={[st.swipeBtn, { backgroundColor: colors.red }]}
            accessibilityLabel={`Move ${todo.title} to the recycle bin`}
            onPress={async () => {
              const ok = await confirm('Move to the recycle bin?', { message: todo.title, confirmLabel: 'Move to recycle bin' })
              swipe.current?.close()
              if (ok) onDelete?.(todo)
            }}
          >
            <Hi icon={TrashIcon} size={20} color={colors.white} />
            <T size={12} weight={600} color={colors.white}>Delete</T>
          </Press>
        </View>
      )}
      onSwipeableOpen={(direction) => {
        // RIGHT means the card travelled right, uncovering the left action.
        if (direction !== 'right') return
        swipe.current?.close()
        if (next.status === 'done') success(); else tap()
        onMove(todo, next.status)
      }}
    >
      {card}
    </ReanimatedSwipeable>
  )
}

const st = StyleSheet.create({
  card: {
    gap: 8, paddingVertical: 10, paddingHorizontal: 11, borderWidth: 1, borderLeftWidth: 3, borderColor: colors.line,
    borderRadius: 8, backgroundColor: colors.bg2,
  },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  source: {
    flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start', paddingVertical: 1, paddingHorizontal: 6,
    borderWidth: 1, borderColor: colors.line, borderRadius: 999, backgroundColor: colors.bg3,
  },
  outcome: { paddingHorizontal: 6, borderWidth: 1, borderColor: '#4a5162', borderRadius: 999 },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 'auto', marginVertical: -8, marginRight: -8 },
  tool: { width: 44, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  check: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: '#4a5162', alignItems: 'center', justifyContent: 'center', marginRight: 2 },
  body: { gap: 8 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  pill: {
    minHeight: 20, justifyContent: 'center', paddingVertical: 1, paddingHorizontal: 7,
    borderWidth: 1, borderColor: colors.line, borderRadius: 999, backgroundColor: 'rgba(29, 33, 44, 0.72)',
  },
  addNote: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', minHeight: 44, marginVertical: -6, paddingHorizontal: 2 },
  note: { paddingLeft: 8, borderLeftWidth: 1, borderLeftColor: colors.line, gap: 1 },
  swipeLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, borderRadius: 8, marginRight: -8 },
  swipeRight: { flexDirection: 'row', gap: 6, paddingLeft: 8 },
  swipeBtn: { width: 76, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 8 },
})
