// One open row of the shared task sheet, drawn among the tasks (GET /api/todos/sheet).
// Read-only: Totem never writes to the sheet, so the row has no check circle and no
// swipe; the sheet's mark sits where the circle would. Tapping opens its detail (the
// task route, todo/[id], with the row's "sheet:…" id); holding offers Open in sheet.
// VoiceOver reads it as one element, with Open in sheet as an action.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import IconTable from '@tabler/icons-react-native/dist/esm/icons/IconTable.mjs'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { showMenu } from '../../ui/menu'
import { tap } from '../../ui/haptics'
import { Hi, CalendarDaysIcon, FlagIcon } from '../../lib/icons'
import { openUrl } from '../../lib/siblingApps'
import type { SheetItem } from '../../lib/todos/types'
import { dateLabel, dueText, dueTone } from './format'
import { SHEET_PRIORITY_WORD } from './list'
import { openTodo } from './nav'
import { sheetPriorityColor } from './compose/labels'

// The sheet's own word, in the colour of the task priority it ranks with (sheetPriorityColor).
export const SHEET_GREEN = '#79cf91'

export default function SheetCard({ item, source, now, dueSection, dim }: {
  item: SheetItem
  /** The sheet's name (the feed's title). */
  source: string
  now: Date
  /** The due section the row is drawn in, whose heading already says part of its date. */
  dueSection?: 'overdue' | 'today' | 'upcoming' | 'nodate'
  /** While selecting tasks: a sheet row cannot be selected. */
  dim?: boolean
}) {
  const tone = item.dueDate ? dueTone(item.dueDate, now, 'todo') : ''
  const dueColor = tone === 'overdue' ? '#ff7f95' : tone === 'today' ? '#efc765' : colors.muted

  const marks: React.ReactNode[] = [
    <View key="source" style={st.mark}>
      <T size={12.5} lineHeight={17} color={SHEET_GREEN} numberOfLines={1}>{source}</T>
    </View>,
  ]
  if (item.dueDate && !(dueSection === 'today' && tone === 'today')) {
    const text = dueSection === 'overdue' && tone === 'overdue' ? dateLabel(item.dueDate) : dueText(item.dueDate, now)
    marks.push(
      <View key="due" style={st.mark}>
        <Hi icon={CalendarDaysIcon} size={13} color={dueColor} />
        <T size={12.5} lineHeight={17} weight={tone === 'overdue' || tone === 'today' ? 600 : 400} color={dueColor}>{text}</T>
      </View>,
    )
  }
  if (item.priority) {
    marks.push(
      <View key="priority" style={st.mark}>
        <Hi icon={FlagIcon} size={13} color={sheetPriorityColor(item.priority)} strokeWidth={2} />
        <T size={12.5} lineHeight={17} weight={item.priority === 3 ? 400 : 600} color={sheetPriorityColor(item.priority)}>{SHEET_PRIORITY_WORD[item.priority]}</T>
      </View>,
    )
  }

  const spoken = [
    item.title,
    `from ${source}, read only`,
    item.dueDate ? (tone === 'overdue' ? `overdue, ${dateLabel(item.dueDate)}` : `due ${dueText(item.dueDate, now)}`) : null,
    item.priority ? `${SHEET_PRIORITY_WORD[item.priority]} priority` : null,
    item.who ? `assigned to ${item.who}` : null,
  ].filter(Boolean).join(', ')

  const open = () => openTodo({ id: item.id })
  const openSheet = () => void openUrl(item.url)
  const hold = () => { tap(); showMenu([{ label: `Open in ${source}`, onPress: openSheet }, { label: 'Details', onPress: open }], { title: item.title }) }

  return (
    <View style={[st.card, dim && { opacity: 0.55 }]}>
      <View style={st.lead} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <View style={st.badge}><IconTable size={15} color={SHEET_GREEN} strokeWidth={2} /></View>
      </View>
      <Press
        onPress={dim ? undefined : open}
        onLongPress={dim ? undefined : hold}
        disabled={dim}
        delayLongPress={350}
        style={st.body}
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint={dim ? 'Sheet rows cannot be selected.' : 'Opens the row. Hold for Open in sheet.'}
        accessibilityActions={dim ? undefined : [{ name: 'activate' }, { name: 'sheet', label: `Open in ${source}` }]}
        onAccessibilityAction={({ nativeEvent }) => (nativeEvent.actionName === 'sheet' ? openSheet() : open())}
      >
        <T size={15} lineHeight={20} weight={500}>{item.title}</T>
        <View style={st.marks}>{marks}</View>
      </Press>
      <View style={{ width: 10 }} />
    </View>
  )
}

const st = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'flex-start', minHeight: 56, paddingLeft: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.bg2,
  },
  lead: { width: 44, height: 44, marginTop: 6, alignItems: 'center', justifyContent: 'center' },
  // The same 24 pt footprint as a task's ring, square, so it never reads as something to tick.
  badge: { width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: '#3fb95018' },
  body: { flex: 1, minWidth: 0, gap: 3, paddingTop: 15, paddingBottom: 13, paddingLeft: 2 },
  marks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 3, marginTop: 2 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
})
