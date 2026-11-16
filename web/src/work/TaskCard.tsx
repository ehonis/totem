import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChat } from '../chat/store'
import { ThreadItem } from '../chat/ThreadList'
import { TI } from '../chat/ui'
import {
  IconArrowUpRight, IconCalendar, IconChevronDown, IconChevronUp, IconCircle, IconCircleCheck, IconExternalLink, IconFlag, IconFolder,
  IconMessage, IconPlus, IconRepeat, IconTable, IconTrash, IconX, IconZzz,
} from '../chat/icons'
import { SHEET_PRIORITY_WORD, wakeLabel } from '../todos/board'
import { dueText } from '../todos/format'
import { DueMenu, PriorityMenu, priorityName, RepeatMenu, SnoozeMenu } from '../todos/TaskMenus'
import { repeatWords } from '../todos/TaskRow'
import '../todos/todos.css'
import { chatsByTask, resolveRef, type WorkTask } from './groups'
import { closeTaskCard, newTaskChat, openTaskChat, pinTask, showInTasks, useTaskCard } from './card'
import { FolderField } from './FolderField'
import { completeTask, deleteTask, findTask, reopenTask, setTaskFolder, snoozeTask, updateTask, useWork } from './state'
import './work.css'

// A task's card, T3 Code's thread card for a task: the check circle and title, one
// row per setting with a dropdown (folder, due day, priority, repeat, snooze), its
// description, the chats working on it and the way to the Tasks page. Every change
// saves at once, through the same store the chats panel reads, and the Tasks page
// reads it again (todos/bus.ts). A sheet row shows read-only, but can be filed.
//
// It is drawn two ways:
// - Pinned (PinnedTask): the open chat's own task sits at the chat's top right for
//   as long as the chat is on screen. Nothing outside closes it; it folds to its
//   title row, and folds itself while the chat column is too narrow to keep it
//   beside the messages. When it is unfolded the messages and composer move left
//   to clear it (work.css). Not on a phone, where the strip opens the sheet.
// - A dialog (TaskCardHost, mounted once by App): any other task, opened from the
//   chats panel or the strip, in a modal over a backdrop, so it is edited without a
//   card hanging over the page. Esc, × or the backdrop close it. On a phone it is a
//   sheet from the bottom.

const PHONE = '(max-width: 720px)'
/** Below this chat column width the pinned card starts folded, until the owner unfolds it. */
const PIN_ROOM = 1000
const PIN_FOLD_KEY = 'totem.taskPin.folded'

function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE).matches))
  useEffect(() => {
    const media = window.matchMedia?.(PHONE)
    if (!media) return
    const update = () => setPhone(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return phone
}

/** A menu or picker the card opened is up (they are portalled, and take Esc and outside clicks first). */
const menuUp = () => Boolean(document.querySelector('.wk-combo, .tk-menu'))

/** Mounted once, by App: the dialog for whichever task is open. */
export default function TaskCardHost() {
  const ref = useTaskCard()
  // Subscribing keeps the task store fresh while a card is up.
  const task = useWork(() => (ref ? findTask(ref) : null))
  const loaded = useWork((s) => s.loaded)
  // A task that left the list (deleted elsewhere) closes its card once the list has been read.
  useEffect(() => { if (ref && loaded && !task) closeTaskCard() }, [ref, loaded, task])
  if (!ref || !task) return null
  return <TaskDialog key={task.ref} task={task} />
}

function TaskDialog({ task }: { task: WorkTask }) {
  const phone = usePhone()
  const card = useRef<HTMLDivElement>(null)

  // Leaving saves the field being typed in first (WebKit fires no blur on a field that is removed).
  const close = () => {
    const active = document.activeElement as HTMLElement | null
    if (active && card.current?.contains(active)) active.blur()
    closeTaskCard()
  }
  const latestClose = useRef(close)
  latestClose.current = close

  // Focus moves into the dialog, and back to what had it when it closes (unless
  // closing went somewhere that took focus, like a chat's composer).
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    card.current?.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      if (before && before.isConnected && (!now || now === document.body)) before.focus?.({ preventScroll: true })
    }
  }, [])

  // Esc closes it, unless a menu or the folder picker over it is open (they close
  // themselves first); it takes the key, so a side panel listening on window stays.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || menuUp()) return
      event.preventDefault()
      latestClose.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return createPortal(
    <div
      className={`wk-card-scrim${phone ? ' sheet' : ''}`}
      onPointerDown={(event) => { if (event.target === event.currentTarget && !menuUp()) close() }}
    >
      <CardBody task={task} mode={phone ? 'sheet' : 'dialog'} cardRef={card} onClose={close} />
    </div>,
    document.body,
  )
}

/**
 * The open chat's task, pinned at the chat's top right. ChatView mounts it inside
 * `.vc`; `visible` is whether the chat is the page on screen (it stays mounted
 * behind other pages), and only then does opening the task reveal this panel.
 */
export function PinnedTask({ taskRef, visible }: { taskRef: string; visible: boolean }) {
  const phone = usePhone()
  const task = useWork(() => findTask(taskRef))
  if (phone || !task) return null
  return <Pinned key={task.ref} task={task} visible={visible} />
}

function readFoldPref(): boolean | null {
  try {
    const v = localStorage.getItem(PIN_FOLD_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch { return null }
}

function Pinned({ task, visible }: { task: WorkTask; visible: boolean }) {
  const card = useRef<HTMLDivElement>(null)
  // The owner's own fold, kept on this device; with none, it folds while the column is narrow.
  const [pref, setPref] = useState<boolean | null>(readFoldPref)
  // Opening the task elsewhere unfolds it for now, without changing that choice.
  const [revealed, setRevealed] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [flash, setFlash] = useState(0)

  useLayoutEffect(() => {
    const column = card.current?.closest<HTMLElement>('.vc')
    if (!column) return
    const measure = () => setNarrow(column.clientWidth < PIN_ROOM)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(column)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    return pinTask(task.ref, () => { setRevealed(true); setFlash((n) => n + 1) })
  }, [visible, task.ref])

  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(0), 900)
    return () => window.clearTimeout(t)
  }, [flash])

  const folded = !revealed && (pref ?? narrow)
  const setFolded = (next: boolean) => {
    setRevealed(false)
    setPref(next)
    try { localStorage.setItem(PIN_FOLD_KEY, next ? '1' : '0') } catch { /* private window: this visit only */ }
  }

  return <CardBody task={task} mode="pinned" cardRef={card} folded={folded} onFold={setFolded} flash={flash > 0} />
}

type MenuKind = 'due' | 'priority' | 'repeat' | 'snooze'
type Mode = 'dialog' | 'sheet' | 'pinned'

interface BodyProps {
  task: WorkTask
  mode: Mode
  cardRef: React.RefObject<HTMLDivElement>
  /** A dialog's way out; a pinned card has none. */
  onClose?: () => void
  folded?: boolean
  onFold?: (folded: boolean) => void
  flash?: boolean
}

function CardBody({ task, mode, cardRef, onClose, folded = false, onFold, flash = false }: BodyProps) {
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: HTMLElement } | null>(null)
  const now = new Date()
  const todo = task.todo
  const sheet = task.sheet
  const pinned = mode === 'pinned'

  const title = useDraft(task.title, (next) => { if (todo && next.trim() && next.trim() !== todo.title) void updateTask(task.ref, { title: next.trim() }) })
  const description = useDraft(todo?.description ?? '', (next) => { if (todo && next !== todo.description) void updateTask(task.ref, { description: next }) })
  const snoozed = Boolean(todo?.snoozedUntil && new Date(todo.snoozedUntil) > now)
  // Grows with its text (field-sizing is Chromium-only; the desktop app is WebKit).
  const titleBox = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = titleBox.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [title.bind.value, folded])
  const open = (kind: MenuKind) => (event: React.MouseEvent<HTMLButtonElement>) => setMenu({ kind, anchor: event.currentTarget })

  const head = (
    <div className="wk-card-head">
      {todo ? (
        <button type="button" className={`wk-check prio-${task.priority} ${task.done ? 'done' : ''}`} onClick={() => void (task.done ? reopenTask(task.ref) : completeTask(task.ref))} aria-label={task.done ? `Reopen “${task.title}”` : `Mark “${task.title}” done`} title={task.done ? 'Reopen' : 'Mark done'}>
          <TI icon={IconCircle} size={18} className="wk-check-off" />
          <TI icon={IconCircleCheck} size={18} className="wk-check-on" />
        </button>
      ) : <span className="wk-check sheet" title="On the shared sheet"><TI icon={IconTable} size={16} /></span>}
      {folded ? (
        <button type="button" className="wk-card-title static folded" onClick={() => onFold?.(false)} title="Show the task’s settings">{task.title}</button>
      ) : todo ? (
        <textarea
          ref={titleBox} className="wk-card-title" rows={1} aria-label="Title" {...title.bind}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { event.preventDefault(); title.revert(); event.currentTarget.blur() }
          }}
        />
      ) : <h2 className="wk-card-title static">{task.title}</h2>}
      {pinned
        ? <button type="button" className="vc-icon-btn sm wk-card-close" onClick={() => onFold?.(!folded)} aria-expanded={!folded} aria-label={folded ? 'Show the task’s settings' : 'Fold the task'} title={folded ? 'Show the task’s settings' : 'Fold'}><TI icon={folded ? IconChevronDown : IconChevronUp} size={15} /></button>
        : <button type="button" className="vc-icon-btn sm wk-card-close" onClick={onClose} aria-label="Close" title="Close (Esc)"><TI icon={IconX} size={15} /></button>}
    </div>
  )

  const leave = pinned ? undefined : onClose
  const classes = ['wk-card', mode === 'sheet' ? 'sheet' : '', mode === 'dialog' ? 'dialog' : '', pinned ? 'pinned' : '', folded ? 'folded' : '', flash ? 'flash' : ''].filter(Boolean).join(' ')
  const label = pinned ? `This chat’s task: ${task.title}` : `Task: ${task.title}`

  return (
    <div
      ref={cardRef} className={classes} tabIndex={-1}
      {...(pinned ? { role: 'complementary' } : { role: 'dialog', 'aria-modal': true })}
      aria-label={label}
    >
      {head}
      {!folded && (
        <>
          <div className="wk-card-rows">
            <CardRow icon={IconFolder} label="Folder">
              <FolderField folderId={task.folderId} title={task.title} onPick={(id) => void setTaskFolder(task.ref, id)} className="wk-card-value" align="end" />
            </CardRow>
            {todo ? (
              <>
                <CardRow icon={IconCalendar} label="Due">
                  <ValueButton empty={!todo.dueDate} onClick={open('due')} text={todo.dueDate ? dueText(todo.dueDate, now, todo.status) : 'No date'} />
                </CardRow>
                <CardRow icon={IconFlag} label="Priority">
                  <ValueButton empty={todo.priority === 1} onClick={open('priority')} text={priorityName(todo.priority)} tone={`tk-prio-${5 - todo.priority}`} />
                </CardRow>
                <CardRow icon={IconRepeat} label="Repeat">
                  <ValueButton empty={!todo.recurrence} onClick={open('repeat')} text={todo.recurrence ? `Every ${repeatWords(todo.recurrence).replace(/^every /, '')}` : 'Does not repeat'} />
                </CardRow>
                {!task.done && (
                  <CardRow icon={IconZzz} label="Snooze">
                    <ValueButton empty={!snoozed} onClick={open('snooze')} text={snoozed ? `Until ${wakeLabel(new Date(todo.snoozedUntil!), now)}` : 'Not snoozed'} />
                  </CardRow>
                )}
              </>
            ) : sheet && (
              <>
                <CardRow icon={IconCalendar} label="Due"><span className="wk-card-static">{sheet.dueDate ? dueText(sheet.dueDate, now) : 'No date'}</span></CardRow>
                <CardRow icon={IconFlag} label="Priority"><span className="wk-card-static">{sheet.priority ? SHEET_PRIORITY_WORD[sheet.priority] : 'None'}</span></CardRow>
                {sheet.status && <CardRow icon={IconCircle} label="Status"><span className="wk-card-static">{sheet.status}</span></CardRow>}
              </>
            )}
          </div>

          {todo ? (
            <textarea
              className="wk-card-desc" rows={2} aria-label="Description" placeholder="Add a description" {...description.bind}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur() }
                if (event.key === 'Escape') { event.preventDefault(); description.revert(); event.currentTarget.blur() }
              }}
            />
          ) : sheet?.notes ? <p className="wk-card-notes">{sheet.notes}</p> : null}

          <TaskChats taskRef={task.ref} onLeave={leave} />

          <div className="wk-card-foot">
            {todo
              ? <button type="button" className="wk-card-link" onClick={() => { leave?.(); showInTasks(task.ref) }}><TI icon={IconArrowUpRight} size={14} />Open in Tasks</button>
              : sheet && <a className="wk-card-link" href={sheet.url} target="_blank" rel="noreferrer"><TI icon={IconExternalLink} size={14} />Open in the sheet</a>}
            {todo && (
              <button type="button" className="wk-card-link danger" onClick={() => { leave?.(); void deleteTask(task.ref) }}><TI icon={IconTrash} size={14} />Delete</button>
            )}
          </div>
        </>
      )}

      {todo && menu?.kind === 'due' && <DueMenu anchor={menu.anchor} now={now} dueDate={todo.dueDate} title={todo.title} idKey={`card-${todo.id}`} onClose={() => setMenu(null)} onDue={(dueDate) => void updateTask(task.ref, { dueDate })} />}
      {todo && menu?.kind === 'priority' && <PriorityMenu anchor={menu.anchor} priority={todo.priority} title={todo.title} onClose={() => setMenu(null)} onPriority={(priority) => void updateTask(task.ref, { priority })} />}
      {todo && menu?.kind === 'repeat' && <RepeatMenu anchor={menu.anchor} recurrence={todo.recurrence} title={todo.title} onClose={() => setMenu(null)} onRepeat={(recurrence) => void updateTask(task.ref, { recurrence })} />}
      {todo && menu?.kind === 'snooze' && <SnoozeMenu anchor={menu.anchor} now={now} todo={todo} onClose={() => setMenu(null)} onSnooze={(until) => void snoozeTask(task.ref, until)} onWake={() => void snoozeTask(task.ref, null)} />}
    </div>
  )
}

/** The chats linked to a task, each one click away, and a new one for it. The card and the Tasks page's pane both show it. */
export function TaskChats({ taskRef, onLeave }: { taskRef: string; onLeave?: () => void }) {
  const threads = useChat((s) => s.threads)
  const tasks = useWork((s) => s.tasks)
  const activeId = useChat((s) => s.activeId)
  const runs = useChat((s) => s.runs)
  const chats = useMemo(() => chatsByTask(threads, tasks).get(resolveRef(taskRef, tasks)) || [], [threads, tasks, taskRef])
  return (
    <div className="wk-card-section" aria-label="Chats">
      <div className="wk-card-section-head">
        <TI icon={IconMessage} size={14} />
        <span>Chats{chats.length ? <span className="wk-card-count">{chats.length}</span> : null}</span>
        <button type="button" className="wk-card-link" onClick={() => { onLeave?.(); newTaskChat(taskRef) }}><TI icon={IconPlus} size={13} />New chat</button>
      </div>
      {chats.length ? (
        <div className="wk-card-chats">
          {chats.map((t) => <ThreadItem key={t.id} t={t} active={t.id === activeId} live={!!runs[t.id]} onOpen={(id) => { onLeave?.(); openTaskChat(id) }} />)}
        </div>
      ) : <p className="wk-card-empty">No chat is working on it yet.</p>}
    </div>
  )
}

function CardRow({ icon, label, children }: { icon: React.ComponentType<any>; label: string; children: React.ReactNode }) {
  return (
    <div className="wk-card-row">
      <span className="wk-card-label"><TI icon={icon} size={15} />{label}</span>
      {children}
    </div>
  )
}

function ValueButton({ text, empty, tone = '', onClick }: { text: string; empty?: boolean; tone?: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className={`wk-card-value${empty ? ' is-empty' : ''} ${tone}`.trim()} aria-haspopup="menu" onClick={onClick}>
      <span>{text}</span><TI icon={IconChevronDown} size={13} className="wk-folder-field-chev" />
    </button>
  )
}

/** A text field that saves when it loses focus, and follows the saved value while not being edited. */
function useDraft(saved: string, commit: (next: string) => void) {
  const [draft, setDraft] = useState(saved)
  const editing = useRef(false)
  // Esc puts the text back and then blurs: that blur must not save what was typed.
  const reverted = useRef(false)
  // What an unmount mid-edit (the card closed some other way) still has to save.
  const latest = useRef({ draft, commit })
  latest.current = { draft, commit }
  useEffect(() => { if (!editing.current) setDraft(saved) }, [saved])
  useEffect(() => () => { if (editing.current) { editing.current = false; latest.current.commit(latest.current.draft) } }, [])
  return {
    revert: () => { reverted.current = true; setDraft(saved); editing.current = false },
    bind: {
      value: draft,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { editing.current = true; setDraft(event.target.value) },
      onBlur: () => {
        editing.current = false
        if (reverted.current) { reverted.current = false; return }
        commit(draft)
      },
    },
  }
}
