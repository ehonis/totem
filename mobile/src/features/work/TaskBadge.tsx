// A chat's linked task on its card in the drawer (web work/TaskBadge.tsx), the way
// T3 Code shows a thread's pull request: a glyph coloured by the task's state, its
// title and its due day. A tap opens the task's page (the phone's task card). Done
// reads green with a check, struck through.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import IconTable from '@tabler/icons-react-native/dist/esm/icons/IconTable.mjs'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { useBoard } from '../todos/store'
import { TI } from '../chat/ui'
import { IconChecklist, IconCircleCheck } from '../chat/icons'
import { dueLook, DUE_COLOR } from './look'
import { useTask } from './state'
import { openTask } from './nav'

const MUTED = 'rgba(138, 145, 163, 0.9)'

export default function TaskBadge({ taskRef }: { taskRef: string }) {
  const task = useTask(taskRef)
  const { loaded } = useBoard()
  if (!task) {
    return (
      <View style={st.badge} accessible accessibilityLabel={loaded ? 'A task that is no longer on your list' : 'Reading the task'}>
        <TI icon={IconChecklist} size={12} color={MUTED} />
        <T size={12} color={MUTED} numberOfLines={1} style={st.gone}>{loaded ? 'Task removed' : '…'}</T>
      </View>
    )
  }
  // One word ("Overdue", "Fri"): the title has the room.
  const due = task.done ? null : dueLook(task.dueDate, new Date(), true)
  const tone = task.done ? colors.green : due?.color === DUE_COLOR.overdue ? DUE_COLOR.overdue : due?.color === DUE_COLOR.today ? DUE_COLOR.today : colors.accent
  const icon = task.done ? IconCircleCheck : task.kind === 'sheet' ? IconTable : IconChecklist
  return (
    <Press
      style={st.badge}
      // A thumb's 44 points: 32 of its own and 6 each way, inside the row's padding (a touch
      // area never reaches past its parent's bounds).
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={() => { tap(); openTask(task.ref) }}
      accessibilityRole="button"
      accessibilityLabel={`Task: ${task.title}${task.done ? ', done' : due ? `, ${due.text}` : ''}`}
      accessibilityHint="Opens the task"
    >
      <TI icon={icon} size={12} color={tone} />
      <T size={12} numberOfLines={1} color={task.done ? MUTED : textAlpha(78)} style={[st.title, task.done && st.struck]}>{task.title}</T>
      {due ? <T size={12} weight={due.strong ? 600 : 400} color={due.color} style={st.due}>{due.text}</T> : null}
    </Press>
  )
}

const st = StyleSheet.create({
  badge: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 6, marginLeft: -6, borderRadius: 6 },
  title: { flexShrink: 1 },
  struck: { textDecorationLine: 'line-through' },
  due: { flexShrink: 0, fontVariant: ['tabular-nums'] },
  gone: { fontStyle: 'italic', flexShrink: 1 },
})
