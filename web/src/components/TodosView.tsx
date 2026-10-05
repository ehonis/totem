import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthError, bulkBoardTodos, deleteBoardTodo, getTodoBoard, getTodoPreferences, updateBoardTodo } from '../api'
import { Hi, ArrowPathIcon, PlusIcon, XMarkIcon } from '../icons'
import { COMMANDS } from '../shortcuts'
import TodoBoard from '../todos/TodoBoard'
import TodoComposer from '../todos/TodoComposer'
import TodoConnectors, { TodoTrackingLaunchers, type TodoTrackingSource } from '../todos/TodoConnectors'
import TodoDetailSheet from '../todos/TodoDetailSheet'
import TodoLifecyclePanels from '../todos/TodoLifecyclePanels'
import TodoToolbar from '../todos/TodoToolbar'
import { filterTodos, sortTodos } from '../todos/state'
import type { Todo, TodoPreferences, TodoQuery, TodoSort } from '../todos/types'
import { useCommand } from '../useShortcuts'

interface TodosViewProps { onAuthError: () => void }

export default function TodosView({ onAuthError }: TodosViewProps) {
  const [todos, setTodos] = useState<Todo[]>([])
  const [snoozed, setSnoozed] = useState<Todo[]>([])
  // The archive is counted on every load but only fetched when it is opened: it grows
  // without bound, and the board does not need 158 finished tasks to render.
  const [archive, setArchive] = useState<Todo[] | null>(null)
  const [archiveCount, setArchiveCount] = useState(0)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [deleted, setDeleted] = useState<Todo[]>([])
  const [preferences, setPreferences] = useState<TodoPreferences>({ autoArchiveDays: null, autoArchiveAt: null, recyclePurgeDays: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [composer, setComposer] = useState(false)
  const [detail, setDetail] = useState<Todo | null>(null)
  const [detailFocus, setDetailFocus] = useState<'details' | 'notes'>('details')
  const [query, setQuery] = useState<TodoQuery>({})
  const [sort, setSort] = useState<TodoSort[]>(['manual'])
  const [groupBySource, setGroupBySource] = useState(false)
  const [bulkMode, setBulkMode] = useState(false)
  const [selection, setSelection] = useState(new Set<string>())
  const [trackingSource, setTrackingSource] = useState<TodoTrackingSource | null>(null)
  useCommand(COMMANDS.todoNew, () => setComposer(true))

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [active, sleeping, recycle, archived, prefs] = await Promise.all([
        getTodoBoard({ snoozed: false }), getTodoBoard({ snoozed: true }),
        getTodoBoard({ deleted: true }), getTodoBoard({ archived: true }), getTodoPreferences(),
      ])
      setTodos(active.todos); setSnoozed(sleeping.todos); setDeleted(recycle.todos)
      setArchiveCount(archived.todos.length)
      setArchive(current => current && archived.todos)
      setPreferences(prefs.preferences)
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'Tasks could not load.')
    } finally { setLoading(false) }
  }, [onAuthError])

  useEffect(() => { void load() }, [load])
  const visible = useMemo(() => sortTodos(filterTodos(todos, query), sort), [todos, query, sort])

  function accept(next: Todo) {
    setTodos(current => current.map(item => item.id === next.id ? next : item))
    setDetail(next)
  }

  function openDetail(todo: Todo, focus: 'details' | 'notes' = 'details') {
    setDetailFocus(focus)
    setDetail(todo)
  }

  async function bulk(operation: string, value?: unknown) {
    if (!selection.size) return
    const chosen = todos.filter(todo => selection.has(todo.id))
    if (operation === 'archive' && chosen.some(todo => todo.status !== 'done')) {
      setError('Only completed tasks can be archived.'); return
    }
    setError('')
    try {
      const result = await bulkBoardTodos([...selection], operation, value)
      const returned = new Map(result.todos.map(todo => [todo.id, todo]))
      setTodos(current => current.map(todo => returned.get(todo.id) ?? todo).filter(todo => !todo.deletedAt && !todo.archivedAt && !todo.snoozedUntil))
      setSelection(new Set())
      await load()
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'No tasks were changed.')
    }
  }

  async function snooze(id: string, until: string) {
    const original = todos.find(todo => todo.id === id)
    setTodos(current => current.filter(todo => todo.id !== id))
    try {
      const { todo } = await updateBoardTodo(id, { snoozedUntil: until })
      setSnoozed(current => [todo, ...current.filter(item => item.id !== id)])
      if (detail?.id === id) setDetail(null)
      return todo
    } catch (cause) {
      if (original) setTodos(current => current.some(todo => todo.id === id) ? current : [...current, original])
      throw cause
    }
  }

  async function showArchive(open: boolean) {
    if (!open || archive) return
    setArchiveLoading(true); setArchiveError(null)
    try {
      const { todos: archived } = await getTodoBoard({ archived: true })
      setArchive(archived); setArchiveCount(archived.length)
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setArchiveError(cause instanceof Error ? cause.message : 'The archive could not load.')
    } finally { setArchiveLoading(false) }
  }

  async function remove(id: string) {
    const original = todos.find(todo => todo.id === id)
    setTodos(current => current.filter(todo => todo.id !== id))
    try {
      const { todo } = await deleteBoardTodo(id)
      setDeleted(current => [todo, ...current.filter(item => item.id !== id)])
      if (detail?.id === id) setDetail(null)
      return todo
    } catch (cause) {
      if (original) setTodos(current => current.some(todo => todo.id === id) ? current : [...current, original])
      throw cause
    }
  }

  return (
    <div className="view todo-board-view">
      <div className="view-head">
        <div><h1>Todos</h1><p className="todo-view-subtitle">Private by default. Share only when a task belongs in GitHub or Action Items.</p></div>
        <div className="todo-head-actions"><TodoTrackingLaunchers source={trackingSource} onSelect={setTrackingSource} /><button className="btn compact" onClick={load} title="Refresh tasks" aria-label="Refresh tasks"><Hi icon={ArrowPathIcon} size={15} /></button><button className="btn primary compact todo-new-task" onClick={() => setComposer(true)}><Hi icon={PlusIcon} size={16} /> <span className="todo-new-label">New task</span></button></div>
      </div>
      <TodoToolbar query={query} sort={sort} groupBySource={groupBySource} bulkMode={bulkMode} selectedCount={selection.size} onQuery={setQuery} onSort={setSort} onGroupBySource={setGroupBySource} onBulkMode={value => { setBulkMode(value); if (!value) setSelection(new Set()) }} onBulk={(operation, value) => void bulk(operation, value)} />
      {trackingSource && <TodoConnectors source={trackingSource} onChanged={load} onClose={() => setTrackingSource(null)} onViewSource={source => { setQuery(current => ({ ...current, source })); setTrackingSource(null) }} />}
      <TodoBoard todos={visible} loading={loading} error={error} onRetry={load} onChange={next => { const changed = new Map(next.map(todo => [todo.id, todo])); setTodos(current => current.map(todo => changed.get(todo.id) ?? todo)) }} onOpen={todo => openDetail(todo)} onAddNote={todo => openDetail(todo, 'notes')} onSnooze={snooze} onDelete={remove} groupBySource={groupBySource}
        archive={archive ?? undefined} archiveCount={archiveCount} archiveLoading={archiveLoading}
        archiveError={archiveError} archiveHour={preferences.autoArchiveAt}
        onShowArchive={open => void showArchive(open)} selection={bulkMode ? selection : undefined} onSelectionChange={bulkMode ? setSelection : undefined} />
      <div className="todo-board-footer"><TodoLifecyclePanels snoozed={snoozed} deleted={deleted} preferences={preferences} onChanged={load} /></div>
      {detail && <TodoDetailSheet todo={detail} allTodos={todos} initialFocus={detailFocus} onClose={() => setDetail(null)} onSaved={accept} />}
      {composer && <div className="modal-backdrop" onMouseDown={() => setComposer(false)}><div className="event-modal todo-composer-sheet" onMouseDown={event => event.stopPropagation()}><div className="modal-head"><div><div className="modal-kicker">Private by default</div><h2>New task</h2></div><button className="icon-btn" onClick={() => setComposer(false)} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button></div><TodoComposer onCancel={() => setComposer(false)} onCreated={todo => { setTodos(current => [todo, ...current]); setComposer(false) }} /></div></div>}
    </div>
  )
}
