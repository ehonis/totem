// One list (the right-hand sheet of web/src/components/ListsView.tsx), pushed from
// the Lists page: rename in place, add items, check them off, swipe one away, and
// link the open todos it relates to.
import React, { useEffect, useRef, useState } from 'react'
import { FlatList, StyleSheet, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import { MenuView } from '@react-native-menu/menu'
import { colors, alpha, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Press, Spinner } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success, tap } from '../../ui/haptics'
import { Hi, CheckIcon, ChevronDownIcon, ChevronLeftIcon, LinkIcon, PlusIcon, TrashIcon, XMarkIcon } from '../../lib/icons'
import {
  addListItems, deleteList, deleteListItem, linkListTodo, unlinkListTodo, updateList, updateListItem,
} from '../../lib/api'
import type { ListItem, TotemList } from '../../lib/lists/types'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { acceptList, loadLists, setLists, useLists } from './store'

export default function ListDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const insets = useSafeAreaInsets()
  const { lists, todos, loaded } = useLists()
  const list = lists.find((value) => value.id === id) ?? null
  const [title, setTitle] = useState(list?.title ?? '')
  const [newItem, setNewItem] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const itemInput = useRef<TextInput>(null)

  useEffect(() => { if (!loaded) void loadLists() }, [loaded])
  useEffect(() => { if (list) setTitle(list.title) }, [list?.title])

  async function apply(run: () => Promise<{ list: TotemList }>) {
    setBusy(true); setError('')
    try { acceptList((await run()).list) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'That change could not be saved.') }
    finally { setBusy(false) }
  }

  async function submitItem() {
    if (!list || !newItem.trim()) return
    const value = newItem.trim(); setNewItem('')
    await apply(() => addListItems(list.id, [{ text: value }]))
    itemInput.current?.focus()
  }

  // A check is instant on the phone; the bridge's copy replaces it when it answers.
  async function check(item: ListItem, checked: boolean) {
    if (!list) return
    if (checked) success(); else tap()
    acceptList({
      ...list,
      checkedCount: list.checkedCount + (checked ? 1 : -1),
      items: list.items.map((value) => (value.id === item.id ? { ...value, checked } : value)),
    })
    try { acceptList((await updateListItem(item.id, { checked })).list) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'That change could not be saved.'); void loadLists() }
  }

  async function removeList() {
    if (!list || !(await confirm(`Delete “${list.title}” and all of its items?`))) return
    setBusy(true); setError('')
    try {
      await deleteList(list.id)
      setLists((current) => ({ lists: current.lists.filter((value) => value.id !== list.id) }))
      router.back()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That list could not be deleted.')
    } finally { setBusy(false) }
  }

  const linked = new Set(list?.linkedTodos.map((todo) => todo.id) ?? [])
  const availableTodos = todos.filter((todo) => !linked.has(todo.id) && todo.status !== 'done')

  const top = (
    <View style={st.bar}>
      <IconBtn icon={ChevronLeftIcon} size={22} label="Back to lists" onPress={() => router.back()} />
      <T size={17} weight={600} align="center" style={{ flex: 1 }}>Lists</T>
      <View style={{ width: 40 }} />
    </View>
  )

  if (!list) {
    return (
      <View style={[st.screen, { paddingTop: insets.top }]}>
        {top}
        {loaded ? <View style={st.empty}><Hi icon={CheckIcon} size={26} color={colors.muted} /><T size={16} weight={600}>This list is gone</T><T size={13} muted>It may have been deleted somewhere else.</T></View> : <Spinner />}
      </View>
    )
  }

  const header = (
    <View>
      <View style={st.head}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          onBlur={() => { const next = title.trim(); if (next && next !== list.title) void apply(() => updateList(list.id, { title: next })); else setTitle(list.title) }}
          accessibilityLabel="List title"
          selectionColor={colors.accent}
          keyboardAppearance="dark"
          returnKeyType="done"
          style={st.title}
        />
        <T size={12} muted numberOfLines={1} style={{ flexShrink: 0, fontVariant: ['tabular-nums'] }}>{`${list.checkedCount} of ${list.itemCount}`}</T>
        <Btn compact kind="danger" icon={TrashIcon} disabled={busy} onPress={() => void removeList()} style={{ width: 36, flexShrink: 0, paddingHorizontal: 0 }} />
      </View>
      {error ? (
        <View style={st.error} accessibilityRole="alert">
          <T size={13} color={colors.red} style={{ flex: 1 }}>{error}</T>
          <Press onPress={() => { setError(''); void loadLists() }}><T size={13} muted style={{ textDecorationLine: 'underline' }}>Retry</T></Press>
        </View>
      ) : null}
      <View style={st.addRow}>
        <TextInput
          ref={itemInput}
          value={newItem}
          onChangeText={setNewItem}
          placeholder="Add an item"
          placeholderTextColor={colors.muted}
          selectionColor={colors.accent}
          keyboardAppearance="dark"
          accessibilityLabel="New list item"
          returnKeyType="done"
          blurOnSubmit={false}
          onSubmitEditing={() => void submitItem()}
          style={st.input}
        />
        <Btn kind="primary" compact icon={PlusIcon} title="Add" disabled={busy || !newItem.trim()} onPress={() => void submitItem()} style={{ minHeight: 42 }} />
      </View>
    </View>
  )

  const footer = (
    <View style={st.todos}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <T size={12} weight={700}>Related todos</T>
        <T size={11} muted>{String(list.linkedTodos.length)}</T>
      </View>
      {list.linkedTodos.map((todo) => (
        <View key={todo.id} style={st.todo}>
          <Hi icon={LinkIcon} size={14} color={colors.muted} />
          <T size={14} style={{ flex: 1 }}>{todo.title}</T>
          <T size={12} muted style={{ textTransform: 'capitalize' }}>{todo.status}</T>
          <IconBtn icon={XMarkIcon} size={14} box={34} color={colors.muted} label={`Unlink ${todo.title}`} disabled={busy}
            onPress={() => void apply(() => unlinkListTodo(list.id, todo.id))} />
        </View>
      ))}
      <MenuView
        title="Link a todo"
        themeVariant="dark"
        actions={availableTodos.length
          ? availableTodos.map((todo) => ({ id: todo.id, title: todo.title }))
          : [{ id: '', title: 'No open todos to link', attributes: { disabled: true } }]}
        onPressAction={({ nativeEvent }) => { if (nativeEvent.event) { tap(); void apply(() => linkListTodo(list.id, nativeEvent.event)) } }}
      >
        <View style={st.link} accessibilityRole="button" accessibilityLabel="Todo to link">
          <Hi icon={LinkIcon} size={14} color={colors.text} />
          <T size={15} style={{ flex: 1 }} color={colors.muted}>Link a todo…</T>
          <Hi icon={ChevronDownIcon} size={14} color={colors.muted} />
        </View>
      </MenuView>
    </View>
  )

  return (
    <View style={[st.screen, { paddingTop: insets.top }]}>
      {top}
      <FlatList
        data={list.items}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={<T size={13} muted align="center" style={{ paddingVertical: 32 }}>This list is empty. Add the first item above.</T>}
        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: insets.bottom + 24 + FAB_CLEARANCE / 2 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        renderItem={({ item }) => (
          <ReanimatedSwipeable
            friction={1.6}
            rightThreshold={48}
            renderRightActions={() => (
              <Press style={st.deleteAction} onPress={() => void apply(() => deleteListItem(item.id))} accessibilityLabel={`Remove ${item.text}`}>
                <Hi icon={TrashIcon} size={18} color={colors.white} />
              </Press>
            )}
          >
            <View style={st.item}>
              <Press onPress={() => void check(item, !item.checked)} hitSlop={10} accessibilityRole="checkbox" accessibilityState={{ checked: item.checked }} accessibilityLabel={`Check ${item.text}`}
                style={[st.box, item.checked && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
                {item.checked ? <Hi icon={CheckIcon} size={13} color={colors.white} strokeWidth={3} /> : null}
              </Press>
              <Press onPress={() => void check(item, !item.checked)} style={{ flex: 1 }}>
                <T size={15} color={item.checked ? colors.muted : colors.text} style={item.checked ? { textDecorationLine: 'line-through' } : undefined}>{item.text}</T>
              </Press>
              <IconBtn icon={XMarkIcon} size={15} box={34} color={colors.muted} label={`Remove ${item.text}`} disabled={busy}
                onPress={() => void apply(() => deleteListItem(item.id))} />
            </View>
          </ReanimatedSwipeable>
        )}
      />
    </View>
  )
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  bar: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  title: { flex: 1, minWidth: 0, paddingVertical: 4, paddingHorizontal: 8, marginLeft: -8, color: colors.text, fontSize: 21, fontFamily: fonts[700] },
  error: { flexDirection: 'row', gap: 12, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#5a2a37', borderRadius: 8 },
  addRow: { flexDirection: 'row', gap: 8, paddingBottom: 12, marginBottom: 2, borderBottomWidth: 1, borderBottomColor: colors.line },
  input: {
    flex: 1, minHeight: 42, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 9,
    backgroundColor: colors.bg, color: colors.text, fontSize: 16, fontFamily: fonts[400],
  },
  item: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.bg, borderBottomWidth: 1, borderBottomColor: colors.line },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: '#5b6273', backgroundColor: alpha('#ffffff', 0.04), alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  deleteAction: { width: 72, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.red },
  todos: { marginTop: 24, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line },
  todo: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 38 },
  link: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, marginTop: 8, paddingHorizontal: 10,
    borderWidth: 1, borderColor: colors.line, borderRadius: 9, backgroundColor: colors.bg,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 24 },
})
