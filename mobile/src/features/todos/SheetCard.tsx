// One row of the shared task sheet, drawn among the tasks (GET /api/todos/sheet).
// Totem never writes to the sheet. The owner can still get a row out of the way:
// done for him, or snoozed, kept in Totem only (todos/sheet-marks.mjs; store.ts
// markSheet), and the sheet is unchanged. The sheet's mark sits where a task's
// circle would, so it never reads as something everyone sees ticked. Swipe right
// for Done for me (Put back on a done row), left for Tomorrow and the snooze
// presets; the "…" and a long press hold the same, plus Open in sheet. Tapping
// opens its detail (the task route, todo/[id], with the row's "sheet:…" id).
// VoiceOver reads it as one element, with the actions on it.
import React, { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import IconTable from '@tabler/icons-react-native/dist/esm/icons/IconTable.mjs'
import IconZzz from '@tabler/icons-react-native/dist/esm/icons/IconZzz.mjs'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { showActionTree } from '../../ui/menu'
import { tap } from '../../ui/haptics'
import { Hi, ArrowUturnLeftIcon, CalendarDaysIcon, CheckIcon, EllipsisHorizontalIcon, FlagIcon, SunIcon } from '../../lib/icons'
import { openUrl } from '../../lib/siblingApps'
import type { SheetHiddenItem, SheetItem } from '../../lib/todos/types'
import type { Project } from '../../lib/chat/types'
import { ProjectIcon } from '../chat/ThreadIcon'
import { dateLabel, dueText, dueTone, snoozeTimes } from './format'
import { morningSnooze, sheetMarkOf, wakeLabel } from './board'
import { SHEET_PRIORITY_WORD } from './list'
import { openTodo } from './nav'
import { sheetPriorityColor } from './compose/labels'
import { PickWhenSheet } from './ui'
import { SWIPE_DONE_INK } from './TodoCard'

// The sheet's own word, in the colour of the task priority it ranks with (sheetPriorityColor).
export const SHEET_GREEN = '#79cf91'

export type SheetMarkChange = 'done' | 'snoozed' | null

/** The row's menu: Done for me or Put back, the snooze presets (one submenu level: Fabric drops deeper), the sheet. */
export function sheetActions(item: SheetItem | SheetHiddenItem, source: string, now: Date, canMark: boolean): MenuAction[] {
  const mark = sheetMarkOf(item, now)
  return [
    ...(canMark && mark ? [{ id: 'putback', title: 'Put back on my list', subtitle: mark.state === 'done' ? 'Marked done for you' : mark.until ? `Snoozed until ${wakeLabel(new Date(mark.until), now)}` : undefined, image: 'arrow.uturn.left' }] : []),
    ...(canMark && mark?.state !== 'done' ? [{ id: 'done', title: 'Done for me', subtitle: `${source} is unchanged`, image: 'checkmark.circle' }] : []),
    ...(canMark && mark?.state !== 'done' ? [{
      id: 'snooze', title: 'Snooze…', subtitle: 'For you only', image: 'moon.zzz',
      subactions: [
        ...snoozeTimes(now).map((option): MenuAction => ({ id: `snooze:${option.value.toISOString()}`, title: option.label, subtitle: option.detail })),
        { id: 'snooze:pick', title: 'Pick a date and time', image: 'calendar' },
      ],
    } satisfies MenuAction] : []),
    {
      id: 'more', title: '', displayInline: true, subactions: [
        { id: 'sheet', title: `Open in ${source}`, image: 'arrow.up.right.square' },
        { id: 'details', title: 'Details', image: 'info.circle' },
      ],
    },
  ]
}

export default function SheetCard({ item, source, now, dueSection, dim, folder, onMark, swipeable }: {
  /** An open row, or one the owner marked (it carries `mark`: Completed, or the Snoozed panel). */
  item: SheetItem | SheetHiddenItem
  /** The sheet's name (the feed's title). */
  source: string
  now: Date
  /** The due section the row is drawn in, whose heading already says part of its date. */
  dueSection?: 'overdue' | 'today' | 'upcoming' | 'nodate'
  /** While selecting tasks: a sheet row cannot be selected. */
  dim?: boolean
  /** The project or folder the row is filed under, when the row should say it (not under its own chip, not Personal). */
  folder?: { label: string; project: Pick<Project, 'icon' | 'image' | 'imageUrl'> } | null
  /** Done or snoozed for the owner only (the sheet unchanged), or put back with null. */
  onMark?: (item: SheetItem, next: SheetMarkChange, until?: Date) => unknown
  /** List rows swipe; nowhere else. */
  swipeable?: boolean
}) {
  const [pick, setPick] = useState(false)
  const swipe = useRef<SwipeableMethods>(null)
  const mark = sheetMarkOf(item, now)
  const done = mark?.state === 'done'
  const canMark = Boolean(onMark) && !dim
  const tone = item.dueDate ? dueTone(item.dueDate, now, 'todo') : ''
  const dueColor = tone === 'overdue' ? '#ff7f95' : tone === 'today' ? '#efc765' : colors.muted

  const marks: React.ReactNode[] = [
    <View key="source" style={st.mark}>
      <T size={12.5} lineHeight={17} color={SHEET_GREEN} numberOfLines={1}>{source}</T>
    </View>,
  ]
  if (done) marks.push(<T key="done" size={12.5} lineHeight={17} muted>Done for you</T>)
  if (folder) {
    marks.push(
      <View key="folder" style={[st.mark, { maxWidth: 200 }]}>
        <ProjectIcon p={folder.project} size={13} />
        <T size={12.5} lineHeight={17} color="#b0b6c4" numberOfLines={1} style={{ flexShrink: 1 }}>{folder.label}</T>
      </View>,
    )
  }
  if (item.dueDate && !done && !(dueSection === 'today' && tone === 'today')) {
    const text = dueSection === 'overdue' && tone === 'overdue' ? dateLabel(item.dueDate) : dueText(item.dueDate, now)
    marks.push(
      <View key="due" style={st.mark}>
        <Hi icon={CalendarDaysIcon} size={13} color={dueColor} />
        <T size={12.5} lineHeight={17} weight={tone === 'overdue' || tone === 'today' ? 600 : 400} color={dueColor}>{text}</T>
      </View>,
    )
  }
  if (item.priority && !done) {
    marks.push(
      <View key="priority" style={st.mark}>
        <Hi icon={FlagIcon} size={13} color={sheetPriorityColor(item.priority)} strokeWidth={2} />
        <T size={12.5} lineHeight={17} weight={item.priority === 3 ? 400 : 600} color={sheetPriorityColor(item.priority)}>{SHEET_PRIORITY_WORD[item.priority]}</T>
      </View>,
    )
  }

  const spoken = [
    item.title,
    `from ${source}`,
    done ? 'done for you' : null,
    folder ? `in ${folder.label}` : null,
    item.dueDate && !done ? (tone === 'overdue' ? `overdue, ${dateLabel(item.dueDate)}` : `due ${dueText(item.dueDate, now)}`) : null,
    item.priority && !done ? `${SHEET_PRIORITY_WORD[item.priority]} priority` : null,
    item.who ? `assigned to ${item.who}` : null,
  ].filter(Boolean).join(', ')

  const open = () => openTodo({ id: item.id })
  const openSheet = () => void openUrl(item.url)
  const actions = sheetActions(item, source, now, canMark)

  function act(id: string) {
    tap()
    if (id === 'done') return void onMark?.(item, 'done')
    if (id === 'putback') return void onMark?.(item, null)
    // The picker waits for the menu to finish closing: iOS refuses a second presentation mid-animation.
    if (id === 'snooze:pick') return void setTimeout(() => setPick(true), 400)
    if (id.startsWith('snooze:')) return void onMark?.(item, 'snoozed', new Date(id.slice(7)))
    if (id === 'sheet') return openSheet()
    if (id === 'details') return open()
  }
  const hold = () => showActionTree(actions, act, item.title)

  const a11yActions = dim ? undefined : [
    { name: 'activate' },
    ...(canMark && !done ? [{ name: 'done', label: 'Done for me' }] : []),
    ...(canMark && mark ? [{ name: 'putback', label: 'Put back on my list' }] : []),
    { name: 'longpress', label: 'Actions' },
    { name: 'sheet', label: `Open in ${source}` },
  ]
  function a11yAction(name: string) {
    if (name === 'done' || name === 'putback') return act(name)
    if (name === 'longpress') return hold()
    if (name === 'sheet') return openSheet()
    return open()
  }

  const card = (
    <View style={[st.card, dim && { opacity: 0.55 }]}>
      <View style={st.lead} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <View style={[st.badge, done && st.badgeDone]}>
          {done ? <Hi icon={CheckIcon} size={14} color={SWIPE_DONE_INK} strokeWidth={3} /> : <IconTable size={15} color={SHEET_GREEN} strokeWidth={2} />}
        </View>
      </View>
      <Press
        onPress={dim ? undefined : open}
        onLongPress={dim ? undefined : hold}
        disabled={dim}
        delayLongPress={350}
        style={st.body}
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint={dim ? 'Sheet rows cannot be selected.' : canMark ? 'Opens the row. Hold for Done for me, Snooze and Open in sheet.' : 'Opens the row. Hold for Open in sheet.'}
        accessibilityActions={a11yActions}
        onAccessibilityAction={({ nativeEvent }) => a11yAction(nativeEvent.actionName)}
      >
        <T size={15} lineHeight={20} weight={500} color={done ? colors.muted : colors.text} style={done ? st.struck : undefined}>{item.title}</T>
        <View style={st.marks}>{marks}</View>
      </Press>
      {canMark ? (
        <MenuView title={item.title} actions={actions} themeVariant="dark" onPressAction={({ nativeEvent }) => act(nativeEvent.event)}>
          <View style={st.more} accessibilityRole="button" accessibilityLabel={`More actions for ${item.title}`}>
            <Hi icon={EllipsisHorizontalIcon} size={20} color={colors.muted} />
          </View>
        </MenuView>
      ) : <View style={{ width: 10 }} />}
      {canMark ? (
        <PickWhenSheet
          visible={pick}
          title="Custom snooze time"
          mode="datetime"
          submitLabel="Snooze until selected time"
          initial={new Date(now.getTime() + 60 * 60_000)}
          minimum={now}
          onClose={() => setPick(false)}
          onSubmit={(value) => { setPick(false); void onMark?.(item, 'snoozed', value) }}
        />
      ) : null}
    </View>
  )

  if (!swipeable || !canMark) return card

  const right = done
    ? { icon: ArrowUturnLeftIcon, color: colors.accent, ink: colors.white, label: 'Put back' }
    : { icon: CheckIcon, color: colors.green, ink: SWIPE_DONE_INK, label: 'Done for me' }
  const morning = !done ? morningSnooze(now) : null
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      leftThreshold={72}
      rightThreshold={48}
      overshootLeft={false}
      renderLeftActions={() => (
        <View style={[st.swipeLeft, { backgroundColor: right.color }]}>
          <Hi icon={right.icon} size={20} color={right.ink} strokeWidth={2.2} />
          <T size={13} weight={600} color={right.ink}>{right.label}</T>
        </View>
      )}
      renderRightActions={done ? undefined : () => (
        <View style={st.swipeRight}>
          {morning ? (
            <Press
              style={[st.swipeBtn, { backgroundColor: colors.accent }]}
              accessibilityLabel={`Snooze ${item.title} until ${morning.label.toLowerCase()}, 9 AM, for you only`}
              onPress={() => { swipe.current?.close(); act(`snooze:${morning.value.toISOString()}`) }}
            >
              <Hi icon={SunIcon} size={20} color={colors.white} />
              <T size={12} weight={600} color={colors.white} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{morning.label}</T>
            </Press>
          ) : null}
          <MenuView
            title="Snooze (for you only)"
            actions={[
              ...snoozeTimes(now).map((option): MenuAction => ({ id: `snooze:${option.value.toISOString()}`, title: option.label, subtitle: option.detail })),
              { id: 'snooze-more', title: '', displayInline: true, subactions: [{ id: 'snooze:pick', title: 'Pick a date and time', image: 'calendar' }] },
            ]}
            themeVariant="dark"
            onPressAction={({ nativeEvent }) => { swipe.current?.close(); act(nativeEvent.event) }}
          >
            <View style={[st.swipeBtn, st.swipeMenuBtn, { backgroundColor: colors.amber }]} accessibilityRole="button" accessibilityLabel={`Snooze ${item.title}`}>
              <IconZzz size={20} color="#1d1606" strokeWidth={2.2} />
              <T size={12} weight={600} color="#1d1606">Snooze</T>
            </View>
          </MenuView>
        </View>
      )}
      onSwipeableOpen={(direction) => {
        // RIGHT means the card travelled right, uncovering the left action.
        if (direction !== 'right') return
        swipe.current?.close()
        act(done ? 'putback' : 'done')
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
  lead: { width: 44, height: 44, marginTop: 6, alignItems: 'center', justifyContent: 'center' },
  // The same 24 pt footprint as a task's ring, square, so it never reads as something everyone sees ticked.
  badge: { width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: '#3fb95018' },
  badgeDone: { backgroundColor: colors.green },
  body: { flex: 1, minWidth: 0, gap: 3, paddingTop: 15, paddingBottom: 13, paddingLeft: 2 },
  struck: { textDecorationLine: 'line-through' },
  marks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 3, marginTop: 2 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
  more: { width: 44, height: 44, marginTop: 6, alignItems: 'center', justifyContent: 'center' },
  swipeLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, borderRadius: 12, marginRight: -12 },
  swipeRight: { flexDirection: 'row', gap: 6, paddingLeft: 8 },
  swipeBtn: { width: 72, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 12 },
  swipeMenuBtn: { flex: 1 },
})
