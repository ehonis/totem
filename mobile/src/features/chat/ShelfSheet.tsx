// Sheet detents: [0.75, 1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// One list's parked chats: Snoozed or Settled, switched at the top. Opened from
// the shelf buttons in the drawer's foot (Home or the open project) or under a
// folder's chats, so the drawer itself never scrolls a second list. Rows are the
// drawer's own (ChatsNav ThreadItem): tap opens the chat and closes the sheet and
// the drawer; swipe left for Wake, Snooze or Un-settle; long-press for the rest.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChat } from '../../lib/chat/store'
import { shelve } from '../../lib/chat/settle'
import type { ChatThread } from '../../lib/chat/types'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Segmented } from '../../ui/kit'
import { closeDrawer } from '../../shell/drawerGesture'
import { openChat } from '../../shell/nav'
import { listThreads, useNow } from './threadOps'
import { ThreadItem } from './ChatsNav'

type Kind = 'snoozed' | 'settled'

export default function ShelfSheet() {
  const params = useLocalSearchParams<{ kind?: string; scope?: string }>()
  const scope = params.scope || 'home'
  const [kind, setKind] = useState<Kind>(params.kind === 'snoozed' ? 'snoozed' : 'settled')
  const insets = useSafeAreaInsets()
  const allThreads = useChat((s) => s.threads) as ChatThread[]
  const projects = useChat((s) => s.projects)
  const runs = useChat((s) => s.runs)
  const activeId = useChat((s) => s.activeId)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const threads = useMemo(() => listThreads(allThreads, projects, scope, activeId, runs), [allThreads, projects, scope, activeId, runs])
  const now = useNow(threads)
  const { snoozed, settled } = useMemo(() => shelve(threads, now, autoDays, (id) => !!runs[id]), [threads, now, autoDays, runs])
  const rows = kind === 'snoozed' ? snoozed : settled
  const place = scope === 'home' ? 'Home' : projects.find((p) => p.id === scope)?.name || 'Project'

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
    <View style={st.sheet}>
      <View style={st.head}>
        <T size={17} weight={600} numberOfLines={1} accessibilityRole="header">{place}</T>
      </View>
      <Segmented
        style={{ marginHorizontal: 16 }}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'snoozed', label: 'Snoozed', count: snoozed.length },
          { value: 'settled', label: 'Settled', count: settled.length },
        ]}
      />
      <T size={12.5} muted style={st.note}>
        {kind === 'snoozed'
          ? 'Back in your list when they wake. Swipe one to wake it now.'
          : `Chats you settled, or left quiet for ${autoDays} ${autoDays === 1 ? 'day' : 'days'}. Swipe one to bring it back.`}
      </T>
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => <ThreadItem t={item} shelf={kind} now={now} active={item.id === activeId} live={!!runs[item.id]} onOpen={open} />}
        onScrollToIndexFailed={({ index, averageItemLength }) => list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false })}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 16 }}
        ListEmptyComponent={<T size={14} muted style={st.empty}>{kind === 'snoozed' ? 'Nothing snoozed here.' : 'Nothing settled here.'}</T>}
        initialNumToRender={16}
      />
    </View>
  )
}

const st = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg2 },
  head: { paddingTop: 22, paddingBottom: 12, paddingHorizontal: 20 },
  note: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6 },
  empty: { paddingVertical: 28, textAlign: 'center' },
})
