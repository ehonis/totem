// The three menus a task row, a shortcut (s, d, p) and the detail pane share, so a
// task is snoozed, rescheduled or reprioritised the same way from every door.
import React, { useState } from 'react'
import { Hi, ArrowUturnLeftIcon, CalendarDaysIcon, FlagIcon, SunIcon } from '../icons'
import Menu, { type MenuEntry } from './Menu'
import { dueDateChoices, localDateTimeKey, snoozeTimes } from './format'
import { wakeLabel } from './board'
import { priorityLabel, type Todo } from './types'

interface Common { anchor: HTMLElement | null; onClose: () => void; now: Date }

export function SnoozeMenu({ todo, anchor, onClose, now, onSnooze, onWake }: Common & {
  todo: Todo
  onSnooze: (until: Date) => void
  onWake: () => void
}) {
  const [custom, setCustom] = useState('')
  const at = custom ? new Date(custom) : null
  const valid = at && !Number.isNaN(at.getTime()) && at > now
  const snoozed = Boolean(todo.snoozedUntil && new Date(todo.snoozedUntil) > now)
  const items: MenuEntry[] = [
    { heading: snoozed ? `Snoozed until ${wakeLabel(new Date(todo.snoozedUntil!), now)}` : 'Snooze until' },
    ...snoozeTimes(now, todo.dueDate).map((option) => ({
      key: option.label, label: option.label, detail: option.detail, onSelect: () => onSnooze(option.value),
    })),
    ...(snoozed ? ['separator' as const, { key: 'wake', label: 'Wake now', icon: SunIcon, onSelect: onWake }] : []),
  ]
  return (
    <Menu
      anchor={anchor} label={`Snooze ${todo.title}`} onClose={onClose} items={items}
      footer={(
        <form className="tk-menu-custom" onSubmit={(event) => { event.preventDefault(); if (valid) { onSnooze(at!); onClose() } }}>
          <label htmlFor={`tk-snooze-${todo.id}`}>Pick a time</label>
          <input id={`tk-snooze-${todo.id}`} type="datetime-local" min={localDateTimeKey(now)} value={custom} onChange={(event) => setCustom(event.target.value)} />
          <button type="submit" className="btn compact" disabled={!valid}>Snooze</button>
        </form>
      )}
    />
  )
}

export function DueMenu({ dueDate, title, idKey, anchor, onClose, now, onDue }: Common & {
  dueDate: string | null
  title: string
  idKey: string
  onDue: (dueDate: string | null) => void
}) {
  const [custom, setCustom] = useState(dueDate ?? '')
  const items: MenuEntry[] = [
    { heading: 'Due date' },
    ...dueDateChoices(now).map((option) => ({
      key: option.label, label: option.label, detail: option.detail, checked: dueDate === option.key, onSelect: () => onDue(option.key),
    })),
    ...(dueDate ? ['separator' as const, { key: 'clear', label: 'Remove due date', icon: ArrowUturnLeftIcon, onSelect: () => onDue(null) }] : []),
  ]
  return (
    <Menu
      anchor={anchor} label={`Due date for ${title}`} onClose={onClose} items={items}
      footer={(
        <form className="tk-menu-custom" onSubmit={(event) => { event.preventDefault(); if (custom) { onDue(custom); onClose() } }}>
          <label htmlFor={`tk-due-${idKey}`}><Hi icon={CalendarDaysIcon} size={13} /> Pick a date</label>
          <input id={`tk-due-${idKey}`} type="date" value={custom} onChange={(event) => setCustom(event.target.value)} />
          <button type="submit" className="btn compact" disabled={!custom || custom === dueDate}>Set</button>
        </form>
      )}
    />
  )
}

/** P1 (stored 4) first; "No priority" is P4. */
export const PRIORITIES: readonly Todo['priority'][] = [4, 3, 2, 1]
export const priorityName = (priority: Todo['priority']) => (priority === 1 ? 'No priority' : priorityLabel(priority))

export function PriorityMenu({ priority, title, anchor, onClose, onPriority }: Omit<Common, 'now'> & {
  priority: Todo['priority']
  title: string
  onPriority: (priority: Todo['priority']) => void
}) {
  return (
    <Menu
      anchor={anchor} label={`Priority for ${title}`} onClose={onClose} width={220}
      items={[
        { heading: 'Priority' },
        ...PRIORITIES.map((value) => ({
          key: String(value), label: priorityName(value), icon: FlagIcon, iconClass: `tk-prio-${5 - value}`,
          checked: priority === value, onSelect: () => onPriority(value),
        })),
      ]}
    />
  )
}
