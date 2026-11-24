// The chats working on a task, on its page (web work/TaskCard.tsx TaskChats): each
// one tap away, the latest first, and New chat for it, which opens in the task's
// folder and is linked to it from the first message. Opening one closes the page
// and the drawer under it.
import React, { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { threadTitle, useChat } from '../../lib/chat/store'
import type { ChatThread } from '../../lib/chat/types'
import { ago } from '../../lib/chat/settle'
import { chatsByTask, resolveRef } from '../../lib/work/groups'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { ThreadIcon } from '../chat/ThreadIcon'
import { LiveDot } from '../chat/ChatsNav'
import { TI } from '../chat/ui'
import { IconPlus } from '../chat/icons'
import { useWorkTasks } from './state'
import { newChatFromTaskPage, openTaskChat } from './nav'

export default function TaskChats({ taskRef }: { taskRef: string }) {
  const threads = useChat((s) => s.threads) as ChatThread[]
  const runs = useChat((s) => s.runs)
  const activeId = useChat((s) => s.activeId)
  const tasks = useWorkTasks()
  const chats = useMemo(() => chatsByTask(threads, tasks).get(resolveRef(taskRef, tasks)) || [], [threads, tasks, taskRef])
  const now = Date.now()
  return (
    <View style={st.section} accessibilityLabel="Chats">
      <View style={st.head}>
        {/* The count beside its heading, not out by New chat. */}
        <View style={st.title} accessibilityRole="header">
          <T size={15} weight={600}>Chats</T>
          {chats.length ? <T size={13} muted>{chats.length}</T> : null}
        </View>
        <Press haptic style={st.newBtn} onPress={() => newChatFromTaskPage(taskRef)} accessibilityRole="button" accessibilityLabel="New chat for this task">
          <TI icon={IconPlus} size={15} color={colors.accent} />
          <T size={14} weight={600} color={colors.accent}>New chat</T>
        </Press>
      </View>
      {chats.length ? (
        <View style={st.list}>
          {chats.map((t, i) => {
            const live = !!runs[t.id]
            const waiting = !!t.needsReply && !live
            return (
              <Press
                key={t.id}
                style={[st.row, i > 0 && st.rowLine, t.id === activeId && st.rowOn]}
                onPress={() => { tap(); openTaskChat(t.id) }}
                accessibilityRole="button"
                accessibilityLabel={`${threadTitle(t)}${live ? ', answering' : waiting ? ', waiting on you' : ''}`}
              >
                <ThreadIcon t={t} size={16} />
                <T size={15} numberOfLines={1} weight={waiting ? 600 : 400} color={waiting ? colors.text : textAlpha(88)} style={{ flex: 1 }}>{threadTitle(t)}</T>
                {live ? <LiveDot /> : waiting ? <View style={st.dot} /> : <T size={12} color={colors.muted} style={{ fontVariant: ['tabular-nums'] }}>{ago(t.updatedAt, now)}</T>}
              </Press>
            )
          })}
        </View>
      ) : <T size={14} muted>No chat is working on it yet. New chat starts one, linked to this task, in its folder.</T>}
    </View>
  )
}

const st = StyleSheet.create({
  section: { gap: 10, paddingTop: 18, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 6 },
  list: { borderRadius: 12, backgroundColor: colors.bg3, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 14 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowOn: { backgroundColor: colors.drawerOn },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
})
