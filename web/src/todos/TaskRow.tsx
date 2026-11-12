// One ~40 px line of the Tasks list: a check circle, the title, and right-aligned
// marks drawn only when they say something (AGENTS.md: mobile's styling, desktop's
// value in the pane and the keyboard, not busier rows). A task sheet row
// has no check circle: it is read-only, opened in the sheet.
import React from 'react'
import {
  Hi, ArrowTopRightOnSquareIcon, CalendarDaysIcon, ChatBubbleLeftIcon, CheckIcon, LinkIcon, MinusIcon,
} from '../icons'
import ChatAbout from '../chat/about/ChatAbout'
import { todoContext } from '../chat/about/context'
import { SHEET_PRIORITY_WORD, sheetAsTaskPriority, wakeLabel, type SectionKey } from './board'
import { dateLabel, dueText } from './format'
import { priorityLabel, type IssueState, type SheetItem, type Todo, type VentureTagConfig } from './types'
import { FlagSolidIcon, IssueClosedIcon, IssueOpenIcon, RepeatIcon, SheetIcon, SnoozeIcon } from './taskIcons'

/** Where a row is drawn: a due group, the snoozed fold, or Completed. */
export type RowPlace = SectionKey | 'snoozed' | 'completed'

/** The due words a row needs, given the group it is in: none where the heading already says it. */
export function dueMark(dueDate: string | null, place: RowPlace, now: Date): { text: string; tone: 'overdue' | 'upcoming' } | null {
  if (!dueDate || place === 'today' || place === 'nodate' || place === 'completed') return null
  if (place === 'overdue') return { text: dateLabel(dueDate), tone: 'overdue' }
  const text = dueText(dueDate, now)
  return { text, tone: text.startsWith('Overdue') ? 'overdue' : 'upcoming' }
}

const REPEAT_WORD: Record<string, string> = { daily: 'every day', weekdays: 'every weekday', weekly: 'every week', monthly: 'every month', yearly: 'every year' }
export const repeatWords = (recurrence: string) => REPEAT_WORD[recurrence] ?? recurrence

export const issueKey = (link: NonNullable<Todo['issueLink']>) => `${link.repo}#${link.number}`

/**
 * A sheet row's flag class: the colour of the task priority it ranks with
 * (board.ts sheetAsTaskPriority: High amber as P2, Medium blue as P3), except Low,
 * which is muted so it reads under Medium. Nothing on the sheet is P1 Urgent red.
 */
export function sheetFlagTone(priority: 1 | 2 | 3): string {
  return priority === 3 ? 'tk-prio-low' : `tk-prio-${5 - sheetAsTaskPriority(priority)}`
}

interface RowCommon {
  active: boolean
  open: boolean
  now: Date
  rowRef?: (el: HTMLDivElement | null) => void
  onFocusRow: () => void
  onOpen: () => void
  flash?: boolean
}

export function CheckCircle({ checked, notDoing, label, onToggle }: { checked: boolean; notDoing?: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      tabIndex={-1}
      className={`tk-check${checked ? ' on' : ''}${notDoing ? ' not-doing' : ''}`}
      onClick={(event) => { event.stopPropagation(); onToggle() }}
    >
      <Hi icon={notDoing ? MinusIcon : CheckIcon} size={12} className="tk-check-mark" />
    </button>
  )
}

export function TaskRow({
  todo, place, ticking, issue, ventureTags, selectMode, selected, onToggle, onSelect, onTools,
  active, open, now, rowRef, onFocusRow, onOpen, flash,
}: RowCommon & {
  todo: Todo
  place: RowPlace
  ticking: boolean
  issue?: IssueState
  ventureTags: VentureTagConfig[]
  selectMode: boolean
  selected: boolean
  onToggle: () => void
  onSelect: () => void
  /** A hover tool was pressed: open that menu against it. */
  onTools: (menu: 'snooze' | 'due', anchor: HTMLElement) => void
}) {
  const done = todo.status === 'done'
  const checked = done || ticking
  const notDoing = done && todo.outcome === 'not_doing'
  const due = dueMark(todo.dueDate, place, now)
  const prio = todo.priority > 1 ? priorityLabel(todo.priority) : null
  const venture = todo.area === 'Ventures' && todo.ventureTag ? todo.ventureTag : null
  const ventureColor = venture ? ventureTags.find((tag) => tag.name === venture)?.color ?? null : null
  const link = todo.issueLink
  const back = place === 'snoozed' && todo.snoozedUntil ? wakeLabel(new Date(todo.snoozedUntil), now) : null
  const spoken = [todo.title, due?.text, prio, venture, todo.recurrence ? `repeats ${repeatWords(todo.recurrence)}` : null, back ? `back ${back}` : null].filter(Boolean).join(', ')

  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={selectMode ? selected : open}
      aria-label={spoken}
      tabIndex={active ? 0 : -1}
      data-row={todo.id}
      className={`tk-row${active ? ' active' : ''}${open ? ' open' : ''}${checked ? ' checked' : ''}${ticking ? ' ticking' : ''}${flash ? ' flash' : ''}${selected ? ' selected' : ''}`}
      onFocus={(event) => { if (event.target === event.currentTarget) onFocusRow() }}
      onClick={() => (selectMode ? onSelect() : onOpen())}
    >
      <span role="gridcell" className="tk-lead">
        {selectMode
          ? <input type="checkbox" tabIndex={-1} className="tk-select" checked={selected} aria-label={`Select ${todo.title}`} onClick={(event) => event.stopPropagation()} onChange={onSelect} />
          : <CheckCircle checked={checked} notDoing={notDoing} label={done ? `Reopen ${todo.title}` : `Complete ${todo.title}`} onToggle={onToggle} />}
      </span>
      <span role="gridcell" className="tk-title">
        <span className="tk-title-text">{todo.title}</span>
        {notDoing && <span className="tk-quiet"> · not doing</span>}
      </span>
      <span role="gridcell" className="tk-marks">
        {back && <span className="tk-mark"><Hi icon={SnoozeIcon} size={13} />{back}</span>}
        {due && <span className={`tk-mark tk-due ${due.tone}`}>{due.text}</span>}
        {prio && <span className={`tk-mark tk-prio tk-prio-${prio.slice(1)}`} title={`${prio} priority`}><Hi icon={FlagSolidIcon} size={12} />{prio}</span>}
        {venture && <span className="tk-mark tk-venture" style={ventureColor ? { '--tag': ventureColor } as React.CSSProperties : undefined}><i aria-hidden="true" />{venture}</span>}
        {todo.recurrence && <span className="tk-mark" title={`Repeats ${repeatWords(todo.recurrence)}`}><Hi icon={RepeatIcon} size={13} /><span className="sr-only">Repeats</span></span>}
        {todo.notes.length > 0 && <span className="tk-mark" title={`${todo.notes.length} note${todo.notes.length === 1 ? '' : 's'}`}><Hi icon={ChatBubbleLeftIcon} size={12} />{todo.notes.length}</span>}
        {link && (
          <a
            className={`tk-mark tk-issue ${issue?.state ?? 'unknown'}`}
            href={link.url} target="_blank" rel="noreferrer" tabIndex={-1}
            title={issue ? `${issueKey(link)} · ${issue.state === 'open' ? 'Open' : 'Closed'} · ${issue.title}` : issueKey(link)}
            onClick={(event) => event.stopPropagation()}
          >
            <Hi icon={issue?.state === 'closed' ? IssueClosedIcon : issue?.state === 'open' ? IssueOpenIcon : LinkIcon} size={13} />#{link.number}
          </a>
        )}
      </span>
      {!done && !selectMode && (
        <span className="tk-tools" role="gridcell">
          <button type="button" tabIndex={-1} aria-label={`Snooze ${todo.title}`} title="Snooze (s)" onClick={(event) => { event.stopPropagation(); onTools('snooze', event.currentTarget) }}><Hi icon={SnoozeIcon} size={15} /></button>
          <button type="button" tabIndex={-1} aria-label={`Due date for ${todo.title}`} title="Due date (d)" onClick={(event) => { event.stopPropagation(); onTools('due', event.currentTarget) }}><Hi icon={CalendarDaysIcon} size={15} /></button>
        </span>
      )}
      <ChatAbout of={() => todoContext(todo)} host=".tk-row" />
    </div>
  )
}

export function SheetRow({ item, place, source, active, open, now, rowRef, onFocusRow, onOpen, selectMode }: RowCommon & {
  item: SheetItem
  place: RowPlace
  /** The feed's name for itself (say "Partner HQ"), else "Task sheet". */
  source: string
  selectMode: boolean
}) {
  const due = dueMark(item.dueDate, place, now)
  const prio = item.priority ? SHEET_PRIORITY_WORD[item.priority] : null
  const prioTone = item.priority ? sheetFlagTone(item.priority) : ''
  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={selectMode ? false : open}
      aria-label={[item.title, source, due?.text, prio ? `${prio} priority` : null].filter(Boolean).join(', ')}
      tabIndex={active ? 0 : -1}
      data-row={item.id}
      className={`tk-row tk-sheet-row${active ? ' active' : ''}${open ? ' open' : ''}${selectMode ? ' inert' : ''}`}
      onFocus={(event) => { if (event.target === event.currentTarget) onFocusRow() }}
      onClick={() => { if (!selectMode) onOpen() }}
    >
      <span role="gridcell" className="tk-lead" title={`${source} (read-only)`}><Hi icon={SheetIcon} size={16} className="tk-sheet-glyph" /></span>
      <span role="gridcell" className="tk-title"><span className="tk-title-text">{item.title}</span></span>
      <span role="gridcell" className="tk-marks">
        {due && <span className={`tk-mark tk-due ${due.tone}`}>{due.text}</span>}
        {prio && <span className={`tk-mark tk-prio ${prioTone}`} title={`${prio} priority`}><Hi icon={FlagSolidIcon} size={12} />{prio}</span>}
      </span>
      {!selectMode && (
        <span className="tk-tools" role="gridcell">
          <a href={item.url} target="_blank" rel="noreferrer" tabIndex={-1} aria-label={`Open ${item.title} in the sheet`} title="Open in sheet (o)" onClick={(event) => event.stopPropagation()}><Hi icon={ArrowTopRightOnSquareIcon} size={15} /></a>
        </span>
      )}
    </div>
  )
}
