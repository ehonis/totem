// One task on the list (web/src/todos/TodoCard.tsx), rebuilt for a thumb: a check
// target on the left, the title, and one quiet line of marks under it (due, priority,
// venture, the linked GitHub issue and its live state, repeats, tags). Everything else
// the web's popovers held is one native "…" menu, which a long press also opens as
// action sheets (a MenuView wrapped round the whole card swallowed its taps on a phone).
// A list card swipes: right is the circle (done, or reopen a finished one), left for
// Tomorrow, the snooze presets and the recycle bin.
//
// Ticking the circle (or swiping right) fills it, strikes the title and buzzes, then
// waits a short beat (tap again to change your mind) before the card fades and the
// page moves it to Done. The page owns what happens next (the inline Undo line); the
// card only owns the beat.
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'
import IconBrandGithub from '@tabler/icons-react-native/dist/esm/icons/IconBrandGithub.mjs'
import IconRepeat from '@tabler/icons-react-native/dist/esm/icons/IconRepeat.mjs'
import IconZzz from '@tabler/icons-react-native/dist/esm/icons/IconZzz.mjs'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { showActionTree } from '../../ui/menu'
import { success, tap } from '../../ui/haptics'
import {
  Hi, ArrowUturnLeftIcon, CalendarDaysIcon, ChatBubbleLeftIcon, CheckIcon, EllipsisHorizontalIcon, FlagIcon, SunIcon, TrashIcon,
} from '../../lib/icons'
import { useVentureTags } from '../../lib/todos/ventureTags'
import { priorityLabel, priorityMarks, type IssueState, type Todo, type TodoStatus } from '../../lib/todos/types'
import { dateKey, dateLabel, dueDateChoices, dueText, dueTone, snoozeTimes } from './format'
import { PickWhenSheet } from './ui'
import CheckCircle from './CheckCircle'
import { morningSnooze } from './board'
import { DONE_BEAT_MS, issueLinkOf, spokenState, swipeRight } from './list'
import { ISSUE_COLOR } from './issueLink'
import { PRIORITY_COLOR } from './compose/labels'
import { todoContext } from '../../lib/chat/about/context'
import { CHAT_ABOUT_ACTION, chatAbout } from '../../ui/chatAbout'
import { openUrl } from '../../lib/siblingApps'

export interface TodoCardProps {
  todo: Todo
  onOpen?: (todo: Todo) => void
  onAddNote?: (todo: Todo) => void
  onMove?: (todo: Todo, status: TodoStatus) => unknown
  onReorder?: (todo: Todo, direction: -1 | 1) => void
  /** Which way "Move task up/down" can go from here; both by default. */
  reorder?: { up: boolean; down: boolean; note?: string }
  onSnooze?: (todo: Todo, until: string) => unknown
  onNotDoing?: (todo: Todo) => unknown
  onDueDate?: (todo: Todo, dueDate: string | null) => void
  onPriority?: (todo: Todo, priority: Todo['priority']) => void
  onDelete?: (todo: Todo) => unknown
  now?: () => Date
  selected?: boolean
  onSelect?: (todo: Todo, selected: boolean) => void
  /** Board cards swipe; archive and panel cards do not. */
  swipeable?: boolean
  /** Archived cards sit back a little (.todo-archive .todo-board-card). */
  dim?: boolean
  /** The due section the card is drawn in, whose heading already says part of its date. */
  dueSection?: 'overdue' | 'today'
  /** The linked issue's live state, once read (GET /api/todos/issue-states). */
  issue?: IssueState | null
  /** Just added: drawn with an accent edge for a moment, so the eye finds it. */
  fresh?: boolean
}

/** The text and icon on the green Done swipe: dark, like the check inside a ticked circle. */
export const SWIPE_DONE_INK = '#06210d'
// Tall enough for a thumb, narrow enough that two marks side by side (12 apart) don't overlap.
const MARK_SLOP = { top: 14, bottom: 14, left: 5, right: 5 }

// The native menu (Fabric) carries one level of subactions and drops anything deeper,
// so a list that is itself a submenu of the "…" comes flat (`nested`), its extra rows
// as plain rows rather than an inline group.
const group = (id: string, rows: MenuAction[], nested: boolean): MenuAction[] =>
  nested ? rows : [{ id, title: '', displayInline: true, subactions: rows }]

/** The web's due-date options, as menu rows. Shared by the overdue shortcut and "Due date…". */
function dueActions(todo: Todo, now: Date, nested = false): MenuAction[] {
  return [
    ...dueDateChoices(now).map((option): MenuAction => ({
      id: `due:${option.key}`, title: option.label, subtitle: option.detail,
      attributes: todo.dueDate === option.key ? { disabled: true } : undefined,
    })),
    ...group('due-more', [
      { id: 'due:pick', title: 'Pick a due date', image: 'calendar' },
      ...(todo.dueDate ? [{ id: 'due:none', title: 'Remove due date', image: 'arrow.uturn.left' }] : []),
    ], nested),
  ]
}

function snoozeActions(todo: Todo, now: Date, nested = false): MenuAction[] {
  return [
    ...snoozeTimes(now, todo.dueDate).map((option): MenuAction => ({
      id: `snooze:${option.value.toISOString()}`, title: option.label, subtitle: option.detail,
    })),
    ...group('snooze-more', [{ id: 'snooze:pick', title: 'Pick a date and time', image: 'calendar' }], nested),
  ]
}


export default function TodoCard({
  todo, onOpen, onAddNote, onMove, onReorder, reorder, onSnooze, onDueDate, onNotDoing, onPriority, onDelete,
  now = () => new Date(), selected, onSelect, swipeable, dim, dueSection, issue, fresh,
}: TodoCardProps) {
  const link = issueLinkOf(todo)
  const latestNote = todo.notes.reduce<Todo['notes'][number] | null>((latest, item) => (
    !latest || item.createdAt > latest.createdAt || (item.createdAt === latest.createdAt && item.id > latest.id) ? item : latest
  ), null)
  const [pick, setPick] = useState<'snooze' | 'due' | null>(null)
  const [ticking, setTicking] = useState(false)
  const beat = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set from the end of the beat until the move is sent: the fade can't be taken back.
  const leaving = useRef(false)
  const mounted = useRef(true)
  const latest = useRef({ todo, onMove })
  latest.current = { todo, onMove }
  const swipe = useRef<SwipeableMethods>(null)
  const reduced = useReducedMotion()
  const leave = useSharedValue(0)
  const ventureTags = useVentureTags()
  const today = now()
  const toneNow = dueTone(todo.dueDate, today, todo.status)
  const notDoing = todo.outcome === 'not_doing'
  const done = todo.status === 'done'
  const label = priorityLabel(todo.priority)
  const ventureColor = todo.area === 'Ventures' ? ventureTags.find((tag) => tag.name === todo.ventureTag)?.color : null
  const glow = useSharedValue(fresh ? 1 : 0)
  useEffect(() => {
    if (!fresh) return
    glow.value = 1
    glow.value = withTiming(0, { duration: reduced ? 0 : 1600 })
  }, [fresh, reduced, glow])
  const glowStyle = useAnimatedStyle(() => ({ borderColor: glow.value > 0.01 ? `rgba(91, 140, 255, ${0.25 + glow.value * 0.75})` : colors.line }))

  // A tick is a promise: if the row goes (a search, a filter, a scroll) before its beat ends, the move still goes out.
  useEffect(() => () => {
    mounted.current = false
    if (!beat.current) return
    clearTimeout(beat.current); beat.current = null
    void latest.current.onMove?.(latest.current.todo, 'done')
  }, [])
  // A card that moved (or was put back) starts fresh, whatever its last tick was doing.
  useEffect(() => { setTicking(false); leave.value = 0 }, [todo.status, todo.outcome, leave])

  const leaveStyle = useAnimatedStyle(() => ({ opacity: 1 - leave.value * 0.85, transform: [{ scale: 1 - leave.value * 0.03 }] }))

  // Any other action on the card during the beat replaces the tick rather than racing it.
  function dropBeat() {
    if (!beat.current) return
    clearTimeout(beat.current); beat.current = null
    setTicking(false)
  }

  function check() {
    if (!onMove || leaving.current) return
    if (beat.current) {
      // A second tap inside the beat takes it back.
      clearTimeout(beat.current); beat.current = null
      setTicking(false); tap()
      return
    }
    if (done) { tap(); void onMove(todo, 'todo'); return }
    setTicking(true); success()
    beat.current = setTimeout(() => {
      beat.current = null
      leaving.current = true
      leave.value = reduced ? 1 : withTiming(1, { duration: 180 })
      setTimeout(async () => {
        // The move changes the board at once (optimistically); only that gap needs guarding.
        const sent = latest.current.onMove?.(latest.current.todo, 'done')
        leaving.current = false
        await sent
        // Refused (the card is back where it was) or kept: either way this card is drawn from its task again.
        if (mounted.current) { setTicking(false); leave.value = 0 }
      }, reduced ? 0 : 170)
    }, reduced ? 350 : DONE_BEAT_MS)
  }

  const reorderUp = reorder?.up ?? true
  const reorderDown = reorder?.down ?? true
  const actions: MenuAction[] = [
    ...(!done && onSnooze ? [{ id: 'snooze', title: 'Snooze…', image: 'moon.zzz', subactions: snoozeActions(todo, today, true) }] : []),
    ...(onDueDate ? [{
      id: 'due', title: 'Due date…', subtitle: todo.dueDate ? dateLabel(todo.dueDate) : 'None', image: 'calendar',
      subactions: dueActions(todo, today, true),
    }] : []),
    {
      id: 'priority', title: 'Priority…', subtitle: priorityMarks(todo.priority) || label, image: 'flag',
      subactions: ([4, 3, 2, 1] as Todo['priority'][]).map((priority) => ({
        id: `priority:${priority}`, title: `Set priority to ${priorityLabel(priority)}`, subtitle: priorityMarks(priority) || undefined,
        state: todo.priority === priority ? 'on' : 'off', attributes: todo.priority === priority ? { disabled: true } : undefined,
      })),
    },
    ...(done ? [{ id: 'reopen', title: 'Reopen', image: 'arrow.uturn.left' }] : []),
    // Only when the order is the owner's to change here: both disabled says nothing worth a row.
    ...(reorderUp || reorderDown ? [{
      id: 'order', title: '', displayInline: true, subactions: [
        { id: 'up', title: 'Move task up', subtitle: reorderUp ? undefined : reorder?.note, image: 'arrow.up', attributes: reorderUp ? undefined : { disabled: true } },
        { id: 'down', title: 'Move task down', subtitle: reorderDown ? undefined : reorder?.note, image: 'arrow.down', attributes: reorderDown ? undefined : { disabled: true } },
      ],
    } satisfies MenuAction] : []),
    {
      id: 'more', title: '', displayInline: true, subactions: [
        ...(onAddNote ? [{ id: 'note', title: 'Add a note', image: 'text.bubble' }] : []),
        ...(onNotDoing && !notDoing ? [{ id: 'notdoing', title: 'Not doing this', image: 'nosign' }] : []),
        { id: 'edit', title: 'Edit task', image: 'square.and.pencil' },
        CHAT_ABOUT_ACTION,
        { id: 'delete', title: 'Move task to recycle bin', image: 'trash', attributes: { destructive: true } },
      ],
    },
  ]

  function act(id: string) {
    // Mid-fade the tick is already on its way; another action would race it.
    if (leaving.current) return
    dropBeat()
    tap()
    if (id === 'reopen') return void onMove?.(todo, 'todo')
    if (id.startsWith('priority:')) return onPriority?.(todo, Number(id.slice(9)) as Todo['priority'])
    // The calendar sheet waits for the menu or action sheet to finish closing: iOS
    // refuses to present a modal while another presentation is still animating.
    if (id === 'due:pick') return void setTimeout(() => setPick('due'), 400)
    if (id === 'due:none') return onDueDate?.(todo, null)
    if (id.startsWith('due:')) return onDueDate?.(todo, id.slice(4))
    if (id === 'snooze:pick') return void setTimeout(() => setPick('snooze'), 400)
    if (id.startsWith('snooze:')) return void onSnooze?.(todo, id.slice(7))
    if (id === 'up') return onReorder?.(todo, -1)
    if (id === 'down') return onReorder?.(todo, 1)
    if (id === 'note') return onAddNote?.(todo)
    if (id === 'notdoing') return void onNotDoing?.(todo)
    if (id === 'edit') return onOpen?.(todo)
    if (id === CHAT_ABOUT_ACTION.id) return chatAbout(() => todoContext(todo))
    if (id === 'delete') return void onDelete?.(todo)
  }

  const openActions = onMove ? () => showActionTree(actions, act, todo.title) : undefined
  const struck = ticking || notDoing || done
  const dueColor = toneNow === 'overdue' ? '#ff7f95' : toneNow === 'today' ? '#efc765' : colors.muted

  // The quiet line: each mark only when it says something.
  const marks: React.ReactNode[] = []
  // Under a Today heading the date says nothing more; under Overdue the day is enough.
  if (todo.dueDate && !(dueSection === 'today' && toneNow === 'today')) {
    const text = dueSection === 'overdue' && toneNow === 'overdue' ? dateLabel(todo.dueDate) : dueText(todo.dueDate, today, todo.status)
    const body = (
      <View style={st.mark}>
        <Hi icon={CalendarDaysIcon} size={13} color={dueColor} />
        <T size={12.5} lineHeight={17} weight={toneNow === 'overdue' || toneNow === 'today' ? 600 : 400} color={dueColor}>{text}</T>
      </View>
    )
    // A late task's date is its own reschedule button, the web's overdue shortcut.
    marks.push(toneNow === 'overdue' && onDueDate && !onSelect ? (
      <Press key="due" hitSlop={MARK_SLOP} onPress={() => showActionTree(dueActions(todo, today), act, 'Reschedule')} accessibilityRole="button" accessibilityLabel={`Overdue, ${dateLabel(todo.dueDate)}. Reschedule`}>
        {body}
      </Press>
    ) : <View key="due">{body}</View>)
  }
  if (label !== 'P4') {
    marks.push(
      <View key="priority" style={st.mark} accessibilityLabel={`${label} priority`}>
        <Hi icon={FlagIcon} size={13} color={PRIORITY_COLOR[label]} strokeWidth={2} />
        <T size={12.5} lineHeight={17} weight={600} color={PRIORITY_COLOR[label]}>{label}</T>
      </View>,
    )
  }
  if (todo.area === 'Ventures' && todo.ventureTag) {
    marks.push(
      <View key="venture" style={st.mark}>
        <View style={[st.dot, { backgroundColor: ventureColor || colors.accent2 }]} />
        <T size={12.5} lineHeight={17} muted numberOfLines={1}>{todo.ventureTag}</T>
      </View>,
    )
  }
  if (link) {
    // The issue's number, and its live state as a dot once read: green open, purple closed (GitHub's own colours).
    const body = (
      <View style={st.mark}>
        <IconBrandGithub size={13} color={colors.muted} strokeWidth={2} />
        <T size={12.5} lineHeight={17} muted>{`#${link.number}`}</T>
        {issue ? <View style={[st.dot, { backgroundColor: ISSUE_COLOR[issue.state] }]} /> : null}
        {issue?.state === 'closed' ? <T size={12.5} lineHeight={17} color={ISSUE_COLOR.closed}>closed</T> : null}
      </View>
    )
    marks.push(!onSelect ? (
      <Press key="issue" hitSlop={MARK_SLOP} onPress={() => void openUrl(link.url)} accessibilityRole="link" accessibilityLabel={`Open issue ${link.repo}#${link.number}`}>{body}</Press>
    ) : <View key="issue">{body}</View>)
  }
  if (todo.recurrence) marks.push(<View key="repeat" style={st.mark} accessibilityLabel="Repeats"><IconRepeat size={13} color={colors.muted} strokeWidth={2} /></View>)
  for (const tag of todo.tags.slice(0, 2)) marks.push(<T key={`tag-${tag.id}`} size={12.5} lineHeight={17} muted>#{tag.name}</T>)
  if (notDoing) marks.push(<T key="notdoing" size={12.5} lineHeight={17} muted>Not doing</T>)

  // VoiceOver reads the card as one element, so it hears the marks too, and gets the
  // nested buttons (reschedule, the issue link) as actions on it.
  const spoken = [
    todo.title,
    todo.dueDate ? (toneNow === 'overdue' ? `overdue, ${dateLabel(todo.dueDate)}` : `due ${dueText(todo.dueDate, today, todo.status)}`) : null,
    label !== 'P4' ? `${label} priority` : null,
    todo.area === 'Ventures' && todo.ventureTag ? todo.ventureTag : null,
    link ? `issue ${link.number}${issue ? `, ${issue.state}` : ''}` : null,
    todo.recurrence ? 'repeats' : null,
    spokenState(todo),
    latestNote ? `note: ${latestNote.body.length > 80 ? `${latestNote.body.slice(0, 79)}…` : latestNote.body}` : null,
  ].filter(Boolean).join(', ')
  const a11yActions = onSelect ? undefined : [
    { name: 'activate' },
    ...(openActions ? [{ name: 'longpress', label: 'Actions' }] : []),
    ...(toneNow === 'overdue' && onDueDate ? [{ name: 'reschedule', label: 'Reschedule' }] : []),
    ...(link ? [{ name: 'issue', label: 'Open the GitHub issue' }] : []),
  ]
  function a11yAction(name: string) {
    if (name === 'activate') return onOpen?.(todo)
    if (name === 'longpress') return openActions?.()
    if (name === 'reschedule') return showActionTree(dueActions(todo, today), act, 'Reschedule')
    if (name === 'issue' && link) return void openUrl(link.url)
  }

  const lead = onSelect ? (
    <Press haptic onPress={() => onSelect(todo, !selected)} accessibilityRole="checkbox" accessibilityState={{ checked: !!selected }} accessibilityLabel={`Select ${todo.title}`} style={st.lead}>
      <View style={[st.box, selected && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
        {selected ? <Hi icon={CheckIcon} size={13} color={colors.white} strokeWidth={3} /> : null}
      </View>
    </Press>
  ) : onMove ? (
    <View style={st.lead}>
      <CheckCircle
        look={notDoing ? 'notDoing' : done ? 'done' : 'todo'}
        checked={ticking || done}
        onPress={check}
        label={todo.title}
        hint={done ? 'Reopens the task' : ticking ? 'Tap again to keep it open' : 'Marks the task done'}
      />
    </View>
  ) : <View style={st.lead}><CheckCircle look={notDoing ? 'notDoing' : done ? 'done' : 'todo'} checked={done} onPress={() => onOpen?.(todo)} label={todo.title} disabled /></View>

  const card = (
    <Animated.View style={[st.card, fresh && !selected && glowStyle, dim && { opacity: 0.82 }, selected && st.cardSelected, leaveStyle]}>
      {lead}
      {/* The body opens the task (or ticks it while selecting) and long-presses into the actions. */}
      <Press
        onPress={() => (onSelect ? onSelect(todo, !selected) : onOpen?.(todo))}
        onLongPress={onSelect ? undefined : openActions}
        delayLongPress={350}
        style={st.body}
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityActions={a11yActions}
        onAccessibilityAction={({ nativeEvent }) => a11yAction(nativeEvent.actionName)}
        accessibilityHint={onSelect ? undefined : onMove ? 'Opens the task. Hold for actions.' : 'Opens the task.'}
      >
        <T size={15} lineHeight={20} weight={500} color={struck ? colors.muted : colors.text} style={struck ? st.struck : undefined}>{todo.title}</T>
        {todo.description ? <T size={13} muted lineHeight={18} numberOfLines={1}>{todo.description}</T> : null}
        {marks.length ? <View style={st.marks}>{marks}</View> : null}
        {latestNote ? (
          <View style={st.mark}>
            <Hi icon={ChatBubbleLeftIcon} size={12} color={colors.muted} />
            <T size={12.5} lineHeight={17} color="#b0b6c4" numberOfLines={1} style={{ flex: 1 }}>{latestNote.body}</T>
          </View>
        ) : null}
      </Press>
      {onMove && !onSelect ? (
        <MenuView title={todo.title} actions={actions} themeVariant="dark" onPressAction={({ nativeEvent }) => act(nativeEvent.event)}>
          <View style={st.more} accessibilityRole="button" accessibilityLabel={`More actions for ${todo.title}`}>
            <Hi icon={EllipsisHorizontalIcon} size={20} color={colors.muted} />
          </View>
        </MenuView>
      ) : <View style={{ width: 10 }} />}
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
            if (which === 'snooze') void onSnooze?.(todo, value.toISOString())
            else onDueDate?.(todo, dateKey(value))
          }}
        />
      ) : null}
    </Animated.View>
  )

  if (!swipeable || !onMove || onSelect) return card

  const next = swipeRight(todo)
  // Dark ink on the bright green, as the amber Snooze button has: white on it is about 2.4:1.
  const nextLook = next.to === 'done'
    ? { icon: CheckIcon, color: colors.green, ink: SWIPE_DONE_INK }
    : { icon: ArrowUturnLeftIcon, color: colors.accent, ink: colors.white }
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      leftThreshold={72}
      rightThreshold={48}
      overshootLeft={false}
      renderLeftActions={() => (
        <View style={[st.swipeLeft, { backgroundColor: nextLook.color }]}>
          <Hi icon={nextLook.icon} size={20} color={nextLook.ink} strokeWidth={2.2} />
          <T size={13} weight={600} color={nextLook.ink}>{next.label}</T>
        </View>
      )}
      renderRightActions={() => {
        const morning = !done && onSnooze ? morningSnooze(now()) : undefined
        return (
        <View style={st.swipeRight}>
          {morning ? (
            <Press
              style={[st.swipeBtn, { backgroundColor: colors.accent }]}
              accessibilityLabel={`Snooze ${todo.title} until ${morning.label.toLowerCase()}, 9 AM`}
              onPress={() => { swipe.current?.close(); act(`snooze:${morning.value.toISOString()}`) }}
            >
              <Hi icon={SunIcon} size={20} color={colors.white} />
              <T size={12} weight={600} color={colors.white} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{morning.label}</T>
            </Press>
          ) : null}
          {!done && onSnooze ? (
            <MenuView
              title="Snooze until"
              actions={snoozeActions(todo, now())}
              themeVariant="dark"
              onPressAction={({ nativeEvent }) => { swipe.current?.close(); act(nativeEvent.event) }}
            >
              <View style={[st.swipeBtn, { backgroundColor: colors.amber }]} accessibilityRole="button" accessibilityLabel={`Snooze ${todo.title}`}>
                <IconZzz size={20} color="#1d1606" strokeWidth={2.2} />
                <T size={12} weight={600} color="#1d1606">Snooze</T>
              </View>
            </MenuView>
          ) : null}
          <Press
            style={[st.swipeBtn, { backgroundColor: colors.red }]}
            accessibilityLabel={`Move ${todo.title} to the recycle bin`}
            // No confirm: it only goes to the recycle bin, and the page offers Undo, as the "…" menu's delete does.
            onPress={() => { swipe.current?.close(); act('delete') }}
          >
            <Hi icon={TrashIcon} size={20} color={colors.white} />
            <T size={12} weight={600} color={colors.white}>Delete</T>
          </Press>
        </View>
        )
      }}
      onSwipeableOpen={(direction) => {
        // RIGHT means the card travelled right, uncovering the left action.
        if (direction !== 'right') return
        swipe.current?.close()
        // The card already shows ticked: a swipe during the beat (or the fade) leaves the tick to finish.
        if (beat.current || leaving.current) return
        // The circle's own path: the same buzz, the same short beat to take it back, the same move.
        check()
      }}
    >
      {card}
    </ReanimatedSwipeable>
  )
}

const st = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'flex-start', minHeight: 56, paddingLeft: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.bg2,
  },
  cardSelected: { borderColor: colors.accent, backgroundColor: '#18213a' },
  lead: { width: 44, height: 44, marginTop: 6, alignItems: 'center', justifyContent: 'center' },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: '#596074', alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 3, paddingTop: 15, paddingBottom: 13, paddingLeft: 2 },
  struck: { textDecorationLine: 'line-through' },
  marks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 3, marginTop: 2 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  more: { width: 44, height: 44, marginTop: 6, alignItems: 'center', justifyContent: 'center' },
  swipeLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, borderRadius: 12, marginRight: -12 },
  swipeRight: { flexDirection: 'row', gap: 6, paddingLeft: 8 },
  swipeBtn: { width: 72, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 12 },
})
