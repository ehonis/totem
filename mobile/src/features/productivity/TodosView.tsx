// Productivity → Todos (web/src/components/TodosView.tsx + todos/TodoBoard.tsx at
// phone width): the To Do / Doing / Done switch over one column of cards, the
// lifecycle chips underneath, and the blue "+" beside the chat buttons. The task
// detail, the composer and the lifecycle panels are sheets (src/app/todo/*).
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { impact } from '../../ui/haptics'
import { Hi, ArrowPathIcon, PlusIcon } from '../../lib/icons'
import { bulkBoardTodos } from '../../lib/api'
import { filterTodos, sortTodos } from '../../lib/todos/state'
import { todoSource, type Todo, type TodoQuery, type TodoSort, type TodoSource, type TodoStatus } from '../../lib/todos/types'
import { loadVentureTags } from '../../lib/todos/ventureTags'
import TodoCard from '../todos/TodoCard'
import TodoToolbar from '../todos/TodoToolbar'
import { boardActions } from '../todos/boardActions'
import { STATUS_LABEL } from '../todos/format'
import { clearCreated, getBoard, loadBoard, setTodos, useBoard } from '../todos/store'
import { openTodo } from '../todos/nav'

// The "+" sits one gap left of the new-chat button (right 16, 54 wide: shell/Screen.tsx).
const NEW_TASK_SIZE = 44
const NEW_TASK_RIGHT = 16 + 54 + 12

const SOURCE_GROUP_LABEL: Record<TodoSource, string> = { local: 'Private', github: 'GitHub', sheet: 'Sheet' }
const STATUSES: TodoStatus[] = ['todo', 'doing', 'done']

type Row =
  | { kind: 'card'; todo: Todo }
  | { kind: 'group'; key: string; label: string }
  | { kind: 'more'; count: number }

export default function TodosView({ active }: { active: boolean }) {
  const board = useBoard()
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState<TodoQuery>({})
  const [sort, setSort] = useState<TodoSort[]>(['manual'])
  const [groupBySource, setGroupBySource] = useState(false)
  const [bulkMode, setBulkMode] = useState(false)
  const [selection, setSelection] = useState(new Set<string>())
  const [status, setStatus] = useState<TodoStatus>('todo')
  const [showAllDone, setShowAllDone] = useState(false)
  const [moveError, setMoveError] = useState('')
  const [pulling, setPulling] = useState(false)
  const actions = useMemo(() => boardActions(setMoveError), [])
  const wasActive = useRef(false)
  const list = useRef<FlatList<Row>>(null)

  // Load the first time the page is shown, and again whenever it comes back into view.
  useEffect(() => {
    if (active && !wasActive.current) { void loadBoard(); void loadVentureTags().catch(() => {}) }
    wasActive.current = active
  }, [active])

  // Any other order is a view over the column, so the board keeps the order the
  // toolbar asks for rather than regrouping by position.
  const visible = useMemo(() => sortTodos(filterTodos(board.todos, query), sort), [board.todos, query, sort])
  const groups = useMemo(() => {
    const out = { todo: [] as Todo[], doing: [] as Todo[], done: [] as Todo[] }
    for (const todo of visible) out[todo.status]?.push(todo)
    return out
  }, [visible])
  const items = groups[status]

  const rows = useMemo<Row[]>(() => {
    const cards = (list: Todo[]): Row[] => {
      const shown = status === 'done' && !showAllDone ? list.slice(0, 12) : list
      const out: Row[] = shown.map((todo) => ({ kind: 'card', todo }))
      if (status === 'done' && !showAllDone && list.length > 12) out.push({ kind: 'more', count: list.length - 12 })
      return out
    }
    if (!groupBySource) return cards(items)
    return (['local', 'github', 'sheet'] as TodoSource[]).flatMap((source): Row[] => {
      const sourced = items.filter((todo) => todoSource(todo) === source)
      return sourced.length ? [{ kind: 'group', key: source, label: SOURCE_GROUP_LABEL[source] }, ...cards(sourced)] : []
    })
  }, [items, status, showAllDone, groupBySource])

  // A new task lands at the foot of To Do (manual order is oldest first), usually out
  // of sight: show that column and scroll to it, so creating one visibly worked.
  const createdId = board.createdId
  useEffect(() => { if (createdId) setStatus('todo') }, [createdId])
  useEffect(() => {
    if (!createdId || status !== 'todo') return
    const index = rows.findIndex((row) => row.kind === 'card' && row.todo.id === createdId)
    if (index < 0) return
    const timer = setTimeout(() => {
      if (index === rows.length - 1) list.current?.scrollToEnd({ animated: true })
      else list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true })
      clearCreated()
    }, 350)
    return () => clearTimeout(timer)
  }, [createdId, rows, status])

  async function bulk(operation: string, value?: unknown) {
    if (!selection.size) return
    const chosen = getBoard().todos.filter((todo) => selection.has(todo.id))
    if (operation === 'archive' && chosen.some((todo) => todo.status !== 'done')) {
      setMoveError('Only completed tasks can be archived.'); return
    }
    setMoveError('')
    try {
      const result = await bulkBoardTodos([...selection], operation, value)
      const returned = new Map(result.todos.map((todo) => [todo.id, todo]))
      setTodos((current) => current.map((todo) => returned.get(todo.id) ?? todo).filter((todo) => !todo.deletedAt && !todo.archivedAt && !todo.snoozedUntil))
      setSelection(new Set())
      await loadBoard()
    } catch (cause) {
      setMoveError(cause instanceof Error ? cause.message : 'No tasks were changed.')
    }
  }

  const select = (todo: Todo, selected: boolean) => setSelection((current) => {
    const next = new Set(current)
    if (selected) next.add(todo.id); else next.delete(todo.id)
    return next
  })

  const fabBottom = Math.max(insets.bottom, 14) + 8 + 5
  const error = board.error
  const todos = board.todos

  let body: React.ReactNode
  if (board.loading && !todos.length && !board.loaded) {
    body = <View style={[st.column, st.skeleton]} accessibilityLabel="Loading tasks"><ActivityIndicator color={colors.muted} /></View>
  } else if (error && !todos.length) {
    body = (
      <View style={st.boardError} accessibilityRole="alert">
        <T weight={600} color="#ff9caf">Tasks could not load.</T>
        <T muted size={13}>{error}</T>
        <Btn title="Try again" compact onPress={() => void loadBoard()} style={{ alignSelf: 'flex-start' }} />
      </View>
    )
  } else {
    body = (
      <>
        <View style={st.status} accessibilityRole="tablist">
          {STATUSES.map((value) => {
            const on = status === value
            return (
              <Press key={value} haptic onPress={() => setStatus(value)} style={[st.statusBtn, on && { backgroundColor: colors.bg3 }]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
                <T size={14} color={on ? colors.text : colors.muted}>
                  {STATUS_LABEL[value]}
                  <T size={11} color={on ? colors.text : colors.muted}>{` ${groups[value].length}`}</T>
                </T>
              </Press>
            )
          })}
        </View>
        <View style={st.column}>
          <FlatList
            ref={list}
            data={rows}
            onScrollToIndexFailed={() => list.current?.scrollToEnd({ animated: true })}
            keyExtractor={(row) => (row.kind === 'card' ? row.todo.id : row.kind === 'group' ? `g-${row.key}` : 'more')}
            contentContainerStyle={st.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await loadBoard(); setPulling(false) }} />}
            ItemSeparatorComponent={() => <View style={{ height: 7 }} />}
            ListEmptyComponent={<T size={12} muted align="center" style={{ paddingVertical: 24 }}>No tasks here.</T>}
            renderItem={({ item: row }) => {
              if (row.kind === 'group') return <T size={11.5} weight={700} muted style={{ marginTop: 4 }}>{row.label}</T>
              if (row.kind === 'more') {
                return (
                  <Press haptic onPress={() => setShowAllDone(true)} style={st.more}>
                    <T size={13} muted>{`Show ${row.count.toLocaleString()} more`}</T>
                  </Press>
                )
              }
              return (
                <TodoCard
                  todo={row.todo}
                  swipeable={!bulkMode}
                  onOpen={(todo) => openTodo(todo)}
                  onAddNote={(todo) => openTodo(todo, 'notes')}
                  onMove={actions.move}
                  onReorder={actions.reorder}
                  onSnooze={actions.snooze}
                  onDueDate={actions.reschedule}
                  onNotDoing={actions.notDoing}
                  onPriority={actions.setPriority}
                  onDelete={actions.remove}
                  selected={bulkMode ? selection.has(row.todo.id) : undefined}
                  onSelect={bulkMode ? select : undefined}
                />
              )
            }}
          />
        </View>
      </>
    )
  }

  const snoozedCount = board.snoozed.length
  return (
    <View style={st.view}>
      <View style={st.head}>
        <T size={20} weight={700}>Todos</T>
        <Press haptic onPress={() => void loadBoard()} style={st.refresh} accessibilityLabel="Refresh tasks">
          {board.loading && board.loaded ? <ActivityIndicator size="small" color={colors.muted} /> : <Hi icon={ArrowPathIcon} size={15} color={colors.text} />}
        </Press>
      </View>
      <TodoToolbar
        query={query} sort={sort} groupBySource={groupBySource} bulkMode={bulkMode} selectedCount={selection.size}
        onQuery={setQuery} onSort={setSort} onGroupBySource={setGroupBySource}
        onBulkMode={(value) => { setBulkMode(value); if (!value) setSelection(new Set()) }}
        onBulk={(operation, value) => void bulk(operation, value)}
      />
      {moveError || (error && todos.length > 0) ? (
        <View style={st.compactError} accessibilityRole="alert"><T size={12} color="#ff9caf">{moveError || error}</T></View>
      ) : null}
      {body}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.footer} contentContainerStyle={[st.footerRow, { paddingBottom: fabBottom + 4 }]}>
        <FooterChip label={`${snoozedCount.toLocaleString()} snoozed task${snoozedCount === 1 ? '' : 's'}`} panel="snoozed" />
        <FooterChip label={`Recycle bin · ${board.deleted.length.toLocaleString()}`} panel="deleted" />
        {board.archiveCount > 0 ? <FooterChip label={`${board.archiveCount.toLocaleString()} archived`} panel="archive" /> : null}
        <FooterChip label="Retention" panel="retention" />
      </ScrollView>
      {/* New task sits beside the chat buttons, where a thumb already is (.todo-new-task). */}
      <Press
        accessibilityLabel="New task"
        onPress={() => { impact(); router.push('/todo/new') }}
        style={[st.newTask, { bottom: fabBottom }]}
      >
        <Hi icon={PlusIcon} size={20} color={colors.white} />
      </Press>
    </View>
  )
}

function FooterChip({ label, panel }: { label: string; panel: 'snoozed' | 'deleted' | 'archive' | 'retention' }) {
  return (
    <Press haptic onPress={() => router.push({ pathname: '/todo/lifecycle', params: { panel } })} style={st.footerChip}>
      <T size={12} muted>{label}</T>
    </Press>
  )
}

const st = StyleSheet.create({
  view: { flex: 1, paddingTop: 12, paddingHorizontal: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 },
  refresh: {
    minHeight: 32, minWidth: 36, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.bg3,
  },
  compactError: { marginBottom: 8, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: '#f0506e55', borderRadius: 8, backgroundColor: '#f0506e0f' },
  boardError: { gap: 8, padding: 12, borderWidth: 1, borderColor: '#f0506e55', borderRadius: 8, backgroundColor: '#f0506e0f' },
  status: { flexDirection: 'row', padding: 2, borderWidth: 1, borderColor: colors.line, borderRadius: 9, backgroundColor: colors.bg2, marginBottom: 10 },
  statusBtn: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  column: { flex: 1, minHeight: 0, borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: 'rgba(22, 25, 34, 0.74)', overflow: 'hidden' },
  skeleton: { alignItems: 'center', justifyContent: 'center' },
  // The chat buttons float over the column's foot, so the last card can scroll clear of them.
  list: { padding: 8, paddingBottom: 80 },
  more: { minHeight: 38, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, borderRadius: 7 },
  // The strip stops a clear gap short of the "+" and the new-chat button
  // (.todo-board-footer padding-right), so a chip scrolls out of view rather than under them.
  footer: { flexGrow: 0, marginTop: 7, marginLeft: -12, marginRight: NEW_TASK_RIGHT + NEW_TASK_SIZE + 14 - 12 },
  footerRow: { gap: 6, paddingLeft: 12, paddingRight: 8 },
  footerChip: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 7, backgroundColor: colors.bg2 },
  newTask: {
    position: 'absolute', right: NEW_TASK_RIGHT, width: NEW_TASK_SIZE, height: NEW_TASK_SIZE, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, zIndex: 44,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
  },
})
