// Productivity → Lists (web/src/components/ListsView.tsx). The web's phone layout
// stacks the list index above the open list; here the index is the page and a list
// opens as its own pushed screen (src/app/list/[id].tsx), the way a phone's
// Reminders does. Creating a list opens it straight away, as the web selects it.
import React, { useEffect, useRef, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Spinner } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { Hi, ChevronRightIcon, PlusIcon, TrashIcon } from '../../lib/icons'
import { createList, deleteList } from '../../lib/api'
import type { TotemList } from '../../lib/lists/types'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { loadLists, setLists, useLists } from '../lists/store'

export function openList(id: string) {
  router.push({ pathname: '/list/[id]', params: { id } })
}

export default function ListsView({ active }: { active: boolean }) {
  const { lists, loading, loaded, error } = useLists()
  const [newList, setNewList] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [pulling, setPulling] = useState(false)
  const wasActive = useRef(false)

  useEffect(() => {
    if (active && !wasActive.current) void loadLists()
    wasActive.current = active
  }, [active])

  async function submitList() {
    if (!newList.trim()) return
    setBusy(true); setActionError('')
    try {
      const { list } = await createList({ title: newList.trim() })
      setLists((current) => ({ lists: [...current.lists, list] })); setNewList('')
      openList(list.id)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That list could not be created.')
    } finally { setBusy(false) }
  }

  async function removeList(list: TotemList) {
    if (!(await confirm(`Delete “${list.title}” and all of its items?`))) return false
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
  const header = (
    <View style={st.band}>
      <View style={st.newRow}>
        <TextInput
          value={newList}
          onChangeText={setNewList}
          placeholder="New list"
          placeholderTextColor={colors.muted}
          selectionColor={colors.accent}
          keyboardAppearance="dark"
          accessibilityLabel="New list name"
          returnKeyType="done"
          onSubmitEditing={() => void submitList()}
          style={st.newInput}
        />
        <Btn kind="primary" compact icon={PlusIcon} disabled={busy || !newList.trim()} onPress={() => void submitList()} style={st.newBtn} />
      </View>
      {shownError ? (
        <View style={st.error} accessibilityRole="alert">
          <T size={13} color={colors.red} style={{ flex: 1 }}>{shownError}</T>
          <Press onPress={() => { setActionError(''); void loadLists() }}><T size={13} muted style={{ textDecorationLine: 'underline' }}>Retry</T></Press>
        </View>
      ) : null}
    </View>
  )

  if (loading && !loaded) {
    return <View style={{ flex: 1 }}>{header}<Spinner /></View>
  }

  return (
    <FlatList
      data={lists}
      keyExtractor={(list) => list.id}
      ListHeaderComponent={header}
      contentContainerStyle={{ paddingBottom: FAB_CLEARANCE }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await loadLists(); setPulling(false) }} />}
      ListEmptyComponent={<T size={13} muted lineHeight={20} style={{ padding: 18 }}>Create a list for groceries, packing, or anything else you want to check off.</T>}
      renderItem={({ item }) => <ListRow list={item} onDelete={removeList} />}
    />
  )
}

function ListRow({ list, onDelete }: { list: TotemList; onDelete: (list: TotemList) => Promise<boolean> }) {
  const swipe = useRef<SwipeableMethods>(null)
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      rightThreshold={48}
      renderRightActions={() => (
        <Press
          style={st.deleteAction}
          accessibilityLabel={`Delete ${list.title}`}
          onPress={async () => { const gone = await onDelete(list); if (!gone) swipe.current?.close() }}
        >
          <Hi icon={TrashIcon} size={20} color={colors.white} />
          <T size={12} weight={600} color={colors.white}>Delete</T>
        </Press>
      )}
    >
      <Press haptic onPress={() => openList(list.id)} style={st.row} accessibilityRole="button">
        <T size={15} style={{ flex: 1 }} numberOfLines={1}>{list.title}</T>
        <T size={12} muted style={{ fontVariant: ['tabular-nums'] }}>{`${list.checkedCount}/${list.itemCount}`}</T>
        <Hi icon={ChevronRightIcon} size={16} color={colors.muted} />
      </Press>
    </ReanimatedSwipeable>
  )
}

const st = StyleSheet.create({
  band: { padding: 14, gap: 10, backgroundColor: colors.bg2, borderBottomWidth: 1, borderBottomColor: colors.line },
  newRow: { flexDirection: 'row', gap: 8 },
  newInput: {
    flex: 1, minHeight: 42, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 9,
    backgroundColor: colors.bg, color: colors.text, fontSize: 16, fontFamily: fonts[400],
  },
  newBtn: { minHeight: 42, width: 42, paddingHorizontal: 0 },
  error: { flexDirection: 'row', gap: 12, padding: 10, borderWidth: 1, borderColor: '#5a2a37', borderRadius: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16,
    backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line,
  },
  deleteAction: { width: 84, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: colors.red },
})
