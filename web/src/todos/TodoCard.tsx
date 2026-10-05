import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Hi, ArrowDownIcon, ArrowTopRightOnSquareIcon, ArrowUpIcon, ArrowUturnLeftIcon,
  ArrowsRightLeftIcon, CalendarDaysIcon, ClockIcon, EllipsisHorizontalIcon,
  FlagIcon, NoSymbolIcon, PencilSquareIcon, PlusIcon, TrashIcon,
} from '../icons'
import { useVentureTags, ventureTagStyle } from './ventureTags'
import { priorityLabel, priorityMarks, todoSource, type Todo, type TodoStatus } from './types'

const STATUS_LABEL: Record<TodoStatus, string> = { todo: 'To Do', doing: 'Doing', done: 'Done' }
const SOURCE_LABEL = { local: 'Private', github: 'GitHub', sheet: 'Sheet' } as const
type Menu = 'snooze' | 'due' | 'actions' | null
type ActionView = 'main' | 'move' | 'priority' | 'due'

function dateLabel(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day))
}

function timeLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value)
}

function dayTimeLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(value)
}

function dueDayLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(value)
}

// Nine in the morning on the due date: the last moment a snooze can end and still leave the day to work with.
function dueMorning(dueDate: string) {
  const [year, month, day] = dueDate.split('-').map(Number)
  return new Date(year, month - 1, day, 9, 0, 0, 0)
}

// A week of lead time when there is a week to spare, otherwise the largest shorter run-up that still lands in the future.
function leadDays(daysUntilDue: number) {
  if (daysUntilDue >= 8) return 7
  if (daysUntilDue >= 4) return 2
  if (daysUntilDue >= 2) return 1
  return 0
}

function dueTimes(now: Date, dueDate: string | null) {
  if (!dueDate) return []
  const due = dueMorning(dueDate)
  if (due <= now) return []
  const today = new Date(now)
  today.setHours(9, 0, 0, 0)
  const daysUntilDue = Math.round((due.getTime() - today.getTime()) / 86_400_000)
  const lead = leadDays(daysUntilDue)
  const options = []
  if (lead) {
    const runUp = new Date(due)
    runUp.setDate(runUp.getDate() - lead)
    const label = lead === 7 ? 'A week before it\u2019s due' : lead === 2 ? 'Two days before it\u2019s due' : 'The day before it\u2019s due'
    options.push({ label, detail: dueDayLabel(runUp), value: runUp })
  }
  options.push({ label: 'The day it\u2019s due', detail: dueDayLabel(due), value: due })
  return options
}

function snoozeTimes(now: Date, dueDate: string | null = null) {
  const minutes = new Date(now.getTime() + 20 * 60_000)
  const hour = new Date(now.getTime() + 60 * 60_000)
  const evening = new Date(now)
  evening.setHours(18, 0, 0, 0)
  if (evening <= now) evening.setDate(evening.getDate() + 1)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const nextMonday = new Date(now)
  const daysUntilMonday = (8 - nextMonday.getDay()) % 7 || 7
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday)
  nextMonday.setHours(9, 0, 0, 0)
  return [
    { label: 'In 20 minutes', detail: timeLabel(minutes), value: minutes },
    { label: 'In 1 hour', detail: timeLabel(hour), value: hour },
    { label: 'This evening', detail: timeLabel(evening), value: evening },
    { label: 'Tomorrow', detail: dayTimeLabel(tomorrow), value: tomorrow },
    { label: 'Next Monday', detail: dayTimeLabel(nextMonday), value: nextMonday },
    ...dueTimes(now, dueDate),
  ]
}

function dateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

// The quick reschedule set. A due date is a plain local calendar day, so these are day
// keys rather than instants — there is no time of day to preserve.
function dueDateChoices(now: Date) {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7))
  return [
    { label: 'Today', key: dateKey(now) },
    { label: 'Tomorrow', key: dateKey(tomorrow) },
    { label: 'Next week', key: dateKey(nextWeek) },
  ].map(option => ({ ...option, detail: dateLabel(option.key) }))
}

// A finished task has no due state left to report. Leaving the date red said the
// task was late at a moment when lateness had stopped being a fact about it.
function dueTone(value: string | null, now: Date, status: TodoStatus) {
  if (!value || status === 'done') return ''
  const key = dateKey(now)
  return value < key ? 'overdue' : value === key ? 'today' : 'upcoming'
}

interface TodoCardProps {
  todo: Todo
  onOpen?: (todo: Todo) => void
  onAddNote?: (todo: Todo) => void
  onMove?: (todo: Todo, status: TodoStatus) => void
  onReorder?: (todo: Todo, direction: -1 | 1) => void
  onSnooze?: (todo: Todo, until: string) => void
  onNotDoing?: (todo: Todo) => void
  onDueDate?: (todo: Todo, dueDate: string | null) => void
  onPriority?: (todo: Todo, priority: Todo['priority']) => void
  onDelete?: (todo: Todo) => void
  now?: () => Date
  draggable?: boolean
  onDragStart?: React.DragEventHandler<HTMLElement>
  testId?: string
  selected?: boolean
  onSelect?: (todo: Todo, selected: boolean) => void
}

export default function TodoCard({
  todo, onOpen, onAddNote, onMove, onReorder, onSnooze, onDueDate, onNotDoing, onPriority, onDelete, now = () => new Date(),
  draggable, onDragStart, testId, selected, onSelect,
}: TodoCardProps) {
  const source = todoSource(todo)
  const sourceLabel = SOURCE_LABEL[source]
  const link = todo.externalLinks[0]
  const latestNote = todo.notes.reduce<Todo['notes'][number] | null>((latest, item) => (
    !latest || item.createdAt > latest.createdAt || (item.createdAt === latest.createdAt && item.id > latest.id) ? item : latest
  ), null)
  const [menu, setMenu] = useState<Menu>(null)
  const [actionView, setActionView] = useState<ActionView>('main')
  const [custom, setCustom] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const [position, setPosition] = useState<React.CSSProperties>({ top: 0, left: 0 })
  const snoozeButton = useRef<HTMLButtonElement>(null)
  const dueButton = useRef<HTMLButtonElement>(null)
  const actionsButton = useRef<HTMLButtonElement>(null)
  const menuElement = useRef<HTMLDivElement>(null)

  function openMenu(next: Exclude<Menu, null>, button: HTMLButtonElement | null) {
    if (menu === next) { setMenu(null); return }
    const rect = button?.getBoundingClientRect()
    const width = 272
    if (rect) {
      const left = Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10))
      const openUp = window.innerHeight - rect.bottom < 330 && rect.top > window.innerHeight - rect.bottom
      setPosition(openUp ? { left, bottom: window.innerHeight - rect.top + 6 } : { left, top: rect.bottom + 6 })
    }
    setActionView('main')
    setCustom(false)
    setCustomValue('')
    setMenu(next)
  }

  function closeMenu() {
    setMenu(null)
    setActionView('main')
    setCustom(false)
  }

  useEffect(() => {
    if (!menu) return
    function keydown(event: KeyboardEvent) { if (event.key === 'Escape') closeMenu() }
    function pointerdown(event: PointerEvent) {
      const target = event.target as Node
      if (!menuElement.current?.contains(target) && !snoozeButton.current?.contains(target) && !dueButton.current?.contains(target) && !actionsButton.current?.contains(target)) closeMenu()
    }
    document.addEventListener('keydown', keydown)
    document.addEventListener('pointerdown', pointerdown)
    return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', pointerdown) }
  }, [menu])

  function chooseSnooze(value: Date) {
    onSnooze?.(todo, value.toISOString())
    closeMenu()
  }

  function chooseDueDate(value: string | null) {
    onDueDate?.(todo, value)
    closeMenu()
  }

  // One set of options behind both doors: the overdue shortcut on the card and the
  // Due date entry in the overflow menu reschedule a task the same way.
  const dueOptions = <>
    {dueDateChoices(now()).map(option => <button key={option.label} type="button" role="menuitem" disabled={todo.dueDate === option.key} onClick={() => chooseDueDate(option.key)}><span>{option.label}</span><time dateTime={option.key}>{option.detail}</time></button>)}
    <div className="todo-menu-separator" />
    <button type="button" onClick={() => setCustom(true)} aria-label="Pick a due date"><Hi icon={CalendarDaysIcon} size={17} /><span>Pick a due date</span></button>
    {todo.dueDate && <button type="button" role="menuitem" onClick={() => chooseDueDate(null)}><Hi icon={ArrowUturnLeftIcon} size={17} /><span>Remove due date</span></button>}
  </>

  const duePicker = <div className="todo-custom-snooze">
    <button className="todo-menu-back" type="button" onClick={() => setCustom(false)}><Hi icon={ArrowUturnLeftIcon} size={16} /> Back</button>
    <label htmlFor={`custom-due-${todo.id}`}>Custom due date</label>
    <input id={`custom-due-${todo.id}`} type="date" value={customValue} onChange={event => setCustomValue(event.target.value)} autoFocus />
    <button className="todo-menu-submit" type="button" disabled={!customValue} onClick={() => chooseDueDate(customValue)}>Set due date</button>
  </div>

  const tone = dueTone(todo.dueDate, now(), todo.status)
  const notDoing = todo.outcome === 'not_doing'
  const overdue = tone === 'overdue'
  const ventureTags = useVentureTags()
  const menuPortal = menu && typeof document !== 'undefined' ? createPortal(
    <div
      ref={menuElement}
      className="todo-card-menu"
      style={position}
      role="menu"
      aria-label={menu === 'snooze' ? `Snooze ${todo.title}` : menu === 'due' ? `Reschedule ${todo.title}` : `Actions for ${todo.title}`}
      onPointerDown={event => event.stopPropagation()}
    >
      {menu === 'snooze' && !custom && <>
        <div className="todo-menu-heading"><Hi icon={ClockIcon} size={16} /> Snooze until</div>
        {snoozeTimes(now(), todo.dueDate).map(option => <button key={option.label} type="button" role="menuitem" onClick={() => chooseSnooze(option.value)}><span>{option.label}</span><time dateTime={option.value.toISOString()}>{option.detail}</time></button>)}
        <div className="todo-menu-separator" />
        <button type="button" onClick={() => setCustom(true)} aria-label="Pick a date and time"><Hi icon={CalendarDaysIcon} size={17} /><span>Pick a date and time</span></button>
      </>}
      {menu === 'snooze' && custom && <div className="todo-custom-snooze">
        <button className="todo-menu-back" type="button" onClick={() => setCustom(false)}><Hi icon={ArrowUturnLeftIcon} size={16} /> Back</button>
        <label htmlFor={`custom-snooze-${todo.id}`}>Custom snooze time</label>
        <input id={`custom-snooze-${todo.id}`} type="datetime-local" value={customValue} onChange={event => setCustomValue(event.target.value)} autoFocus />
        <button className="todo-menu-submit" type="button" disabled={!customValue || Number.isNaN(new Date(customValue).getTime())} onClick={() => chooseSnooze(new Date(customValue))}>Snooze until selected time</button>
      </div>}
      {menu === 'due' && !custom && <>
        <div className="todo-menu-heading"><Hi icon={CalendarDaysIcon} size={16} /> Due date</div>
        {dueOptions}
      </>}
      {menu === 'due' && custom && duePicker}
      {menu === 'actions' && actionView === 'main' && <>
        <button type="button" role="menuitem" onClick={() => setActionView('move')}><Hi icon={ArrowsRightLeftIcon} size={17} /><span>Move…</span><span className="todo-menu-value">{STATUS_LABEL[todo.status]}</span></button>
        <button type="button" role="menuitem" onClick={() => setActionView('priority')}><Hi icon={FlagIcon} size={17} /><span>Priority…</span><span className={`todo-priority priority-${priorityLabel(todo.priority).toLowerCase()}`}>{priorityMarks(todo.priority) || priorityLabel(todo.priority)}</span></button>
        {onDueDate && <button type="button" role="menuitem" onClick={() => setActionView('due')}><Hi icon={CalendarDaysIcon} size={17} /><span>Due date…</span><span className="todo-menu-value">{todo.dueDate ? dateLabel(todo.dueDate) : 'None'}</span></button>}
        <div className="todo-menu-separator" />
        <button type="button" role="menuitem" onClick={() => { onReorder?.(todo, -1); closeMenu() }}><Hi icon={ArrowUpIcon} size={17} /><span>Move task up</span></button>
        <button type="button" role="menuitem" onClick={() => { onReorder?.(todo, 1); closeMenu() }}><Hi icon={ArrowDownIcon} size={17} /><span>Move task down</span></button>
        <div className="todo-menu-separator" />
        {onNotDoing && !notDoing && <button type="button" role="menuitem" onClick={() => { onNotDoing(todo); closeMenu() }}><Hi icon={NoSymbolIcon} size={17} /><span>Not doing this</span></button>}
        <button type="button" role="menuitem" onClick={() => { onOpen?.(todo); closeMenu() }}><Hi icon={PencilSquareIcon} size={17} /><span>Edit task</span></button>
        <button className="danger" type="button" role="menuitem" onClick={() => { onDelete?.(todo); closeMenu() }}><Hi icon={TrashIcon} size={17} /><span>Move task to recycle bin</span></button>
      </>}
      {menu === 'actions' && actionView === 'move' && <>
        <button className="todo-menu-back" type="button" onClick={() => setActionView('main')}><Hi icon={ArrowUturnLeftIcon} size={16} /> Move</button>
        {(['todo', 'doing', 'done'] as TodoStatus[]).map(status => <button key={status} type="button" role="menuitem" disabled={todo.status === status} onClick={() => { onMove?.(todo, status); closeMenu() }}><span className={`todo-status-dot status-${status}`} /><span>Move to {STATUS_LABEL[status]}</span></button>)}
      </>}
      {menu === 'actions' && actionView === 'priority' && <>
        <button className="todo-menu-back" type="button" onClick={() => setActionView('main')}><Hi icon={ArrowUturnLeftIcon} size={16} /> Priority</button>
        {([4, 3, 2, 1] as Todo['priority'][]).map(priority => <button key={priority} type="button" role="menuitem" disabled={todo.priority === priority} onClick={() => { onPriority?.(todo, priority); closeMenu() }}><Hi icon={FlagIcon} size={17} className={`priority-${priorityLabel(priority).toLowerCase()}`} /><span>Set priority to {priorityLabel(priority)}</span><span className="todo-menu-value" aria-hidden="true">{priorityMarks(priority)}</span></button>)}
      </>}
      {menu === 'actions' && actionView === 'due' && !custom && <>
        <button className="todo-menu-back" type="button" onClick={() => setActionView('main')}><Hi icon={ArrowUturnLeftIcon} size={16} /> Due date</button>
        {dueOptions}
      </>}
      {menu === 'actions' && actionView === 'due' && custom && duePicker}
    </div>, document.body,
  ) : null

  return (
    <article className={`todo-board-card status-${todo.status} source-${source} sync-${todo.syncState.status}${notDoing ? ' not-doing' : ''}`} draggable={draggable} onDragStart={onDragStart} data-testid={testId}>
      <div className="todo-card-source-row">
        {onSelect && <input className="todo-card-select" type="checkbox" aria-label={`Select ${todo.title}`} checked={selected} onChange={event => onSelect(todo, event.target.checked)} />}
        {link?.externalUrl ? <a className={`todo-source source-${source}`} href={link.externalUrl} target="_blank" rel="noreferrer">{sourceLabel}<Hi icon={ArrowTopRightOnSquareIcon} size={11} /></a> : <span className={`todo-source source-${source}`}>{sourceLabel}</span>}
        {notDoing && <span className="todo-outcome">Not doing</span>}
        {todo.syncState.status !== 'idle' && todo.syncState.status !== 'synced' && <span className={`todo-sync-state ${todo.syncState.status}`} title={todo.syncState.lastError || undefined}>{todo.syncState.status}</span>}
        <span className="todo-card-tools">
          {todo.status !== 'done' && onSnooze && <button ref={snoozeButton} type="button" aria-label={`Snooze ${todo.title}`} aria-haspopup="menu" aria-expanded={menu === 'snooze'} onPointerDown={event => event.stopPropagation()} onClick={() => openMenu('snooze', snoozeButton.current)}><Hi icon={ClockIcon} size={17} /></button>}
          {todo.status !== 'done' && onDueDate && overdue && <button ref={dueButton} type="button" className="todo-card-overdue" aria-label={`Reschedule ${todo.title}`} title="Overdue — move the due date" aria-haspopup="menu" aria-expanded={menu === 'due'} onPointerDown={event => event.stopPropagation()} onClick={() => openMenu('due', dueButton.current)}><Hi icon={CalendarDaysIcon} size={17} /></button>}
          <button ref={actionsButton} type="button" aria-label={`More actions for ${todo.title}`} aria-haspopup="menu" aria-expanded={menu === 'actions'} onPointerDown={event => event.stopPropagation()} onClick={() => openMenu('actions', actionsButton.current)}><Hi icon={EllipsisHorizontalIcon} size={19} /></button>
        </span>
      </div>
      <button className="todo-card-open" type="button" onClick={() => onOpen?.(todo)}>
        <span className="todo-card-title">{todo.title}</span>
        {todo.description && <span className="todo-card-description">{todo.description}</span>}
      </button>
      <div className="todo-card-meta">
        {priorityMarks(todo.priority) && (
          <span
            className={`todo-priority priority-${priorityLabel(todo.priority).toLowerCase()}`}
            title={`${priorityLabel(todo.priority)} priority`}
            aria-label={`${priorityLabel(todo.priority)} priority`}
          >{priorityMarks(todo.priority)}</span>
        )}
        <span className={`todo-area-tag ${todo.area === 'Ventures' ? 'venture' : 'venture-personal'}`} style={todo.area === 'Ventures' ? ventureTagStyle(todo.ventureTag, ventureTags) : undefined}>{todo.area === 'Ventures' ? todo.ventureTag : todo.area}</span>
        {todo.dueDate && <time className={`todo-due ${tone}`} dateTime={todo.dueDate}>{dateLabel(todo.dueDate)}</time>}
        {todo.recurrence && <span className="todo-meta-pill">Repeats</span>}
        {todo.tags.slice(0, 2).map(tag => <span className="todo-meta-pill" key={tag.id}>#{tag.name}</span>)}
      </div>
      {onAddNote && <button className="todo-card-add-note" type="button" onClick={() => onAddNote(todo)} aria-label={`Add a note to ${todo.title}`}><Hi icon={PlusIcon} size={13} /> Add a note</button>}
      {latestNote && <div className="todo-card-note"><p>{latestNote.body}</p><time dateTime={latestNote.createdAt}>{new Date(latestNote.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time></div>}
      {menuPortal}
    </article>
  )
}
