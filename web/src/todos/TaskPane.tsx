// The right-hand pane of the Tasks page. A selected task opens here with every
// field editable in place: nothing to save, each change goes to the bridge as it is
// made (put back with a toast if refused). A sheet row opens read-only. With
// nothing selected the pane is today's summary.
//
// The page mounts a task's pane with key={todo.id}, so drafts never carry from one
// task to the next.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Hi, ArchiveBoxIcon, ArrowPathIcon, ArrowTopRightOnSquareIcon, CalendarDaysIcon, ChatBubbleLeftRightIcon,
  ChevronDownIcon, ChevronLeftIcon, EllipsisHorizontalIcon, LinkIcon, NoSymbolIcon, PlusIcon, TrashIcon, XMarkIcon,
} from '../icons'
import { ApiError, getTodoBoard, unarchiveBoardTodo } from '../api'
import { startChatAbout } from '../chat/about/start'
import { todoContext } from '../chat/about/context'
import ChatAbout from '../chat/about/ChatAbout'
import { pushError } from '../toast'
import { sheetFeedLine } from '../components/sheetFeedLine'
import { groupArchive } from './archive'
import { SHEET_PRIORITY_WORD, sheetName, wakeLabel } from './board'
import { dateLabel, dueText } from './format'
import Menu from './Menu'
import { DueMenu, PRIORITIES, priorityName, SnoozeMenu } from './TaskMenus'
import { CheckCircle, issueKey, repeatWords } from './TaskRow'
import type { TaskBoard } from './useTaskBoard'
import type { IssueState, SheetFeed, SheetItem, Todo, VentureTagConfig } from './types'
import { IssueClosedIcon, IssueOpenIcon, RepeatIcon, SheetIcon, SnoozeIcon } from './taskIcons'

const REPEATS = ['', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'] as const

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** A textarea that grows with its text. */
function useGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value])
}

/**
 * A text field that saves when you leave it (or press Enter, for one-liners). It
 * follows the task while you are not typing in it, so a fresh read shows through.
 */
function useSavedText(value: string, save: (next: string) => Promise<unknown>) {
  const [draft, setDraft] = useState(value)
  // The draft as typed, read by the blur that follows Enter or Esc in the same tick,
  // before React has drawn it; and whether that blur should throw the edit away.
  const typed = useRef(value)
  const editing = useRef(false)
  const cancelled = useRef(false)
  useEffect(() => { if (!editing.current) { typed.current = value; setDraft(value) } }, [value])
  return {
    draft,
    bind: {
      value: draft,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { editing.current = true; typed.current = event.target.value; setDraft(event.target.value) },
      onFocus: () => { editing.current = true; cancelled.current = false },
      onBlur: () => {
        editing.current = false
        if (cancelled.current) { cancelled.current = false; return }
        if (typed.current !== value) void save(typed.current)
      },
    },
    /** Esc: back to the saved text, and the blur that follows saves nothing. */
    revert: () => { cancelled.current = true; editing.current = false; typed.current = value; setDraft(value) },
  }
}

function Row({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="tk-prop">
      {htmlFor ? <label className="tk-prop-label" htmlFor={htmlFor}>{label}</label> : <span className="tk-prop-label">{label}</span>}
      <div className="tk-prop-value">{children}</div>
    </div>
  )
}

export interface TaskDetailProps {
  todo: Todo
  board: TaskBoard
  now: Date
  issue?: IssueState
  ventureTags: VentureTagConfig[]
  /** Bumped to put the cursor in the note composer (m); each new value focuses it again. */
  focusNotes?: number
  onClose: () => void
  onOpenTask: (id: string) => void
}

export function TaskDetail({ todo, board, now, issue, ventureTags, focusNotes, onClose, onOpenTask }: TaskDetailProps) {
  const [menu, setMenu] = useState<null | { kind: 'due' | 'snooze' | 'more' | 'repeat' | 'venture' | 'relate'; anchor: HTMLElement }>(null)
  const [savedAt, setSavedAt] = useState(0)
  const done = todo.status === 'done'
  const ticking = board.ticking.has(todo.id)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  async function save(patch: Parameters<TaskBoard['update']>[1]) {
    const saved = await board.update(todo, patch)
    if (saved) setSavedAt(Date.now())
    return saved
  }

  const title = useSavedText(todo.title, async (next) => {
    const trimmed = next.trim()
    if (!trimmed) { title.revert(); return }
    await save({ title: trimmed })
  })
  const description = useSavedText(todo.description, (next) => save({ description: next }))
  useGrow(titleRef, title.draft)
  useGrow(descRef, description.draft)

  useEffect(() => { if (focusNotes) noteRef.current?.focus() }, [focusNotes])
  useEffect(() => {
    if (!savedAt) return
    const timer = setTimeout(() => setSavedAt(0), 1600)
    return () => clearTimeout(timer)
  }, [savedAt])

  const snoozed = Boolean(todo.snoozedUntil && new Date(todo.snoozedUntil) > now)
  const showVentures = ventureTags.length > 0 || todo.area === 'Ventures'
  const tagOptions = [...ventureTags.map((tag) => tag.name), ...(todo.ventureTag && !ventureTags.some((tag) => tag.name === todo.ventureTag) ? [todo.ventureTag] : [])]
  const [pickingVenture, setPickingVenture] = useState(false)

  return (
    <div className="tk-pane-body" aria-label={`Task: ${todo.title}`} role="region">
      <div className="tk-pane-bar">
        <CheckCircle checked={done || ticking} notDoing={done && todo.outcome === 'not_doing'} label={done ? `Reopen ${todo.title}` : `Complete ${todo.title}`} onToggle={() => void (done ? board.reopen(todo) : board.complete(todo))} />
        <span className="tk-pane-state">{done ? (todo.outcome === 'not_doing' ? 'Not doing' : `Done${todo.completedAt ? ` ${when(todo.completedAt)}` : ''}`) : ticking ? 'Done' : snoozed ? `Snoozed until ${wakeLabel(new Date(todo.snoozedUntil!), now)}` : 'Open'}</span>
        <span className={`tk-saved${savedAt ? ' on' : ''}`} role="status" aria-live="polite">{savedAt ? 'Saved' : ''}</span>
        <button type="button" className="tk-icon-btn" title="Chat about this task" aria-label="Chat about this task" onClick={() => void startChatAbout(todoContext(todo)).catch((cause) => pushError(cause))}><Hi icon={ChatBubbleLeftRightIcon} size={16} /></button>
        <button type="button" className="tk-icon-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu?.kind === 'more'} onClick={(event) => setMenu({ kind: 'more', anchor: event.currentTarget })}><Hi icon={EllipsisHorizontalIcon} size={17} /></button>
        <button type="button" className="tk-icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}><Hi icon={XMarkIcon} size={17} /></button>
      </div>

      <textarea
        ref={titleRef}
        className="tk-pane-title"
        aria-label="Title"
        rows={1}
        {...title.bind}
        onKeyDown={(event) => {
          // An IME's Enter picks a candidate; it must not end the edit.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); title.revert(); event.currentTarget.blur() }
        }}
      />
      <textarea
        ref={descRef}
        className="tk-pane-desc"
        aria-label="Description"
        placeholder="Add a description"
        rows={1}
        {...description.bind}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); description.revert(); event.currentTarget.blur() }
        }}
      />

      <div className="tk-props">
        <Row label="Due">
          <button type="button" className={`tk-prop-btn${todo.dueDate ? '' : ' is-empty'}`} aria-label={`Due date: ${todo.dueDate ? dueText(todo.dueDate, now, todo.status) : 'none'}`} aria-haspopup="menu" onClick={(event) => setMenu({ kind: 'due', anchor: event.currentTarget })}>
            <Hi icon={CalendarDaysIcon} size={14} />{todo.dueDate ? dueText(todo.dueDate, now, todo.status) : 'No date'}
          </button>
        </Row>
        <Row label="Priority">
          <div className="tk-seg" role="radiogroup" aria-label="Priority">
            {PRIORITIES.map((value) => (
              <button key={value} type="button" role="radio" aria-checked={todo.priority === value} className={`tk-seg-btn${todo.priority === value ? ' on' : ''} tk-prio-${5 - value}`} onClick={() => { if (todo.priority !== value) void save({ priority: value }) }}>
                {value === 1 ? 'None' : priorityName(value)}
              </button>
            ))}
          </div>
        </Row>
        {showVentures && (
          <Row label="Area">
            <div className="tk-seg" role="radiogroup" aria-label="Area">
              <button type="button" role="radio" aria-checked={todo.area === 'Personal' && !pickingVenture} className={`tk-seg-btn${todo.area === 'Personal' && !pickingVenture ? ' on' : ''}`} onClick={() => { setPickingVenture(false); if (todo.area !== 'Personal') void save({ area: 'Personal', ventureTag: null }) }}>Personal</button>
              <button type="button" role="radio" aria-checked={todo.area === 'Ventures' || pickingVenture} className={`tk-seg-btn${todo.area === 'Ventures' || pickingVenture ? ' on' : ''}`} onClick={() => { if (todo.area !== 'Ventures') { if (tagOptions.length === 1) void save({ area: 'Ventures', ventureTag: tagOptions[0] }); else setPickingVenture(true) } }}>Ventures</button>
            </div>
            {(todo.area === 'Ventures' || pickingVenture) && (
              <button type="button" className={`tk-prop-btn${todo.area === 'Ventures' && todo.ventureTag ? '' : ' is-empty'}`} aria-label={`Venture: ${todo.area === 'Ventures' && todo.ventureTag ? todo.ventureTag : 'none'}`} aria-haspopup="menu" onClick={(event) => setMenu({ kind: 'venture', anchor: event.currentTarget })}>
                {todo.area === 'Ventures' && todo.ventureTag ? todo.ventureTag : 'Choose a venture'}<Hi icon={ChevronDownIcon} size={12} />
              </button>
            )}
          </Row>
        )}
        <Row label="Repeat">
          <button type="button" className={`tk-prop-btn${todo.recurrence ? '' : ' is-empty'}`} aria-label={`Repeat: ${todo.recurrence ? repeatWords(todo.recurrence) : 'does not repeat'}`} aria-haspopup="menu" onClick={(event) => setMenu({ kind: 'repeat', anchor: event.currentTarget })}>
            <Hi icon={RepeatIcon} size={14} />{todo.recurrence ? `Every ${repeatWords(todo.recurrence).replace(/^every /, '')}` : 'Does not repeat'}
          </button>
          {todo.recurrence && !todo.dueDate && <p className="tk-hint">The next one is made from the due date, so give it one.</p>}
        </Row>
        {!done && (
          <Row label="Snooze">
            <button type="button" className={`tk-prop-btn${snoozed ? '' : ' is-empty'}`} aria-haspopup="menu" onClick={(event) => setMenu({ kind: 'snooze', anchor: event.currentTarget })}>
              <Hi icon={SnoozeIcon} size={14} />{snoozed ? `Until ${wakeLabel(new Date(todo.snoozedUntil!), now)}` : 'Not snoozed'}
            </button>
          </Row>
        )}
        <Row label="Issue">
          <IssueField key={todo.issueLink?.url ?? ''} todo={todo} issue={issue} onSave={(url) => board.linkIssue(todo, url)} />
        </Row>
      </div>

      <section className="tk-pane-section" aria-label="Notes">
        <h3>Notes{todo.notes.length > 0 && <span>{todo.notes.length}</span>}</h3>
        <NoteComposer inputRef={noteRef} initial={board.noteDraft(todo.id)} onDraft={(text) => board.setNoteDraft(todo.id, text)} onAdd={(body) => board.addNote(todo, body)} />
        {todo.notes.length > 0 && (
          <ol className="tk-notes">
            {[...todo.notes].reverse().map((note) => (
              <li key={note.id}><p>{note.body}</p><time dateTime={note.createdAt}>{when(note.createdAt)}</time></li>
            ))}
          </ol>
        )}
      </section>

      <Related todo={todo} all={board.todos} onOpen={onOpenTask} onPick={(anchor) => setMenu({ kind: 'relate', anchor })} onRelate={(id, on) => board.relate(todo, id, on)} />

      <p className="tk-pane-meta">Added {when(todo.createdAt)}{todo.updatedAt !== todo.createdAt ? ` · changed ${when(todo.updatedAt)}` : ''}</p>
      <ChatAbout of={() => todoContext(todo)} host=".tk-pane-body" />

      {menu?.kind === 'due' && <DueMenu anchor={menu.anchor} now={now} dueDate={todo.dueDate} title={todo.title} idKey={`pane-${todo.id}`} onClose={() => setMenu(null)} onDue={(dueDate) => void save({ dueDate })} />}
      {menu?.kind === 'snooze' && <SnoozeMenu anchor={menu.anchor} now={now} todo={todo} onClose={() => setMenu(null)} onSnooze={(until) => void board.snooze(todo, until)} onWake={() => void board.wake(todo)} />}
      {menu?.kind === 'repeat' && (
        <Menu
          anchor={menu.anchor} label={`Repeat ${todo.title}`} onClose={() => setMenu(null)} width={220}
          items={[{ heading: 'Repeat' }, ...[...REPEATS, ...(todo.recurrence && !REPEATS.includes(todo.recurrence as typeof REPEATS[number]) ? [todo.recurrence] : [])].map((value) => ({
            key: value || 'none', label: value ? `Every ${repeatWords(value).replace(/^every /, '')}` : 'Does not repeat',
            checked: (todo.recurrence ?? '') === value, onSelect: () => { if ((todo.recurrence ?? '') !== value) void save({ recurrence: value || null }) },
          }))]}
        />
      )}
      {menu?.kind === 'venture' && (
        <Menu
          anchor={menu.anchor} label={`Venture for ${todo.title}`} onClose={() => { setMenu(null); setPickingVenture(false) }} width={220}
          items={[{ heading: 'Venture' }, ...tagOptions.map((name) => ({
            key: name, label: name, checked: todo.area === 'Ventures' && todo.ventureTag === name,
            onSelect: () => { setPickingVenture(false); if (!(todo.area === 'Ventures' && todo.ventureTag === name)) void save({ area: 'Ventures', ventureTag: name }) },
          }))]}
        />
      )}
      {menu?.kind === 'relate' && (
        <Menu
          anchor={menu.anchor} label={`Relate a task to ${todo.title}`} onClose={() => setMenu(null)} width={300}
          items={[{ heading: 'Relate an open task' }, ...relatable(todo, board.todos).map((item) => ({
            key: item.id, label: item.title, onSelect: () => void board.relate(todo, item.id, true),
          }))]}
        />
      )}
      {menu?.kind === 'more' && (
        <Menu
          anchor={menu.anchor} label={`Actions for ${todo.title}`} onClose={() => setMenu(null)} width={230}
          items={[
            ...(done ? [] : [{ key: 'not-doing', label: 'Not doing this', icon: NoSymbolIcon, onSelect: () => void board.notDoing(todo) }]),
            { key: 'delete', label: 'Move to recycle bin', icon: TrashIcon, danger: true, onSelect: () => { onClose(); void board.remove(todo) } },
          ]}
        />
      )}
    </div>
  )
}

function IssueField({ todo, issue, onSave }: { todo: Todo; issue?: IssueState; onSave: (url: string | null) => Promise<{ ok: boolean; error?: string }> }) {
  const link = todo.issueLink
  const [editing, setEditing] = useState(!link)
  const [value, setValue] = useState(link?.url ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function commit(next: string | null) {
    if ((next ?? null) === (link?.url ?? null)) { if (link) setEditing(false); return }
    setBusy(true)
    const result = await onSave(next)
    setBusy(false)
    if (result.ok) { setError(''); setEditing(!next) } else setError(result.error ?? '')
  }

  if (link && !editing) {
    return (
      <div className="tk-issue-line">
        <a className={`tk-issue-link ${issue?.state ?? 'unknown'}`} href={link.url} target="_blank" rel="noreferrer">
          <Hi icon={issue?.state === 'closed' ? IssueClosedIcon : issue?.state === 'open' ? IssueOpenIcon : LinkIcon} size={14} />
          <span className="tk-issue-ref">{issueKey(link)}</span>
          {issue && <span className="tk-issue-state">{issue.state === 'open' ? 'Open' : 'Closed'}</span>}
        </a>
        {issue?.title && <span className="tk-issue-title" title={issue.title}>{issue.title}</span>}
        <span className="tk-issue-actions">
          <button type="button" className="tk-link-btn" onClick={() => { setValue(link.url); setEditing(true) }}>Change</button>
          <button type="button" className="tk-link-btn" disabled={busy} onClick={() => void commit(null)}>Remove</button>
        </span>
      </div>
    )
  }
  return (
    <form className="tk-issue-form" onSubmit={(event) => { event.preventDefault(); void commit(value.trim() || null) }}>
      <input
        type="url"
        aria-label="GitHub issue link"
        placeholder="Paste a GitHub issue link"
        value={value}
        onChange={(event) => { setValue(event.target.value); setError('') }}
        onBlur={() => { if (value.trim() && value.trim() !== link?.url) void commit(value.trim()) }}
        onKeyDown={(event) => { if (event.key === 'Escape' && link) { event.stopPropagation(); setEditing(false); setValue(link.url) } }}
        disabled={busy}
      />
      {error && <p className="tk-hint error" role="alert">{error}</p>}
    </form>
  )
}

function NoteComposer({ onAdd, inputRef, initial, onDraft }: {
  onAdd: (body: string) => Promise<boolean>
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  /** An unsent note left on this task earlier. */
  initial: string
  onDraft: (text: string) => void
}) {
  const [draft, setDraftState] = useState(initial)
  const setDraft = (text: string) => { setDraftState(text); onDraft(text) }
  const [busy, setBusy] = useState(false)
  useGrow(inputRef, draft)
  async function send() {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    if (await onAdd(body)) setDraft('')
    setBusy(false)
  }
  return (
    <form className="tk-note-compose" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <textarea
        ref={inputRef}
        aria-label="New note"
        placeholder="Add a note"
        rows={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || !event.shiftKey)) { event.preventDefault(); void send() }
          if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.blur() }
        }}
      />
      <button type="submit" className="btn compact" disabled={!draft.trim() || busy}>Add</button>
    </form>
  )
}

/** Open tasks this one could be related to: not itself, not already related. */
function relatable(todo: Todo, all: readonly Todo[]) {
  return all.filter((item) => item.id !== todo.id && item.status !== 'done' && !item.deletedAt && !item.archivedAt && !todo.relations.some((relation) => relation.id === item.id))
}

function Related({ todo, all, onOpen, onPick, onRelate }: { todo: Todo; all: Todo[]; onOpen: (id: string) => void; onPick: (anchor: HTMLElement) => void; onRelate: (id: string, on: boolean) => void }) {
  const any = useMemo(() => relatable(todo, all).length > 0, [all, todo])
  return (
    <section className="tk-pane-section" aria-label="Related tasks">
      <h3>Related{todo.relations.length > 0 && <span>{todo.relations.length}</span>}</h3>
      {todo.relations.map((relation) => (
        <div className="tk-related" key={relation.id}>
          <button type="button" className={`tk-related-open${relation.status === 'done' ? ' done' : ''}`} onClick={() => onOpen(relation.id)}>{relation.title}</button>
          <button type="button" className="tk-icon-btn small" aria-label={`Unrelate ${relation.title}`} onClick={() => onRelate(relation.id, false)}><Hi icon={XMarkIcon} size={13} /></button>
        </div>
      ))}
      {any && (
        <button type="button" className="tk-prop-btn is-empty" aria-haspopup="menu" onClick={(event) => onPick(event.currentTarget)}>
          <Hi icon={PlusIcon} size={13} />Relate a task
        </button>
      )}
    </section>
  )
}

export function SheetDetail({ item, feed, now, onClose }: { item: SheetItem; feed: SheetFeed | null; now: Date; onClose: () => void }) {
  const source = sheetName(feed)
  const prio = item.priority ? SHEET_PRIORITY_WORD[item.priority] : 'None'
  return (
    <div className="tk-pane-body" role="region" aria-label={`${source}: ${item.title}`}>
      <div className="tk-pane-bar">
        <span className="tk-lead"><Hi icon={SheetIcon} size={17} className="tk-sheet-glyph" /></span>
        <span className="tk-pane-state">{source} · read-only</span>
        <span className="tk-saved" />
        <button type="button" className="tk-icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}><Hi icon={XMarkIcon} size={17} /></button>
      </div>
      <h2 className="tk-pane-title static">{item.title}</h2>
      <div className="tk-props">
        <Row label="Due"><span className="tk-prop-static">{item.dueDate ? dueText(item.dueDate, now) : 'No date'}</span></Row>
        <Row label="Priority"><span className="tk-prop-static">{prio}</span></Row>
        <Row label="Status"><span className="tk-prop-static">{item.status || '—'}</span></Row>
        <Row label="Who"><span className="tk-prop-static">{item.who || '—'}</span></Row>
        <Row label="Row"><span className="tk-prop-static">{item.row}</span></Row>
      </div>
      {item.notes && <section className="tk-pane-section" aria-label="Notes and links"><h3>Notes &amp; links</h3><p className="tk-sheet-notes">{item.notes}</p></section>}
      <a className="btn primary tk-open-sheet" href={item.url} target="_blank" rel="noreferrer"><Hi icon={ArrowTopRightOnSquareIcon} size={15} /> Open in sheet</a>
      <p className="tk-pane-meta">Totem only reads this sheet. Change the row there; it shows here within two minutes.</p>
    </div>
  )
}

export interface Summary {
  overdue: number
  today: number
  doneToday: number
  nextDue: string | null
  snoozed: number
  nextBack: { title: string; at: Date } | null
}

export const KEYS: Array<[string, string]> = [
  ['j / k', 'Move (↑ ↓, Home, End)'], ['x / Space', 'Complete'], ['s', 'Snooze'], ['d', 'Due date'], ['p', 'Priority'],
  ['m', 'Add a note'], ['n', 'New task'], ['Enter', 'Open'], ['o', 'Open in sheet or GitHub'],
  ['⌫ / Del', 'Recycle bin'], ['Esc', 'Close'], ['/', 'Search'],
]

export function SummaryPane({ summary, now, feed, sheetError, onSetUpSheet }: { summary: Summary; now: Date; feed: SheetFeed | null; sheetError: string; onSetUpSheet: () => void }) {
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now)
  const clear = !summary.overdue && !summary.today
  return (
    <div className="tk-pane-body tk-summary" role="region" aria-label="Today">
      <p className="tk-summary-day">{day}</p>
      <h2 className="tk-summary-head">{clear ? (summary.doneToday ? 'All clear for today.' : 'Nothing due today.') : `${summary.overdue + summary.today} to do today`}</h2>
      <div className="tk-stats">
        <div className={summary.overdue ? 'tk-stat overdue' : 'tk-stat'}><strong>{summary.overdue}</strong><span>Overdue</span></div>
        <div className="tk-stat"><strong>{summary.today}</strong><span>Today</span></div>
        <div className="tk-stat done"><strong>{summary.doneToday}</strong><span>Done today</span></div>
      </div>
      <ul className="tk-summary-lines">
        {summary.nextDue && <li>Next due {dateLabel(summary.nextDue)}.</li>}
        {summary.nextBack && <li>{summary.snoozed} snoozed; “{summary.nextBack.title}” is back {wakeLabel(summary.nextBack.at, now)}.</li>}
        {sheetError ? null
          // A failed or stale read is said once, at the top of the list, not here again.
          : feed?.configured ? (feed.stale || feed.error ? null : <li className="tk-muted">{sheetName(feed)}: {sheetFeedLine(feed)}</li>)
            : feed ? <li className="tk-muted">No task sheet is set up. <button type="button" className="tk-link-btn" onClick={onSetUpSheet}>Set up a task sheet</button></li> : null}
      </ul>
      <div className="tk-keys" aria-label="Keyboard">
        {KEYS.map(([key, what]) => <div key={key}><kbd>{key}</kbd><span>{what}</span></div>)}
      </div>
    </div>
  )
}

/** Archive or recycle bin, read only when opened, in the pane. */
export function ShelfPane({ kind, board, onClose }: { kind: 'archive' | 'deleted'; board: TaskBoard; onClose: () => void }) {
  const [items, setItems] = useState<Todo[] | null>(null)
  // A task opened from the shelf: read here, with only the way back, since it is off the list.
  const [open, setOpen] = useState<Todo | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  // The board's count of this shelf: when it moves (a task binned or archived from the
  // list, or an Undo that restored one), the open shelf reads itself again.
  const count = kind === 'archive' ? board.counts.archived : board.counts.deleted
  useEffect(() => {
    let live = true
    setError('')
    getTodoBoard(kind === 'archive' ? { archived: true } : { deleted: true })
      .then((result) => { if (live) setItems(result.todos) })
      .catch((cause) => { if (live) setError(cause instanceof ApiError || cause instanceof Error ? cause.message : 'Could not load.') })
    return () => { live = false }
  }, [kind, tick, count])
  const groups = useMemo(() => (items && kind === 'archive' ? groupArchive(items, 'day') : null), [items, kind])

  async function bringBack(todo: Todo) {
    if (kind === 'deleted') { if (await board.restore(todo)) { setItems((list) => list && list.filter((item) => item.id !== todo.id)); setOpen(null) } }
    else {
      try {
        await unarchiveBoardTodo(todo.id)
        setItems((list) => list && list.filter((item) => item.id !== todo.id))
        setOpen(null)
        void board.loadBoard()
      } catch (cause) { pushError(cause) }
    }
  }

  const row = (todo: Todo) => (
    <div className="tk-shelf-row" key={todo.id}>
      <button type="button" className="tk-related-open" onClick={() => setOpen(todo)}>{todo.title}</button>
      <button type="button" className="tk-link-btn" onClick={() => void bringBack(todo)}>{kind === 'deleted' ? 'Restore' : 'Unarchive'}</button>
    </div>
  )

  // Esc on a task opened from the shelf goes back to the shelf, ahead of the page's
  // Esc (which closes the pane), unless a menu or dialog is on top.
  useEffect(() => {
    if (!open) return
    function back(event: KeyboardEvent) {
      if (event.key !== 'Escape' || document.querySelector('[role="menu"], [role="dialog"], [aria-modal="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(null)
    }
    window.addEventListener('keydown', back, true)
    return () => window.removeEventListener('keydown', back, true)
  }, [open])

  const shelf = kind === 'archive' ? 'Archive' : 'Recycle bin'
  if (open) {
    const ended = kind === 'archive' ? (open.completedAt ?? open.archivedAt) : open.deletedAt
    return (
      <div className="tk-pane-body" role="region" aria-label={`${shelf}: ${open.title}`}>
        <div className="tk-pane-bar">
          <button type="button" className="tk-icon-btn" aria-label={`Back to the ${shelf.toLowerCase()}`} title="Back" onClick={() => setOpen(null)}><Hi icon={ChevronLeftIcon} size={17} /></button>
          <span className="tk-pane-state">{shelf} · read-only</span>
          <span className="tk-saved" />
          <button type="button" className="tk-icon-btn" aria-label="Close" onClick={onClose}><Hi icon={XMarkIcon} size={17} /></button>
        </div>
        <h2 className="tk-pane-title static">{open.title}</h2>
        {open.description && <p className="tk-sheet-notes">{open.description}</p>}
        <div className="tk-props">
          <Row label={kind === 'archive' ? 'Finished' : 'Binned'}><span className="tk-prop-static">{ended ? when(ended) : '—'}</span></Row>
          {kind === 'archive' && <Row label="Outcome"><span className="tk-prop-static">{open.outcome === 'not_doing' ? 'Not doing' : 'Done'}</span></Row>}
          <Row label="Due"><span className="tk-prop-static">{open.dueDate ? dateLabel(open.dueDate) : 'No date'}</span></Row>
          <Row label="Priority"><span className="tk-prop-static">{priorityName(open.priority)}</span></Row>
          {open.area === 'Ventures' && <Row label="Venture"><span className="tk-prop-static">{open.ventureTag ?? '—'}</span></Row>}
        </div>
        {open.notes.length > 0 && (
          <section className="tk-pane-section" aria-label="Notes">
            <h3>Notes<span>{open.notes.length}</span></h3>
            <ol className="tk-notes">{[...open.notes].reverse().map((note) => <li key={note.id}><p>{note.body}</p><time dateTime={note.createdAt}>{when(note.createdAt)}</time></li>)}</ol>
          </section>
        )}
        <button type="button" className="btn primary compact tk-open-sheet" onClick={() => void bringBack(open)}>{kind === 'deleted' ? 'Restore to the list' : 'Unarchive'}</button>
      </div>
    )
  }

  return (
    <div className="tk-pane-body" role="region" aria-label={kind === 'archive' ? 'Archive' : 'Recycle bin'}>
      <div className="tk-pane-bar">
        <span className="tk-lead"><Hi icon={kind === 'archive' ? ArchiveBoxIcon : TrashIcon} size={16} /></span>
        <span className="tk-pane-state">{kind === 'archive' ? 'Archive' : 'Recycle bin'}{items ? ` · ${items.length.toLocaleString()}` : ''}</span>
        <span className="tk-saved" />
        <button type="button" className="tk-icon-btn" aria-label="Read again" title="Read again" onClick={() => setTick((n) => n + 1)}><Hi icon={ArrowPathIcon} size={15} /></button>
        <button type="button" className="tk-icon-btn" aria-label="Close" onClick={onClose}><Hi icon={XMarkIcon} size={17} /></button>
      </div>
      {error && <p className="tk-hint error" role="alert">{error}</p>}
      {!items && !error && <p className="tk-quiet">Loading…</p>}
      {items?.length === 0 && <p className="tk-quiet">{kind === 'archive' ? 'Nothing archived yet.' : 'The recycle bin is empty.'}</p>}
      {groups ? groups.map((group) => (
        <section className="tk-pane-section" key={group.key} aria-label={group.label}>
          <h3>{group.label}<span>{group.todos.length}</span></h3>
          {group.todos.map(row)}
        </section>
      )) : items?.map(row)}
      {kind === 'deleted' && <p className="tk-pane-meta">Retention is set in Settings → Tasks.</p>}
    </div>
  )
}
