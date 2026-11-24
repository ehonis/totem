// The strip over the composer that says which task a chat is for (web work/TaskBar.tsx):
// the task (a tap opens its page, the phone's task card), its due day, Done, and the
// link to change or drop it. On a new chat started from a task it says so, with ×
// to start a plain chat instead. The title gets the room: the icon says it is a task,
// and Done is a check that turns into Undo for a few seconds once pressed.
import React, { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import IconTable from '@tabler/icons-react-native/dist/esm/icons/IconTable.mjs'
import IconLink from '@tabler/icons-react-native/dist/esm/icons/IconLink.mjs'
import { clearTaskDraft } from '../../lib/chat/store'
import type { ChatThread } from '../../lib/chat/types'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import { useBoard } from '../todos/store'
import { TI, vc } from '../chat/ui'
import { IconArrowBackUp, IconChecklist, IconCircleCheck, IconX } from '../chat/icons'
import { useScreenReader, type UndoState } from '../todos/detail/bits'
import { undoLineTimeout } from '../todos/undo'
import { dueLook } from './look'
import { completeTask, useTask } from './state'
import { openTask, pickChatTask } from './nav'

/** Nothing (and no task reads) unless the chat has a task. */
export default function TaskStrip({ thread, draftTaskId }: { thread: ChatThread | null; draftTaskId: string | null }) {
  const ref = thread ? thread.taskId : draftTaskId
  // Keyed by chat and task: an Undo from one chat's strip never shows on another's.
  return ref ? <Strip key={`${thread?.id ?? 'new'}:${ref}`} thread={thread} taskRef={ref} /> : null
}

function Strip({ thread, taskRef }: { thread: ChatThread | null; taskRef: string }) {
  const task = useTask(taskRef)
  const { loaded } = useBoard()
  const [finishing, setFinishing] = useState(false)
  const [undo, setUndo] = useState<UndoState | null>(null)
  // As long as the docked Undo line: longer while VoiceOver runs.
  const reader = useScreenReader()
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), undoLineTimeout(reader))
    return () => clearTimeout(timer)
  }, [undo, reader])
  // One word ("Overdue", "Fri"): the title has the room.
  const due = task && !task.done ? dueLook(task.dueDate, new Date(), true) : null
  const title = task?.title || (loaded ? 'A task that is no longer on your list' : 'Reading the task…')
  const done = async () => {
    if (!task) return
    setFinishing(true)
    const undone = await completeTask(task.ref)
    setFinishing(false)
    if (undone) { success(); if (undone.action) setUndo(undone) }
  }
  return (
    <View style={st.bar} accessibilityRole="toolbar" accessibilityLabel="Linked task">
      <TI icon={task?.kind === 'sheet' ? IconTable : IconChecklist} size={15} color={vc.soft} />
      <Press
        style={st.main}
        disabled={!task}
        onPress={() => { tap(); if (task) openTask(task.ref) }}
        accessibilityRole="button"
        accessibilityLabel={`${thread ? 'Task' : 'New chat for'}: ${title}${task?.done ? ', done' : ''}${due ? `, ${due.text}` : ''}`}
        accessibilityHint={task ? 'Opens the task' : undefined}
      >
        {thread ? null : <T size={12.5} color={vc.soft} numberOfLines={1} style={{ flexShrink: 0 }}>New chat for</T>}
        <T size={13.5} weight={500} numberOfLines={1} color={task ? colors.text : colors.muted} style={[{ flexShrink: 1 }, task?.done && st.struck]}>{title}</T>
        {due ? <T size={12} weight={due.strong ? 600 : 400} color={due.color} numberOfLines={1} style={{ flexShrink: 0 }}>{due.text}</T> : null}
      </Press>
      {thread && undo ? (
        <Press style={st.icon} onPress={() => { tap(); undo.action?.run(); setUndo(null) }} accessibilityRole="button" accessibilityLabel={`Undo: ${undo.text}`}>
          <TI icon={IconArrowBackUp} size={17} color={colors.accent} />
        </Press>
      ) : thread && task && !task.done ? (
        <Press style={st.icon} disabled={finishing} onPress={() => { tap(); void done() }} accessibilityRole="button" accessibilityLabel={task.kind === 'sheet' ? 'Mark the task done for you' : 'Mark the task done'}>
          {/* Drawn as an action, not a status: green only on the done task itself. */}
          <TI icon={IconCircleCheck} size={19} color={vc.soft} />
        </Press>
      ) : null}
      {thread ? (
        <Press style={st.icon} onPress={() => { tap(); pickChatTask(thread.id) }} accessibilityRole="button" accessibilityLabel="Change or unlink the task">
          <TI icon={IconLink} size={16} color={vc.soft} />
        </Press>
      ) : (
        <Press style={st.icon} onPress={() => { tap(); clearTaskDraft() }} accessibilityRole="button" accessibilityLabel="Start a plain chat instead">
          <TI icon={IconX} size={16} color={vc.soft} />
        </Press>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6, paddingLeft: 12, paddingRight: 2, minHeight: 40, borderRadius: 12, backgroundColor: vc.raise },
  main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40 },
  struck: { textDecorationLine: 'line-through', opacity: 0.7 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
})
