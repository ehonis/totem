import React, { useEffect, useMemo, useState } from 'react'
import { ApiError, deleteBoardTodo, moveBoardTodo, reorderBoardTodos, updateBoardTodo } from '../api'
import { Hi, ArchiveBoxIcon, ClockIcon } from '../icons'
import TodoCard from './TodoCard'
import { groupArchive, type ArchivePeriod } from './archive'
import { groupBoard, optimisticMove, rollbackMove } from './state'
import { todoSource, type Todo, type TodoSource, type TodoStatus } from './types'

const ARCHIVE_PERIODS: readonly { value: ArchivePeriod; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
]

/** "18:00" as the clock reads it where you are. */
function archiveHourLabel(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  const at = new Date()
  at.setHours(hours, minutes, 0, 0)
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
}

const LABEL: Record<TodoStatus, string> = { todo: 'To Do', doing: 'Doing', done: 'Done' }
const SOURCE_LABEL: Record<TodoSource, string> = { local: 'Private', github: 'GitHub', sheet: 'Sheet' }

interface TodoBoardProps {
  initialTodos?: Todo[]
  todos?: Todo[]
  viewport?: 'desktop' | 'mobile'
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onOpen?: (todo: Todo) => void
  onAddNote?: (todo: Todo) => void
  onChange?: (todos: Todo[]) => void
  onMove?: (id: string, status: TodoStatus) => Promise<Todo | void>
  onSnooze?: (id: string, until: string) => Promise<Todo | void>
  onNotDoing?: (id: string) => Promise<Todo | void>
  /** Archived tasks, fetched only once the archive is opened. */
  archive?: Todo[]
  archiveCount?: number
  archiveLoading?: boolean
  archiveError?: string | null
  archiveHour?: string | null
  onShowArchive?: (open: boolean) => void
  onDueDate?: (id: string, dueDate: string | null) => Promise<Todo | void>
  onPriority?: (id: string, priority: Todo['priority']) => Promise<Todo | void>
  onDelete?: (id: string) => Promise<Todo | void>
  now?: () => Date
  groupBySource?: boolean
  selection?: Set<string>
  onSelectionChange?: (selection: Set<string>) => void
}

const systemMobile = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 720px)').matches)

export default function TodoBoard({
  initialTodos = [], todos: controlled, viewport, loading, error, onRetry, onOpen,
  onAddNote, onChange, onMove, onSnooze, onDueDate, onNotDoing, onPriority, onDelete, now, groupBySource = false, selection, onSelectionChange,
  archive, archiveCount = 0, archiveLoading = false, archiveError = null, archiveHour = null, onShowArchive,
}: TodoBoardProps) {
  const [localTodos, setLocalTodos] = useState(initialTodos)
  const [mobileStatus, setMobileStatus] = useState<TodoStatus>('todo')
  const [moveError, setMoveError] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [showAllDone, setShowAllDone] = useState(false)
  const [autoMobile, setAutoMobile] = useState(systemMobile)
  // Off by default: the archive is where finished work goes to stop being in the way.
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archivePeriod, setArchivePeriod] = useState<ArchivePeriod>('day')
  const todos = controlled ?? localTodos
  useEffect(() => { if (controlled === undefined) setLocalTodos(initialTodos) }, [controlled, initialTodos])
  useEffect(() => {
    if (viewport || !window.matchMedia) return
    const media = window.matchMedia('(max-width: 720px)')
    const update = () => setAutoMobile(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [viewport])
  const isMobile = viewport ? viewport === 'mobile' : autoMobile
  const groups = useMemo(() => groupBoard(todos), [todos])
  const replace = (next: Todo[]) => { if (controlled === undefined) setLocalTodos(next); onChange?.(next) }

  async function move(todo: Todo, status: TodoStatus) {
    const optimistic = optimisticMove(todos, todo.id, status, groups[status].length)
    replace(optimistic.todos); setMoveError('')
    try {
      const saved = await (onMove ? onMove(todo.id, status) : moveBoardTodo(todo.id, status).then(result => result.todo))
      if (saved) replace(optimistic.todos.map(item => item.id === saved.id ? saved : item))
    } catch (cause) {
      replace(rollbackMove(optimistic.todos, optimistic.rollback))
      setMoveError(cause instanceof ApiError && cause.code === 'SOURCE_OWNS_COMPLETION'
        ? cause.message
        : cause instanceof Error ? cause.message : 'Task could not be moved.')
    }
  }

  async function reorder(todo: Todo, direction: -1 | 1) {
    const items = groups[todo.status]
    const from = items.findIndex(item => item.id === todo.id)
    const to = Math.max(0, Math.min(items.length - 1, from + direction))
    if (from === to) return
    const ordered = [...items]
    ordered.splice(to, 0, ordered.splice(from, 1)[0])
    const positions = new Map(ordered.map((item, index) => [item.id, index * 1024]))
    const next = todos.map(item => positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item)
    replace(next)
    try { await reorderBoardTodos(todo.status, ordered.map(item => item.id)) }
    catch (cause) { replace(todos); setMoveError(cause instanceof Error ? cause.message : 'Order could not be saved.') }
  }

  async function snooze(todo: Todo, until: string) {
    const previous = todos
    replace(todos.filter(item => item.id !== todo.id)); setMoveError('')
    try {
      await (onSnooze ? onSnooze(todo.id, until) : updateBoardTodo(todo.id, { snoozedUntil: until }).then(result => result.todo))
    } catch (cause) {
      replace(previous)
      setMoveError(cause instanceof Error ? cause.message : 'Snooze could not be saved.')
    }
  }

  // Rescheduling keeps the card in place, unlike snooze: the task is still on the
  // board, it is just answerable later.
  async function reschedule(todo: Todo, dueDate: string | null) {
    const previous = todos
    const optimistic = todos.map(item => item.id === todo.id ? { ...item, dueDate } : item)
    replace(optimistic); setMoveError('')
    try {
      const saved = await (onDueDate ? onDueDate(todo.id, dueDate) : updateBoardTodo(todo.id, { dueDate }).then(result => result.todo))
      if (saved) replace(optimistic.map(item => item.id === saved.id ? saved : item))
    } catch (cause) {
      replace(previous)
      setMoveError(cause instanceof Error ? cause.message : 'Due date could not be saved.')
    }
  }

  // Not doing is a completion, not a deletion: the task leaves the board the same way
  // a finished one does, and says which of the two it was once it lands.
  async function notDoing(todo: Todo) {
    const previous = todos
    const optimistic = optimisticMove(todos, todo.id, 'done', groups.done.length)
    replace(optimistic.todos.map(item => item.id === todo.id ? { ...item, outcome: 'not_doing' as const } : item))
    setMoveError('')
    try {
      const saved = await (onNotDoing ? onNotDoing(todo.id) : moveBoardTodo(todo.id, 'done', 'not_doing').then(result => result.todo))
      if (saved) replace(optimistic.todos.map(item => item.id === saved.id ? saved : item))
    } catch (cause) {
      replace(previous)
      setMoveError(cause instanceof ApiError && cause.code === 'SOURCE_OWNS_COMPLETION'
        ? cause.message
        : cause instanceof Error ? cause.message : 'Task could not be marked as not doing.')
    }
  }

  async function setPriority(todo: Todo, priority: Todo['priority']) {
    const previous = todos
    const optimistic = todos.map(item => item.id === todo.id ? { ...item, priority } : item)
    replace(optimistic); setMoveError('')
    try {
      const saved = await (onPriority ? onPriority(todo.id, priority) : updateBoardTodo(todo.id, { priority }).then(result => result.todo))
      if (saved) replace(optimistic.map(item => item.id === saved.id ? saved : item))
    } catch (cause) {
      replace(previous)
      setMoveError(cause instanceof Error ? cause.message : 'Priority could not be saved.')
    }
  }

  async function remove(todo: Todo) {
    const previous = todos
    replace(todos.filter(item => item.id !== todo.id)); setMoveError('')
    try {
      await (onDelete ? onDelete(todo.id) : deleteBoardTodo(todo.id).then(result => result.todo))
    } catch (cause) {
      replace(previous)
      setMoveError(cause instanceof Error ? cause.message : 'Task could not be moved to the recycle bin.')
    }
  }

  function cards(items: Todo[], status: TodoStatus) {
    const visible = status === 'done' && !showAllDone ? items.slice(0, 12) : items
    return <>
      {visible.map(todo => (
        <TodoCard
          key={todo.id} todo={todo} draggable onDragStart={() => setDragId(todo.id)}
          onOpen={onOpen} onAddNote={onAddNote} onMove={move} onReorder={reorder} onSnooze={snooze} onDueDate={reschedule}
          onNotDoing={notDoing} onPriority={setPriority} onDelete={remove} now={now}
          testId={status === 'done' ? 'done-card' : undefined}
          selected={selection?.has(todo.id)}
          onSelect={selection && onSelectionChange ? (item, selected) => {
            const next = new Set(selection)
            if (selected) next.add(item.id); else next.delete(item.id)
            onSelectionChange(next)
          } : undefined}
        />
      ))}
      {status === 'done' && !showAllDone && items.length > 12 && (
        <button className="todo-show-more" onClick={() => setShowAllDone(true)}>Show {(items.length - 12).toLocaleString()} more</button>
      )}
    </>
  }

  function column(status: TodoStatus) {
    const items = groups[status]
    return (
      <section
        key={status} className={`todo-board-column status-${status}`} role="region" aria-label={LABEL[status]}
        onDragOver={event => event.preventDefault()}
        onDrop={() => {
          const dragged = todos.find(todo => todo.id === dragId)
          if (dragged && dragged.status !== status) void move(dragged, status)
          setDragId(null)
        }}
      >
        <header>
          <h2>{LABEL[status]}</h2>
          {status === 'done' && archiveHour && (
            <span className="todo-archive-hour" title={`Completed tasks are archived at ${archiveHourLabel(archiveHour)}`}>
              <Hi icon={ClockIcon} size={12} />{archiveHourLabel(archiveHour)}
            </span>
          )}
          {status === 'done' && onShowArchive && archiveCount > 0 && (
            <button
              type="button"
              className={`todo-archive-toggle${archiveOpen ? ' on' : ''}`}
              aria-pressed={archiveOpen}
              onClick={() => { const next = !archiveOpen; setArchiveOpen(next); onShowArchive(next) }}
            >
              <Hi icon={ArchiveBoxIcon} size={13} />{archiveCount.toLocaleString()} archived
            </button>
          )}
          <span>{items.length.toLocaleString()}</span>
        </header>
        <div className="todo-board-list">
          {groupBySource ? (['local', 'github', 'sheet'] as TodoSource[]).map(source => {
            const sourced = items.filter(todo => todoSource(todo) === source)
            return sourced.length ? <div className="todo-source-group" role="group" aria-label={SOURCE_LABEL[source]} key={source}><h3>{SOURCE_LABEL[source]}</h3>{cards(sourced, status)}</div> : null
          }) : cards(items, status)}
          {!items.length && !(status === 'done' && archiveOpen) && <div className="todo-column-empty">No tasks here.</div>}
          {status === 'done' && archiveOpen && archiveSection()}
        </div>
      </section>
    )
  }

  function archiveSection() {
    if (archiveError) return <div className="todo-board-error compact" role="alert">{archiveError}</div>
    if (archiveLoading && !archive) return <div className="todo-column-empty">Loading the archive…</div>
    const groups = groupArchive(archive ?? [], archivePeriod, now ? now() : new Date())
    return (
      <div className="todo-archive">
        <div className="todo-archive-periods" role="group" aria-label="Group the archive by">
          {ARCHIVE_PERIODS.map(option => (
            <button
              key={option.value}
              type="button"
              aria-pressed={archivePeriod === option.value}
              className={archivePeriod === option.value ? 'on' : ''}
              onClick={() => setArchivePeriod(option.value)}
            >{option.label}</button>
          ))}
        </div>
        {groups.length === 0 && <div className="todo-column-empty">Nothing archived yet.</div>}
        {groups.map(group => (
          <section className="todo-archive-group" key={group.key} aria-label={group.label}>
            <h3>{group.label}<span>{group.todos.length.toLocaleString()}</span></h3>
            {group.todos.map(todo => (
              <TodoCard key={todo.id} todo={todo} onOpen={onOpen} now={now} />
            ))}
          </section>
        ))}
      </div>
    )
  }

  if (loading && !todos.length) return <div className="todo-board-skeleton" aria-label="Loading tasks"><i /><i /><i /></div>
  if (error && !todos.length) return <div className="todo-board-error" role="alert"><strong>Tasks could not load.</strong><span>{error}</span>{onRetry && <button className="btn" onClick={onRetry}>Try again</button>}</div>
  return (
    <div className="todo-board-shell">
      {(moveError || (error && todos.length > 0)) && <div className="todo-board-error compact" role="alert">{moveError || error}</div>}
      {isMobile && <div className="todo-mobile-status" role="tablist" aria-label="Task status">{(['todo', 'doing', 'done'] as TodoStatus[]).map(status => <button key={status} type="button" role="tab" aria-selected={mobileStatus === status} className={mobileStatus === status ? 'active' : ''} onClick={() => setMobileStatus(status)}>{LABEL[status]} <span>{groups[status].length}</span></button>)}</div>}
      <div className={isMobile ? 'todo-board mobile' : 'todo-board'}>{isMobile ? column(mobileStatus) : (['todo', 'doing', 'done'] as TodoStatus[]).map(column)}</div>
    </div>
  )
}
