// One list (the right-hand sheet of web/src/components/ListsView.tsx), pushed from
// the Lists page and built like Reminders: the title is the heading and edits in
// place, the items still to do come first, and checking one off fills its circle,
// buzzes, and slides it down into "Checked". Quick add rides the keyboard at the
// foot and keeps it up for the next item. Tap an item's words to edit them; swipe
// it (or long-press it) to remove it, with a few seconds to undo before the delete
// is sent. Tasks linked to the list sit under the title.
//
// Everything is instant on the phone; the bridge's copy replaces it when the last
// change in flight answers, so a quick run of checks never flickers back.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import Animated, { FadeIn, LayoutAnimationConfig, LinearTransition } from 'react-native-reanimated'
import { router, useIsFocused, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { MenuView } from '@react-native-menu/menu'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { IconBtn, Press, Spinner } from '../../ui/kit'
import { confirm, showMenu } from '../../ui/menu'
import { impact, success, tap } from '../../ui/haptics'
import {
  Hi, ArrowUpIcon, CheckCircleIcon, ChevronDownIcon, ChevronLeftIcon, EllipsisHorizontalIcon, LinkIcon, PlusIcon,
  TrashIcon, XMarkIcon,
} from '../../lib/icons'
import {
  addListItems, deleteList, deleteListItem, linkListTodo, unlinkListTodo, updateList, updateListItem,
} from '../../lib/api'
import { UndoLine, type UndoState } from '../todos/detail/bits'
import { setToastFloor } from '../../ui/toastFloor'
import type { LinkedListTodo, ListItem, TotemList } from '../../lib/lists/types'
import { acceptList, getListsState, loadLists, setLists, useLists } from './store'
import {
  cleanItemText, isPending, listProgress, pendingItem, splitItems, withChecked, withPending, withText, withoutItems,
} from './items'
import { createUndoQueue } from './undoQueue'
import { CheckCircle, ErrorLine } from './bits'
import { LandFlash, useLandOn, useStill } from '../../ui/landing'
import { farIndex } from '../../lib/landing'

/** How long a removal waits for Undo before it is sent. */
// As long as the Undo line stays up sighted (UndoLine, 8 s), so that Undo cancels the
// delete. With a screen reader the line stays up to two minutes; an Undo after the
// delete has gone puts the item back instead (remove's action).
const UNDO_MS = 8000

type Row = { kind: 'item'; item: ListItem } | { kind: 'checked'; count: number }

export default function ListDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const insets = useSafeAreaInsets()
  const { lists, todos, loaded, error: loadError } = useLists()
  const stored = lists.find((value) => value.id === id) ?? null
  const latest = useRef(stored)
  latest.current = stored

  const queue = useMemo(() => createUndoQueue(), [])
  const removing = useSyncExternalStore(queue.subscribe, queue.pending)
  const [drafts, setDrafts] = useState<ListItem[]>([])
  const [title, setTitle] = useState(stored?.title ?? '')
  const [newItem, setNewItem] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showChecked, setShowChecked] = useState(true)
  const [error, setError] = useState('')
  const [composerH, setComposerH] = useState(64)
  const titleInput = useRef<TextInput>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const sent = useRef(0)
  const draftSeq = useRef(0)
  // One Undo for the removals made in a row, shown on the quick-add bar (the phone
  // has no Undo toasts, and a removed item has no bin to come back from).
  const removals = useRef<{ items: ListItem[] }>({ items: [] })
  const [undo, setUndo] = useState<UndoState | null>(null)
  // Drafts whose add the bridge has confirmed, though a later change's answer is
  // the one drawn: after a failure and reload they are on the list for real.
  const landed = useRef(new Set<string>())

  useEffect(() => { if (!loaded) void loadLists() }, [loaded])
  useEffect(() => { if (stored) setTitle(stored.title) }, [stored?.title])
  // Leaving sends any removal still waiting; the Undo goes with the screen.
  useEffect(() => () => { queue.flush() }, [queue])
  // Toasts stack above the quick-add bar (and ride the keyboard with it), never on it.
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    setToastFloor({ dock: composerH, lift: insets.bottom })
    return () => setToastFloor({ dock: 0, lift: 0 })
  }, [focused, composerH, insets.bottom])

  const clearUndo = useCallback(() => setUndo(null), [])
  const list = stored ? withoutItems(withPending(stored, drafts), removing) : null

  // A search hit (src/lib/landing.ts) on this list: scroll to the item that matched
  // (opening Checked if it is there) and flash it; a title match just opens the list.
  const flatList = useRef<Animated.FlatList<Row>>(null)
  const drawnRows = useRef<Row[]>([])
  const still = useStill()
  const landedItem = useLandOn('list', {
    ready: loaded && focused && !!stored,
    prepare: ({ extra }) => { if (extra.item && stored?.items.some((item) => item.id === extra.item && item.checked)) setShowChecked(true) },
    locate: ({ id: listId, extra }) => {
      if (listId !== id) return null
      if (!extra.item) return listId
      const index = drawnRows.current.findIndex((row) => row.kind === 'item' && row.item.id === extra.item)
      if (index < 0) return null
      flatList.current?.scrollToIndex({ index, viewPosition: 0.4, animated: !still && !farIndex(0, index, 12) })
      return extra.item
    },
  })

  /**
   * Send one change, in order after the ones before it. Only the answer to the last
   * change in flight is drawn: an earlier one would undo the later optimistic edits.
   */
  function send(run: () => Promise<{ list: TotemList }>, settled?: (ok: boolean) => void) {
    const mine = ++sent.current
    chain.current = chain.current.then(async () => {
      try {
        const { list: next } = await run()
        settled?.(true)
        if (mine === sent.current) { acceptList(next); setDrafts([]); landed.current.clear() }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That change could not be saved.')
        settled?.(false)
        // In the chain, so later changes go after the bridge's copy, never under it.
        await loadLists()
        if (!getListsState().error) setDrafts((value) => value.filter((d) => !landed.current.has(d.id)))
      }
    })
  }

  // Unchecking is a tap, so a check needs no Undo.
  function toggle(item: ListItem, checked: boolean) {
    const current = latest.current
    if (!current || isPending(item)) return
    if (checked) success(); else tap()
    acceptList(withChecked(current, item.id, checked))
    send(() => updateListItem(item.id, { checked }))
  }

  function remove(item: ListItem) {
    if (isPending(item)) return
    impact()
    if (editingId === item.id) setEditingId(null)
    const run = removals.current
    // A removal while the last group's deletes are still waiting joins it: one
    // Undo, one window, restarted, for all of them. Once they have gone, a new
    // group starts.
    const waiting = queue.pending()
    const joining = run.items.some((it) => waiting.has(it.id))
    run.items = joining ? [...run.items.filter((it) => waiting.has(it.id)), item] : [item]
    const items = run.items
    for (const it of items) queue.schedule(it.id, () => commitRemoval(it), UNDO_MS)
    setUndo({
      id: Date.now(),
      text: items.length === 1 ? `Removed “${item.text}”` : `Removed ${items.length} items`,
      // Normally the deletes are still waiting and Undo cancels them. If the line
      // outlived the window, put the items back instead.
      action: {
        label: 'Undo',
        run: () => {
          for (const it of items) if (!queue.undo(it.id)) restore(it)
          removals.current.items = []
        },
      },
    })
  }

  function commitRemoval(item: ListItem) {
    const current = latest.current
    if (current) acceptList(withoutItems(current, new Set([item.id])))
    send(() => deleteListItem(item.id))
  }

  /** Add a removed item back (new id, at the end), checked if it was. */
  function restore(item: ListItem) {
    const listId = latest.current?.id
    if (!listId) return
    send(async () => {
      // Checked in the chain, after the delete and any recovery reload: a delete
      // that failed has already brought the item back.
      const now = getListsState().lists.find((l) => l.id === listId)
      if (now?.items.some((i) => i.id === item.id)) return { list: now }
      return addListItems(listId, [{ text: item.text, checked: item.checked }])
    })
  }

  function saveText(item: ListItem, raw: string) {
    setEditingId(null)
    const text = cleanItemText(raw)
    const current = latest.current
    if (!current || !text || text === item.text) return
    acceptList(withText(current, item.id, text))
    send(() => updateListItem(item.id, { text }))
  }

  function add() {
    const text = cleanItemText(newItem)
    const current = latest.current
    if (!current || !text) return
    setNewItem('')
    tap()
    const draft = pendingItem(current.id, text, ++draftSeq.current, [...current.items, ...drafts])
    setDrafts((value) => [...value, draft])
    send(() => addListItems(current.id, [{ text }]), (ok) => {
      if (ok) landed.current.add(draft.id)
      else setDrafts((value) => value.filter((d) => d.id !== draft.id))
    })
  }

  function saveTitle() {
    const current = latest.current
    const next = title.trim()
    if (!current) return
    if (!next || next === current.title) { setTitle(current.title); return }
    acceptList({ ...current, title: next })
    send(() => updateList(current.id, { title: next }))
  }

  async function removeList() {
    const current = latest.current
    if (!current) return
    if (!(await confirm(`Delete “${current.title}”?`, { message: `Its ${current.itemCount === 1 ? 'item goes' : `${current.itemCount} items go`} with it. This can’t be undone.` }))) return
    setError('')
    try {
      await deleteList(current.id)
      setLists((value) => ({ lists: value.lists.filter((l) => l.id !== current.id) }))
      router.back()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That list could not be deleted.')
    }
  }

  const bar = (
    <View style={st.bar}>
      <Press onPress={() => router.back()} hitSlop={8} style={st.back} accessibilityRole="button" accessibilityLabel="Back to lists">
        <Hi icon={ChevronLeftIcon} size={22} color={colors.accent} />
        <T size={17} color={colors.accent}>Lists</T>
      </Press>
      {list ? (
        <MenuView
          themeVariant="dark"
          actions={[
            { id: 'rename', title: 'Rename', image: 'pencil' },
            { id: 'checked', title: showChecked ? 'Hide checked items' : 'Show checked items', image: showChecked ? 'eye.slash' : 'eye' },
            { id: 'delete', title: 'Delete list…', image: 'trash', attributes: { destructive: true } },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === 'rename') titleInput.current?.focus()
            else if (nativeEvent.event === 'checked') setShowChecked((v) => !v)
            else if (nativeEvent.event === 'delete') void removeList()
          }}
        >
          <View style={st.more} accessibilityRole="button" accessibilityLabel="List actions">
            <Hi icon={EllipsisHorizontalIcon} size={22} color={colors.text} />
          </View>
        </MenuView>
      ) : null}
    </View>
  )

  if (!list) {
    return (
      <View style={[st.screen, { paddingTop: insets.top }]}>
        {bar}
        {loaded ? (
          <View style={st.gone}>
            <Hi icon={CheckCircleIcon} size={28} color={colors.muted} />
            <T size={16} weight={600}>This list is gone</T>
            <T size={14} muted align="center">It may have been deleted somewhere else.</T>
          </View>
        ) : loadError ? <ErrorLine text={loadError} onRetry={() => void loadLists()} style={{ margin: 16 }} /> : <Spinner />}
      </View>
    )
  }

  const progress = listProgress(list)
  const { open, checked } = splitItems(list.items)
  const rows: Row[] = [
    ...open.map((item) => ({ kind: 'item' as const, item })),
    ...(checked.length ? [{ kind: 'checked' as const, count: checked.length }] : []),
    ...(showChecked ? checked.map((item) => ({ kind: 'item' as const, item })) : []),
  ]
  drawnRows.current = rows
  const linked = new Set(list.linkedTodos.map((todo) => todo.id))
  const available = todos.filter((todo) => !linked.has(todo.id) && todo.status !== 'done')

  const header = (
    <View style={st.head}>
      <TextInput
        ref={titleInput}
        value={title}
        onChangeText={setTitle}
        onBlur={saveTitle}
        submitBehavior="blurAndSubmit"
        accessibilityLabel="List title"
        selectionColor={colors.accent}
        keyboardAppearance="dark"
        returnKeyType="done"
        style={st.title}
      />
      <T size={14} muted style={{ marginHorizontal: 16, fontVariant: ['tabular-nums'] }}>
        {list.itemCount ? `${progress.label} checked` : 'No items yet'}
      </T>
      <LinkedTasks
        list={list}
        available={available}
        onLink={(todoId) => { tap(); send(() => linkListTodo(list.id, todoId)) }}
        onUnlink={(todo) => { tap(); send(() => unlinkListTodo(list.id, todo.id)) }}
      />
      {error ? <ErrorLine text={error} onRetry={() => { setError(''); void loadLists() }} style={{ marginHorizontal: 16 }} /> : null}
      {open.length === 0 && checked.length > 0 ? (
        <Animated.View entering={FadeIn.duration(250)} style={st.allDone}>
          <Hi icon={CheckCircleIcon} size={18} color={colors.green} />
          <T size={15} weight={600} color={colors.green}>All done</T>
        </Animated.View>
      ) : null}
    </View>
  )

  return (
    <View style={[st.screen, { paddingTop: insets.top }]}>
      {bar}
      <LayoutAnimationConfig skipEntering>
      <Animated.FlatList
        ref={flatList}
        data={rows}
        extraData={landedItem}
        onScrollToIndexFailed={() => {}}
        keyExtractor={(row) => (row.kind === 'item' ? row.item.id : 'checked-head')}
        itemLayoutAnimation={LinearTransition.duration(220)}
        // The whole list in the first batch (lists are short), so no row fades in on open.
        initialNumToRender={Math.min(Math.max(rows.length, 10), 80)}
        ListHeaderComponent={header}
        ListEmptyComponent={(
          <View style={st.empty}>
            <T size={15} muted align="center" lineHeight={21}>{'Nothing on this list yet.\nType the first item below.'}</T>
          </View>
        )}
        contentContainerStyle={{ paddingBottom: composerH + 16 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        renderItem={({ item: row }) => row.kind === 'checked' ? (
          <Press
            onPress={() => { tap(); setShowChecked((v) => !v) }}
            style={st.group}
            accessibilityRole="button"
            accessibilityState={{ expanded: showChecked }}
            accessibilityLabel={`Checked, ${row.count}`}
          >
            <T size={14} weight={600} muted>Checked</T>
            <T size={14} muted style={{ fontVariant: ['tabular-nums'] }}>{row.count}</T>
            <View style={{ flex: 1 }} />
            <View style={{ transform: [{ rotate: showChecked ? '0deg' : '-90deg' }] }}>
              <Hi icon={ChevronDownIcon} size={14} color={colors.muted} />
            </View>
          </Press>
        ) : (
          <View>
            <ItemRow
              item={row.item}
              editing={editingId === row.item.id}
              onToggle={() => toggle(row.item, !row.item.checked)}
              onEdit={() => { if (!isPending(row.item)) setEditingId(row.item.id) }}
              onSave={(text) => saveText(row.item, text)}
              onRemove={() => remove(row.item)}
            />
            <LandFlash on={landedItem === row.item.id} radius={0} />
          </View>
        )}
      />
      </LayoutAnimationConfig>
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={st.dock}>
        {/* Measured with the Undo line, so the list's last row clears both. */}
        <View onLayout={(e) => setComposerH(e.nativeEvent.layout.height)}>
          {undo ? <View style={{ paddingHorizontal: 12, paddingBottom: 8, backgroundColor: colors.bg }}><UndoLine undo={undo} onDone={clearUndo} /></View> : null}
          <View style={[st.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <View style={st.addField}>
              <Hi icon={PlusIcon} size={18} color={colors.muted} />
              <TextInput
                value={newItem}
                onChangeText={setNewItem}
                placeholder="Add an item"
                placeholderTextColor={colors.muted}
                selectionColor={colors.accent}
                keyboardAppearance="dark"
                accessibilityLabel="New list item"
                returnKeyType="default"
                submitBehavior="submit"
                onSubmitEditing={add}
                style={st.addInput}
              />
            </View>
            <Press
              onPress={add}
              disabled={!cleanItemText(newItem)}
              style={[st.send, !cleanItemText(newItem) && { backgroundColor: colors.bg3 }]}
              accessibilityRole="button"
              accessibilityLabel="Add item"
            >
              <Hi icon={ArrowUpIcon} size={18} color={cleanItemText(newItem) ? colors.white : colors.muted} strokeWidth={2.4} />
            </Press>
          </View>
        </View>
      </KeyboardStickyView>
    </View>
  )
}

function ItemRow({ item, editing, onToggle, onEdit, onSave, onRemove }: {
  item: ListItem
  editing: boolean
  onToggle: () => void
  onEdit: () => void
  onSave: (text: string) => void
  onRemove: () => void
}) {
  const swipe = useRef<SwipeableMethods>(null)
  const [draft, setDraft] = useState(item.text)
  useEffect(() => { if (editing) setDraft(item.text) }, [editing, item.text])
  const pending = isPending(item)
  return (
    <Animated.View entering={FadeIn.duration(180)}>
      <ReanimatedSwipeable
        ref={swipe}
        friction={1.6}
        rightThreshold={44}
        overshootRight={false}
        enabled={!pending && !editing}
        renderRightActions={() => (
          <Press style={st.removeAction} onPress={() => { swipe.current?.close(); onRemove() }} accessibilityLabel={`Remove ${item.text}`}>
            <Hi icon={TrashIcon} size={19} color={colors.white} />
            <T size={12} weight={600} color={colors.white}>Remove</T>
          </Press>
        )}
      >
        <View style={[st.item, pending && { opacity: 0.55 }]}>
          <Press
            onPress={onToggle}
            disabled={pending}
            style={st.checkHit}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: item.checked, disabled: pending }}
            accessibilityLabel={item.text}
            accessibilityActions={[{ name: 'edit', label: 'Edit' }, { name: 'remove', label: 'Remove' }]}
            onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'edit') onEdit(); else if (e.nativeEvent.actionName === 'remove') onRemove() }}
          >
            <CheckCircle checked={item.checked} />
          </Press>
          {editing ? (
            <TextInput
              autoFocus
              value={draft}
              onChangeText={setDraft}
              onBlur={() => onSave(draft)}
              submitBehavior="blurAndSubmit"
              returnKeyType="done"
              selectionColor={colors.accent}
              keyboardAppearance="dark"
              accessibilityLabel={`Edit ${item.text}`}
              style={st.editInput}
            />
          ) : (
            <Press
              onPress={onEdit}
              onLongPress={() => showMenu([
                { label: item.checked ? 'Uncheck' : 'Check off', onPress: onToggle },
                { label: 'Edit', onPress: onEdit },
                { label: 'Remove', destructive: true, onPress: onRemove },
              ], { title: item.text })}
              delayLongPress={350}
              disabled={pending}
              style={st.textHit}
              accessible={false}
            >
              <T size={16} lineHeight={22} color={item.checked ? colors.muted : colors.text} style={item.checked ? st.struck : undefined}>{item.text}</T>
            </Press>
          )}
        </View>
      </ReanimatedSwipeable>
    </Animated.View>
  )
}

// An answer cached before Doing was retired may still say 'doing': it reads as to do.
const STATUS_COLOR: Record<LinkedListTodo['status'], string> = { todo: colors.muted, done: colors.green }
const STATUS_WORD: Record<LinkedListTodo['status'], string> = { todo: 'to do', done: 'done' }

/** The tasks linked to this list, as chips: Link first (always in sight), then each task: tap to open it, × to unlink. */
function LinkedTasks({ list, available, onLink, onUnlink }: {
  list: TotemList
  available: { id: string; title: string }[]
  onLink: (todoId: string) => void
  onUnlink: (todo: LinkedListTodo) => void
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
      <MenuView
        title="Link a task"
        themeVariant="dark"
        actions={available.length
          ? available.map((todo) => ({ id: todo.id, title: todo.title }))
          : [{ id: '', title: 'No open tasks to link', attributes: { disabled: true } }]}
        onPressAction={({ nativeEvent }) => { if (nativeEvent.event) onLink(nativeEvent.event) }}
      >
        <View style={[st.chip, st.addChip]} accessibilityRole="button" accessibilityLabel="Link a task">
          <Hi icon={LinkIcon} size={14} color={colors.muted} />
          <T size={14} muted>{list.linkedTodos.length ? 'Link' : 'Link a task'}</T>
        </View>
      </MenuView>
      {list.linkedTodos.map((todo) => (
        <View key={todo.id} style={st.chip}>
          <Press
            onPress={() => router.push({ pathname: '/todo/[id]', params: { id: todo.id } })}
            style={st.chipOpen}
            accessibilityRole="button"
            accessibilityLabel={`Task: ${todo.title}, ${STATUS_WORD[todo.status] ?? STATUS_WORD.todo}`}
          >
            <View style={[st.dot, { backgroundColor: STATUS_COLOR[todo.status] ?? STATUS_COLOR.todo }]} />
            <T size={14} numberOfLines={1} color={todo.status === 'done' ? colors.muted : colors.text} style={[{ maxWidth: 200 }, todo.status === 'done' ? st.struck : null]}>{todo.title}</T>
          </Press>
          <IconBtn icon={XMarkIcon} size={13} box={44} color={colors.muted} label={`Unlink ${todo.title}`} onPress={() => onUnlink(todo)} />
        </View>
      ))}
    </ScrollView>
  )
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  bar: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44, paddingRight: 8 },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  head: { gap: 10, paddingBottom: 10 },
  title: { marginHorizontal: 16, paddingVertical: 2, color: colors.text, fontSize: 28, lineHeight: 34, fontFamily: fonts[700], marginBottom: -4 },
  chip: {
    flexDirection: 'row', alignItems: 'center', minHeight: 44, borderRadius: 22, paddingLeft: 14,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
  },
  chipOpen: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44 },
  addChip: { gap: 6, paddingRight: 14, borderStyle: 'dashed', backgroundColor: 'transparent' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  allDone: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  item: { minHeight: 52, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg, paddingRight: 16 },
  checkHit: { width: 56, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  textHit: {
    flex: 1, minHeight: 52, justifyContent: 'center', paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line,
  },
  editInput: {
    flex: 1, minHeight: 52, paddingVertical: 12, color: colors.text, fontSize: 16, fontFamily: fonts[400],
    borderBottomWidth: 1, borderBottomColor: colors.accent,
  },
  struck: { textDecorationLine: 'line-through' },
  group: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 16, marginTop: 12 },
  removeAction: { width: 92, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: colors.red },
  empty: { paddingVertical: 48, paddingHorizontal: 24 },
  gone: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  composer: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, paddingHorizontal: 12,
    backgroundColor: colors.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line,
  },
  addField: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12,
    borderRadius: 22, backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
  },
  addInput: { flex: 1, minHeight: 44, color: colors.text, fontSize: 16, fontFamily: fonts[400], paddingVertical: 10 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
})
