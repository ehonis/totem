// Sheet detents: [0.75, 1] (formSheet, grabber; liquid glass on iOS 26, else solid with
// corner radius 22; registered in src/app/_layout.tsx as glassSheet).
//
// The drawer list's parked chats: Snoozed or Settled, switched at the top, for the
// scope the list shows (every chat, Home's, or one project's with its folders; one
// Settled shelf for them all, as in T3 Code). Opened from the shelf buttons in the
// drawer's foot, so the drawer itself never scrolls a second list. Rows are the
// drawer's own (ChatsNav ThreadItem): tap opens the chat and closes the sheet and
// the drawer; swipe left for Wake, Snooze or Un-settle; long-press for the rest
// (Discard draft closes the sheet first, so its Undo line in the drawer is in sight).
//
// The root is collapsable={false}: on glass it is clear, and flattened away it would
// let react-native-screens stretch the list over the heading (mobile/AGENTS.md → Gotchas).
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import AlarmClockOff from 'lucide-react-native/icons/alarm-clock-off'
import Archive from 'lucide-react-native/icons/archive'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChat } from '../../lib/chat/store'
import { keptOpenId } from '../../lib/chat/settle'
import { sidebarLists, scopeLabel, placeLabel } from '../../lib/chat/sidebar'
import { attentionOf } from '../../lib/chat/attention'
import type { ChatThread } from '../../lib/chat/types'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Segmented } from '../../ui/kit'
import { GLASS } from '../../ui/glass'
import { closeDrawer } from '../../shell/drawerGesture'
import { openChat } from '../../shell/nav'
import { useNow } from './threadOps'
import { scopeFrom } from './chatsScope'
import { ThreadItem } from './ChatsNav'

type Kind = 'snoozed' | 'settled'

export default function ShelfSheet() {
  const params = useLocalSearchParams<{ kind?: string; scope?: string; showing?: string }>()
  const [kind, setKind] = useState<Kind>(params.kind === 'snoozed' ? 'snoozed' : 'settled')
  const insets = useSafeAreaInsets()
  const allThreads = useChat((s) => s.threads) as ChatThread[]
  const projects = useChat((s) => s.projects)
  const runs = useChat((s) => s.runs)
  const handoffs = useChat((s) => s.handoffs)
  const activeId = useChat((s) => s.activeId)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const scope = scopeFrom(params.scope, projects)
  const now = useNow(allThreads)
  // The open chat keeps its place only if the chat screen was showing it (the drawer's `chatShowing`).
  const opened = keptOpenId(activeId, useChat((s) => s.openedSettled))
  const keep = params.showing === '0' ? null : opened
  const { snoozed, settled } = useMemo(() => sidebarLists(allThreads, {
    now, autoDays, live: (id) => !!runs[id], needsYou: (t) => !!attentionOf(t, handoffs[t.id]), openId: keep, activeId, scope, projects,
  }), [allThreads, now, autoDays, runs, handoffs, keep, activeId, scope, projects])
  const rows = kind === 'snoozed' ? snoozed : settled
  const place = scopeLabel(scope, projects)

  // Open on the chat that is showing, if it is on this shelf.
  const list = useRef<FlatList<ChatThread>>(null)
  const at = rows.findIndex((t) => t.id === activeId)
  useEffect(() => {
    if (at < 4) return
    const t = setTimeout(() => list.current?.scrollToIndex({ index: at, viewPosition: 0.4, animated: false }), 60)
    return () => clearTimeout(t)
  }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id: string) => {
    closeDrawer()
    router.back()
    openChat(id)
  }

  return (
    <View collapsable={false} style={st.sheet}>
      <View style={st.head}>
        <T size={20} weight={700} numberOfLines={1} accessibilityRole="header" style={st.title}>{place}</T>
        <Segmented
          style={[st.switch, GLASS && st.switchGlass]}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'snoozed', label: 'Snoozed', count: snoozed.length },
            { value: 'settled', label: 'Settled', count: settled.length },
          ]}
        />
        <T size={12.5} muted style={st.note}>
          {kind === 'snoozed'
            ? 'Back in your list when they wake. Swipe left on one to wake it now.'
            : `Settled by you, done and read, or quiet for ${autoDays} ${autoDays === 1 ? 'day' : 'days'}. Swipe left on one to bring it back.`}
        </T>
      </View>
      <View style={st.rule} />
      <FlatList
        ref={list}
        style={st.list}
        data={rows}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => <ThreadItem t={item} glass={GLASS} shelf={kind} now={now} active={item.id === activeId} live={!!runs[item.id]} onOpen={open} beforeDiscard={() => router.back()} place={{ project: null, label: placeLabel(item, projects) || 'Home' }} />}
        onScrollToIndexFailed={({ index, averageItemLength }) => list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false })}
        contentContainerStyle={[st.rows, { paddingBottom: insets.bottom + 16 }, rows.length === 0 && st.rowsEmpty]}
        ListEmptyComponent={<Empty kind={kind} />}
        initialNumToRender={16}
      />
    </View>
  )
}

function Empty({ kind }: { kind: Kind }) {
  const Icon = kind === 'snoozed' ? AlarmClockOff : Archive
  return (
    <View style={st.empty}>
      <Icon size={28} color={colors.muted} strokeWidth={1.75} />
      <T size={14} muted style={{ textAlign: 'center' }}>{kind === 'snoozed' ? 'Nothing snoozed here.' : 'Nothing settled here.'}</T>
    </View>
  )
}

const st = StyleSheet.create({
  // Clear over the system's glass sheet; solid without it.
  sheet: { flex: 1, backgroundColor: GLASS ? 'transparent' : colors.bg2 },
  head: { paddingTop: 24, paddingHorizontal: 20, paddingBottom: 10 },
  title: { marginBottom: 14 },
  switch: { alignSelf: 'stretch' },
  // The switch's solid well reads as a hole in the glass; a faint wash keeps it part of the sheet.
  switchGlass: { backgroundColor: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.08)' },
  note: { paddingTop: 10, lineHeight: 17 },
  rule: { height: StyleSheet.hairlineWidth, marginHorizontal: 20, backgroundColor: GLASS ? 'rgba(255,255,255,0.1)' : colors.line },
  list: { flex: 1 },
  rows: { paddingHorizontal: 8, paddingTop: 6 },
  rowsEmpty: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingBottom: 48 },
})
