// Productivity → Tasks (web/src/components/TodosView.tsx + todos/TodoBoard.tsx), led
// by the phone rather than copied from the web's phone width (#176): one list that
// answers "what now?". A task is open or done. Open tasks and the shared task sheet's
// rows sit in one set of groups (Overdue, Today, Upcoming, No date), in the shared
// order (lib/todos/board.ts buildList: due day, priority, tasks before sheet rows,
// then manual position), and Completed is one folded row (features/todos/list.ts). A
// status line says what is left today, what is done today, and how many are snoozed.
// Ticking, snoozing, "not doing" and deleting offer Undo in one inline line at the
// foot of the page, never a toast: the phone shows error toasts only. The task
// detail, a sheet row's read-only detail, the composer and the lifecycle panels are
// sheets (src/app/todo/*); the top bar carries the title.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, StyleSheet, View } from 'react-native'
import Animated, { LinearTransition, useReducedMotion } from 'react-native-reanimated'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact } from '../../ui/haptics'
import { Hi, PlusIcon } from '../../lib/icons'
import { bulkBoardTodos } from '../../lib/api'
import { filterTodos } from '../../lib/todos/state'
import type { Todo } from '../../lib/todos/types'
import { loadVentureTags } from '../../lib/todos/ventureTags'
import { FAB_CLEARANCE } from '../../shell/Screen'
import TodoCard from '../todos/TodoCard'
import SheetCard from '../todos/SheetCard'
import TodoToolbar, { type LifecyclePanel } from '../todos/TodoToolbar'
import { boardActions } from '../todos/boardActions'
import { afterDone, byWake, doneToday, nextWake, wakeLabel } from '../todos/board'
import {
  isFiltering, issueKey, issueLinkOf, leftToday, listRows, nextDue, orderNeighbours, sheetName, sheetNote, sheetOnlyEmpty, taskQuery, visibleSheet,
  type ListQuery, type Row,
} from '../todos/list'
import { quote, undoText, type UndoKind } from '../todos/undo'
import { ArchiveLink, BoardSkeleton, ClearNote, EmptyBoard, LoadError, SectionHeader, SheetLine, ShowMore, StatusLine } from '../todos/BoardParts'
import { UndoLine, type UndoState } from '../todos/detail/bits'
import { clearCreated, getBoard, loadBoard, loadIssueStates, loadSheet, setTodos, useBoard } from '../todos/store'
import { openTodo } from '../todos/nav'
import { dateLabel } from '../todos/format'
import { LandFlash, useLandOn } from '../../ui/landing'
import { farIndex } from '../../lib/landing'

// The "+" sits one gap left of the new-chat button (right 16, 54 wide: shell/Screen.tsx).
const NEW_TASK_SIZE = 44
const NEW_TASK_RIGHT = 16 + 54 + 12
// FAB_CLEARANCE clears the new-chat button; a card's "…" sits at the right edge, under the voice button stacked above it.
const LIST_FOOT = FAB_CLEARANCE + 48
// How long a just-added task wears its accent edge.
const FRESH_MS = 1800

// Whether Completed is open: this phone's choice, kept across launches.
const VIEW_KEY = 'totem.todos.boardView'
interface BoardView { completedOpen: boolean }
function readView(): BoardView {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') as Partial<BoardView> | null
    return { completedOpen: saved?.completedOpen === true }
  } catch { return { completedOpen: false } }
}
function writeView(view: BoardView) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)) } catch { /* a convenience; the list works without it */ }
}

export default function TodosView({ active }: { active: boolean }) {
  const board = useBoard()
  const insets = useSafeAreaInsets()
  const reduced = useReducedMotion()
  const [query, setQuery] = useState<ListQuery>({})
  const [view, setView] = useState<BoardView>(readView)
  const [bulkMode, setBulkMode] = useState(false)
  const [selection, setSelection] = useState(new Set<string>())
  const [showAllDone, setShowAllDone] = useState(false)
  const [moveError, setMoveError] = useState('')
  const [pulling, setPulling] = useState(false)
  const [undo, setUndo] = useState<UndoState | null>(null)
  const clearUndo = useCallback(() => setUndo(null), [])
  const [freshId, setFreshId] = useState<string | null>(null)
  // The clock the sections are cut by; ticks each minute so "Today" turns over at midnight.
  const [now, setNow] = useState(() => new Date())
  const actions = useMemo(() => boardActions(setMoveError), [])
  const wasActive = useRef(false)
  const list = useRef<Animated.FlatList<Row>>(null)

  useEffect(() => { writeView(view) }, [view])

  // Load the first time the page is shown, and again whenever it comes back into view.
  useEffect(() => {
    if (active && !wasActive.current) {
      void loadBoard(); void loadSheet(); void loadVentureTags().catch(() => {}); setNow(new Date())
    }
    wasActive.current = active
  }, [active])
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      const at = new Date()
      setNow(at)
      // A snooze that ran out while the page was open: the bridge lists that task on the board again.
      if (getBoard().snoozed.some((todo) => todo.snoozedUntil && new Date(todo.snoozedUntil) <= at)) void loadBoard()
    }, 60_000)
    return () => clearInterval(timer)
  }, [active])

  // Linked issues' live state, read only when some task links one, and again when the set changes.
  const linked = useMemo(() => board.todos.map((todo) => issueLinkOf(todo)).filter(Boolean).map((link) => issueKey(link!)).sort().join(' '), [board.todos])
  useEffect(() => { if (active && linked) void loadIssueStates() }, [active, linked])

  const sheet = board.sheet
  const sheetItems = useMemo(() => sheet?.items ?? [], [sheet])
  const source = sheetName(sheet)
  const filtering = isFiltering(query)
  const visible = useMemo(() => {
    const tasks = taskQuery(query)
    return tasks ? filterTodos(board.todos, tasks, now) : []
  }, [board.todos, query, now])
  const visibleRows = useMemo(() => visibleSheet(sheetItems, query, now), [sheetItems, query, now])
  const rows = useMemo(() => listRows(visible, visibleRows, {
    now, completedOpen: view.completedOpen, showAllDone, archiveCount: board.archiveCount, filtered: filtering,
  }), [visible, visibleRows, now, view.completedOpen, showAllDone, board.archiveCount, filtering])
  const near = useMemo(() => orderNeighbours(rows), [rows])
  const finishedToday = useMemo(() => doneToday(board.todos, now) + doneToday(board.archivedCompletions, now), [board.todos, board.archivedCompletions, now])
  const left = useMemo(() => leftToday(board.todos, sheetItems, now), [board.todos, sheetItems, now])
  const wakeAt = useMemo(() => nextWake(board.snoozed, now), [board.snoozed, now])
  const wakeText = wakeAt ? wakeLabel(wakeAt, now) : null
  const note = sheetNote(sheet, board.sheetError)

  // A new task lands in its group, often out of sight: scroll to it and mark it for a
  // moment, so creating one visibly worked.
  const createdId = board.createdId
  useEffect(() => {
    if (!createdId) return
    const index = rows.findIndex((row) => row.kind === 'card' && row.todo.id === createdId)
    // Filtered out or snoozed: nothing to bring into view, and a later filter change should not scroll.
    if (index < 0) { clearCreated(); return }
    const timer = setTimeout(() => {
      setFreshId(createdId)
      if (index === rows.length - 1) list.current?.scrollToEnd({ animated: !reduced })
      else list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: !reduced })
      clearCreated()
    }, 350)
    return () => clearTimeout(timer)
  }, [createdId, rows, reduced])
  useEffect(() => {
    if (!freshId) return
    const timer = setTimeout(() => setFreshId(null), FRESH_MS + 400)
    return () => clearTimeout(timer)
  }, [freshId])

  // A search hit (src/lib/landing.ts): bring its task into the list (no filter, the
  // Completed fold open), scroll to it and flash it. A snoozed or archived task is not
  // in the list, so that landing gives up quietly.
  const scrollFailed = useRef(false)
  const landed = useLandOn('task', {
    ready: active && board.loaded,
    prepare: ({ id }) => {
      const todo = getBoard().todos.find((item) => item.id === id)
      if (!todo) return
      if (filtering && !visible.some((item) => item.id === id)) setQuery({})
      if (todo.status === 'done') { setView((current) => ({ ...current, completedOpen: true })); setShowAllDone(true) }
    },
    locate: ({ id }) => {
      const index = rows.findIndex((row) => row.kind === 'card' && row.todo.id === id)
      if (index < 0) return null
      // A row not drawn yet fails the scroll (onScrollToIndexFailed scrolls on); the next try lands.
      scrollFailed.current = false
      list.current?.scrollToIndex({ index, viewPosition: 0.4, animated: !reduced && !farIndex(0, index, 10) })
      return scrollFailed.current ? null : id
    },
  })

  /** Say what happened in the Undo line; its Undo runs `back`. A newer line replaces it. */
  function offer(kind: UndoKind, todo: Todo, back: () => unknown, extra?: Parameters<typeof undoText>[2]) {
    const line = undoText(kind, todo, extra)
    setUndo({ id: Date.now(), text: line.text, action: line.undoable ? { label: 'Undo', run: () => { impact(); void back() } } : undefined })
  }

  // Finishing offers Undo, through the same move back, except for a repeating task
  // that rolled its next occurrence (afterDone says why), which names the next due
  // date instead and reopens from Completed as before. Reopening is one tap on the
  // circle either way, so it has no Undo of its own.
  async function move(todo: Todo, status: 'todo' | 'done') {
    const before = getBoard().todos.find((item) => item.id === todo.id) ?? todo
    // Already there (a swipe and a tick landing together): nothing to send, nothing to undo.
    if ((before.status === 'done') === (status === 'done')) return
    const ids = new Set(getBoard().todos.map((item) => item.id))
    if (!(await actions.move(todo, status)) || status !== 'done') return
    offer('done', todo, () => actions.putBack(before), { followUp: afterDone(before, ids, getBoard().todos) })
  }
  async function snooze(todo: Todo, until: string) {
    if (!(await actions.snooze(todo, until))) return
    offer('snooze', todo, () => actions.wake(todo), { until: wakeLabel(new Date(until), new Date()) })
  }
  async function notDoing(todo: Todo) {
    const before = getBoard().todos.find((item) => item.id === todo.id) ?? todo
    if (!(await actions.notDoing(todo))) return
    offer('notDoing', todo, () => actions.putBack(before))
  }
  async function remove(todo: Todo) {
    if (!(await actions.remove(todo))) return
    offer('delete', todo, () => actions.restore(todo))
  }

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

  const openPanel = (panel: LifecyclePanel) => router.push({ pathname: '/todo/lifecycle', params: { panel } })
  const clearFilters = () => setQuery({})
  const toggleCompleted = () => { setView((current) => ({ ...current, completedOpen: !current.completedOpen })); setShowAllDone(false) }
  const refresh = async () => {
    setPulling(true)
    await Promise.all([loadBoard(), loadSheet({ refresh: true }), linked ? loadIssueStates() : null])
    setNow(new Date()); setPulling(false)
  }

  const fabBottom = Math.max(insets.bottom, 14) + 8 + 5
  const error = board.error
  const todos = board.todos
  const snoozedNote = board.snoozed.length
    ? `${board.snoozed.length.toLocaleString()} snoozed${wakeText ? `, the next back ${wakeText}` : ''}.`
    : null
  const upcoming = useMemo(() => {
    const ahead = byWake(board.snoozed)[0]
    if (!ahead) return null
    return `Next back: ${quote(ahead.title)}${wakeText ? `, ${wakeText}` : ''}.`
  }, [board.snoozed, wakeText])

  // The first date ahead, for "nothing due today"; the tasks themselves are the cards under the line.
  const nextUp = useMemo(() => {
    const due = nextDue(rows)
    return due ? `Next due ${dateLabel(due)}.` : null
  }, [rows])

  function renderRow({ item: row }: { item: Row }) {
    if (row.kind === 'header') {
      return <SectionHeader title={row.title} count={row.count} tone={row.tone} collapsible={row.collapsible} open={row.open} onToggle={toggleCompleted} />
    }
    if (row.kind === 'clear') return <ClearNote scope={row.scope} doneToday={finishedToday} next={row.scope === 'all' ? upcoming : nextUp} />
    if (row.kind === 'more') return <ShowMore count={row.count} onPress={() => setShowAllDone(true)} />
    if (row.kind === 'archive') return <ArchiveLink count={row.count} onPress={() => openPanel('archive')} />
    if (row.kind === 'sheet') return <SheetCard item={row.item} source={source} now={now} dueSection={row.section} dim={bulkMode} />
    const todo = row.todo
    const pair = row.section !== 'done' ? near.get(todo.id) : undefined
    const up = pair?.up ?? null
    const down = pair?.down ?? null
    const link = issueLinkOf(todo)
    return (
      <View>
        <TodoCard
          todo={todo}
          now={() => now}
          swipeable={!bulkMode}
          onOpen={(item) => openTodo(item)}
          onAddNote={(item) => openTodo(item, 'notes')}
          onMove={(item, status) => move(item, status === 'done' ? 'done' : 'todo')}
          onReorder={(item, direction) => void actions.reorder(item, direction, direction < 0 ? up : down)}
          reorder={{ up: !!up, down: !!down, note: row.section === 'done' ? 'Completed reads newest first' : 'Due date and priority set this order' }}
          onSnooze={snooze}
          onDueDate={actions.reschedule}
          onNotDoing={notDoing}
          onPriority={actions.setPriority}
          onDelete={remove}
          dueSection={row.section === 'overdue' || row.section === 'today' ? row.section : undefined}
          issue={link ? board.issueStates[issueKey(link)] ?? null : null}
          fresh={freshId === todo.id}
          selected={bulkMode ? selection.has(todo.id) : undefined}
          onSelect={bulkMode ? select : undefined}
        />
        <LandFlash on={landed === todo.id} />
      </View>
    )
  }

  let body: React.ReactNode
  if (!board.loaded && !todos.length && !error) {
    body = <BoardSkeleton />
  } else if (error && !todos.length && !board.loaded) {
    body = <LoadError message={error} onRetry={() => void loadBoard()} />
  } else {
    body = (
      <Animated.FlatList
        ref={list}
        data={rows}
        style={{ flex: 1 }}
        itemLayoutAnimation={reduced ? undefined : LinearTransition.duration(220)}
        onScrollToIndexFailed={() => { scrollFailed.current = true; list.current?.scrollToEnd({ animated: !reduced }) }}
        keyExtractor={(row) => row.key}
        extraData={{ selection, freshId, landed, issues: board.issueStates, source }}
        contentContainerStyle={[st.list, { paddingBottom: LIST_FOOT + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={() => void refresh()} />}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        ListHeaderComponent={(
          <>
            <StatusLine ready={board.loaded} leftToday={left} doneToday={finishedToday} snoozed={board.snoozed.length} nextWake={wakeText} onSnoozed={() => openPanel('snoozed')} />
            {note?.tone === 'problem' ? <SheetLine tone="problem" text={note.text} onRetry={() => void loadSheet({ refresh: true })} /> : null}
          </>
        )}
        ListFooterComponent={note?.tone === 'quiet' && rows.length ? <SheetLine tone="quiet" text={note.text} onRetry={() => void loadSheet({ refresh: true })} /> : null}
        ListEmptyComponent={(
          <EmptyBoard
            kind={todos.length || sheetItems.length || filtering ? 'filtered' : 'nothing'}
            snoozedNote={filtering ? null : snoozedNote}
            onClear={clearFilters}
            sheetOnly={query.scope === 'sheet' ? sheetOnlyEmpty(source, sheet?.configured ?? null, board.sheetError) : undefined}
          />
        )}
        renderItem={renderRow}
      />
    )
  }

  return (
    <View style={st.view}>
      <TodoToolbar
        query={query} sheet={{ name: source, configured: sheet ? sheet.configured : null }} bulkMode={bulkMode} selectedCount={selection.size}
        lifecycle={{ snoozed: board.snoozed.length, nextWake: wakeText, deleted: board.deleted.length, archived: board.archiveCount }}
        onQuery={setQuery}
        onBulkMode={(value) => { setBulkMode(value); if (!value) setSelection(new Set()) }}
        onBulk={(operation, value) => void bulk(operation, value)}
        onLifecycle={openPanel}
      />
      {moveError ? (
        <Press onPress={() => setMoveError('')} style={st.compactError} accessibilityRole="alert" accessibilityHint="Dismisses the message">
          <T size={12.5} color="#ff9caf" style={{ flex: 1 }}>{moveError}</T>
        </Press>
      ) : error && (todos.length > 0 || board.loaded) ? (
        <Press onPress={() => void loadBoard()} style={st.compactError} accessibilityRole="alert" accessibilityHint="Tries again">
          <T size={12.5} color="#ff9caf" style={{ flex: 1 }}>{`Tasks could not refresh: ${error}`}</T>
          <T size={12.5} weight={600} color="#ff9caf">Try again</T>
        </Press>
      ) : null}
      {body}
      {/* Undo, inline at the thumb, beside the floating buttons rather than under them. */}
      {undo ? (
        <View style={[st.undo, { bottom: fabBottom }]} pointerEvents="box-none">
          <UndoLine undo={undo} onDone={clearUndo} />
        </View>
      ) : null}
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

const st = StyleSheet.create({
  view: { flex: 1, paddingTop: 8, paddingHorizontal: 12 },
  compactError: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginBottom: 6, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: '#f0506e55', borderRadius: 10, backgroundColor: '#f0506e0f' },
  list: { paddingTop: 2 },
  undo: {
    position: 'absolute', left: 12, right: NEW_TASK_RIGHT + NEW_TASK_SIZE + 8, zIndex: 45,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
  },
  newTask: {
    position: 'absolute', right: NEW_TASK_RIGHT, width: NEW_TASK_SIZE, height: NEW_TASK_SIZE, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, zIndex: 44,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
  },
})
