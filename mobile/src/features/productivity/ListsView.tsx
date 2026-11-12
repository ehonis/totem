// Productivity → Lists (web/src/components/ListsView.tsx). The page's top bar names
// it, so the page is the lists themselves: one row each with how far along it is,
// and a "New list" row at the foot. A list opens as its own pushed screen
// (src/app/list/[id].tsx), as Reminders does; a new list opens straight away, as
// the web selects it. Swipe a row (or long-press it) to delete, with a confirm.
import React, { useEffect, useRef, useState } from 'react'
import { RefreshControl, StyleSheet, TextInput, View } from 'react-native'
import Animated, { FadeIn, LinearTransition, useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { router } from 'expo-router'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Press, Spinner } from '../../ui/kit'
import { confirm, showMenu } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { Hi, CheckCircleIcon, ChevronRightIcon, LinkIcon, PlusIcon, TrashIcon } from '../../lib/icons'
import { createList, deleteList } from '../../lib/api'
import type { TotemList } from '../../lib/lists/types'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { loadLists, setLists, useLists } from '../lists/store'
import { listProgress } from '../lists/items'
import { ErrorLine } from '../lists/bits'
import IconListCheck from '@tabler/icons-react-native/dist/esm/icons/IconListCheck.mjs'

export function openList(id: string) {
  router.push({ pathname: '/list/[id]', params: { id } })
}

export default function ListsView({ active }: { active: boolean }) {
  const { lists, loading, loaded, error } = useLists()
  const [actionError, setActionError] = useState('')
  const [pulling, setPulling] = useState(false)
  const wasActive = useRef(false)

  useEffect(() => {
    if (active && !wasActive.current) void loadLists()
    wasActive.current = active
  }, [active])

  async function submitList(title: string) {
    setActionError('')
    try {
      const { list } = await createList({ title })
      setLists((current) => ({ lists: [...current.lists, list] }))
      success()
      openList(list.id)
      return true
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That list could not be created.')
      return false
    }
  }

  async function removeList(list: TotemList) {
    if (!(await confirm(`Delete “${list.title}”?`, { message: `Its ${list.itemCount === 1 ? 'item goes' : `${list.itemCount} items go`} with it. This can’t be undone.` }))) return false
    setActionError('')
    try {
      await deleteList(list.id)
      setLists((current) => ({ lists: current.lists.filter((value) => value.id !== list.id) }))
      return true
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That list could not be deleted.')
      return false
    }
  }

  const shownError = actionError || error

  if (loading && !loaded) return <Spinner label="Loading lists…" />

  const newRow = <NewListRow onSubmit={submitList} first={!lists.length} />

  return (
    <Animated.FlatList
      data={lists}
      keyExtractor={(list) => list.id}
      itemLayoutAnimation={LinearTransition.duration(200)}
      ListHeaderComponent={shownError ? (
        <ErrorLine text={shownError} onRetry={() => { setActionError(''); void loadLists() }} style={{ margin: 16, marginBottom: 4 }} />
      ) : null}
      ListFooterComponent={newRow}
      contentContainerStyle={{ paddingTop: 6, paddingBottom: FAB_CLEARANCE }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await loadLists(); setPulling(false) }} />}
      ListEmptyComponent={loaded ? (
        <View style={st.empty}>
          <IconListCheck size={34} strokeWidth={1.5} color={colors.muted} />
          <T size={16} weight={600}>No lists yet</T>
          <T size={14} muted align="center" lineHeight={20} style={{ maxWidth: 280 }}>
            Groceries, packing, anything you check off as you go. Name your first one below.
          </T>
        </View>
      ) : null}
      renderItem={({ item }) => <ListRow list={item} onDelete={removeList} />}
    />
  )
}

/** The foot of the page: "+ New list", which becomes its name field when tapped. */
function NewListRow({ onSubmit, first }: { onSubmit: (title: string) => Promise<boolean>; first: boolean }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const value = title.trim()
    if (!value || busy) return
    setBusy(true)
    const ok = await onSubmit(value)
    setBusy(false)
    if (ok) { setTitle(''); setEditing(false) }
  }
  if (!editing) {
    return (
      <Press haptic onPress={() => setEditing(true)} style={[st.newRow, first && st.newRowFirst]} accessibilityRole="button" accessibilityLabel="New list">
        <View style={st.plus}><Hi icon={PlusIcon} size={16} color={colors.accent} strokeWidth={2.4} /></View>
        <T size={16} weight={500} color={colors.accent}>New list</T>
      </Press>
    )
  }
  return (
    <Animated.View entering={FadeIn.duration(150)} style={[st.newRow, first && st.newRowFirst]}>
      <View style={st.plus}><Hi icon={PlusIcon} size={16} color={colors.accent} strokeWidth={2.4} /></View>
      <TextInput
        autoFocus
        value={title}
        onChangeText={setTitle}
        placeholder="Name the list"
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        keyboardAppearance="dark"
        accessibilityLabel="New list name"
        returnKeyType="done"
        editable={!busy}
        onSubmitEditing={() => void submit()}
        onBlur={() => { if (!title.trim()) setEditing(false) }}
        style={st.newInput}
      />
      {busy ? <Spinner style={{ paddingVertical: 0 }} /> : null}
    </Animated.View>
  )
}

function ListRow({ list, onDelete }: { list: TotemList; onDelete: (list: TotemList) => Promise<boolean> }) {
  const swipe = useRef<SwipeableMethods>(null)
  const progress = listProgress(list)
  const open = list.linkedTodos.filter((todo) => todo.status !== 'done').length
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: withTiming(progress.ratio, { duration: 300 }) }] }), [progress.ratio])
  const del = async () => { const gone = await onDelete(list); if (!gone) swipe.current?.close() }
  const summary = [progress.label, open ? `${open} linked ${open === 1 ? 'task' : 'tasks'}` : null].filter(Boolean).join(', ')

  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      rightThreshold={48}
      overshootRight={false}
      renderRightActions={() => (
        <Press style={st.deleteAction} accessibilityLabel={`Delete ${list.title}`} onPress={() => void del()}>
          <Hi icon={TrashIcon} size={20} color={colors.white} />
          <T size={12} weight={600} color={colors.white}>Delete</T>
        </Press>
      )}
    >
      <Press
          haptic
          onPress={() => openList(list.id)}
          onLongPress={() => showMenu([
            { label: 'Open', onPress: () => openList(list.id) },
            { label: 'Delete list…', destructive: true, onPress: () => void del() },
          ], { title: list.title })}
          delayLongPress={350}
          style={st.row}
          accessibilityRole="button"
          accessibilityLabel={`${list.title}, ${summary}`}
          accessibilityActions={[{ name: 'delete', label: 'Delete list' }]}
          onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') void del() }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 7 }}>
            <View style={st.titleLine}>
              <T size={16} weight={600} numberOfLines={1} style={{ flexShrink: 1 }} color={progress.done ? colors.muted : colors.text}>{list.title}</T>
              {progress.done ? <Hi icon={CheckCircleIcon} size={16} color={colors.green} /> : null}
            </View>
            <View style={st.metaLine}>
              <View style={st.track}><Animated.View style={[st.fill, progress.done && { backgroundColor: colors.green }, fill]} /></View>
              <T size={13} muted style={st.count}>{progress.label}</T>
              {open ? (
                <View style={st.linked}>
                  <Hi icon={LinkIcon} size={12} color={colors.muted} />
                  <T size={13} muted style={st.count}>{open}</T>
                </View>
              ) : null}
            </View>
          </View>
          <Hi icon={ChevronRightIcon} size={16} color={colors.muted} />
        </Press>
    </ReanimatedSwipeable>
  )
}

const st = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 12, paddingHorizontal: 16,
    backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line,
  },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  track: { flex: 1, maxWidth: 140, height: 4, borderRadius: 2, backgroundColor: colors.bg3, overflow: 'hidden' },
  fill: { width: '100%', height: 4, backgroundColor: colors.accent, transformOrigin: 'left center' },
  count: { fontVariant: ['tabular-nums'] },
  linked: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16 },
  newRowFirst: { marginTop: 4 },
  plus: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91, 140, 255, 0.14)',
  },
  newInput: { flex: 1, minHeight: 44, color: colors.text, fontSize: 16, fontFamily: fonts[500], paddingVertical: 8 },
  deleteAction: { width: 88, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: colors.red },
  empty: { alignItems: 'center', gap: 8, paddingTop: 56, paddingBottom: 12, paddingHorizontal: 24 },
})
