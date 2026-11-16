import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChat } from '../chat/store'
import { ThreadItem } from '../chat/ThreadList'
import { TI } from '../chat/ui'
import {
  IconArrowUpRight, IconCalendar, IconChevronDown, IconCircle, IconCircleCheck, IconExternalLink, IconFlag, IconFolder,
  IconMessage, IconPlus, IconRepeat, IconTable, IconTrash, IconX, IconZzz,
} from '../chat/icons'
import { SHEET_PRIORITY_WORD, wakeLabel } from '../todos/board'
import { dueText } from '../todos/format'
import { DueMenu, PriorityMenu, priorityName, RepeatMenu, SnoozeMenu } from '../todos/TaskMenus'
import { repeatWords } from '../todos/TaskRow'
import '../todos/todos.css'
import { chatsByTask, resolveRef, type WorkTask } from './groups'
import { closeTaskCard, newTaskChat, openTaskChat, showInTasks, useTaskCard } from './card'
import { FolderField } from './FolderField'
import { completeTask, deleteTask, findTask, reopenTask, setTaskFolder, snoozeTask, updateTask, useWork } from './state'
import './work.css'

// The floating task card, T3 Code's thread card for a task: opened from a task in
// the chats panel's Tasks face or from a chat's task strip, it hangs at the top
// right of the page with each of the task's settings as a row with a dropdown
// (folder, due day, priority, repeat, snooze), its description, the chats working
// on it and the way to the Tasks page. Every change saves at once, through the same
// store the panel reads, and the Tasks page reads it again (todos/bus.ts). On a
// phone it is a sheet from the bottom. A sheet row shows read-only, but can be filed.

const PHONE = '(max-width: 720px)'

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

/**
 * Where the card sits on a desktop: at the page's right, below the page's own
 * header (its search, New task and "…"), or below the page's top edge when the
 * page has no header near the top.
 */
function usePlacement(on: boolean) {
  const [place, setPlace] = useState<React.CSSProperties>({ top: 56, right: 16 })
  useLayoutEffect(() => {
    if (!on) return
    const measure = () => {
      const main = document.querySelector<HTMLElement>('main.main')
      const rect = main?.getBoundingClientRect()
      if (!rect) return
      const head = main?.querySelector<HTMLElement>('header')?.getBoundingClientRect()
      const below = head && head.height > 0 && head.bottom - rect.top < 200 ? head.bottom + 8 : rect.top + 56
      setPlace({ top: Math.round(below), right: Math.max(8, Math.round(window.innerWidth - rect.right + 14)) })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [on])
  return place
}

/** Mounted once, by App: draws the card for whichever task is open. */
export default function TaskCardHost() {
  const ref = useTaskCard()
  // Subscribing keeps the task store fresh while a card is up.
  const task = useWork(() => (ref ? findTask(ref) : null))
  const loaded = useWork((s) => s.loaded)
  // A task that left the list (deleted elsewhere) closes its card once the list has been read.
  useEffect(() => { if (ref && loaded && !task) closeTaskCard() }, [ref, loaded, task])
  if (!ref || !task) return null
  return <TaskCard key={task.ref} task={task} />
}

type MenuKind = 'due' | 'priority' | 'repeat' | 'snooze'

function TaskCard({ task }: { task: WorkTask }) {
  const phone = usePhone()
  const place = usePlacement(!phone)
  const card = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: HTMLElement } | null>(null)
  const now = new Date()
  const todo = task.todo
  const sheet = task.sheet

  // Esc closes it, unless a menu or the folder picker over it is open (they close
  // themselves first); it takes the key, so a side panel listening on window stays.
  // A click on the page closes it too, after the field being typed in has saved
  // (WebKit fires no blur on a field that is removed).
  useEffect(() => {
    const close = () => {
      const active = document.activeElement as HTMLElement | null
      if (active && card.current?.contains(active)) active.blur()
      closeTaskCard()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || menu || document.querySelector('.wk-combo, .tk-menu')) return
      event.preventDefault()
      close()
    }
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || card.current?.contains(target)) return
      // Its own menus and pickers are portalled; a task row opens another card.
      if (target.closest('[role="menu"], [role="dialog"], [role="listbox"], .wk-task, .wk-taskbar-title, .tk-menu, .wk-combo')) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [menu])

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
  }, [title.bind.value])
  const open = (kind: MenuKind) => (event: React.MouseEvent<HTMLButtonElement>) => setMenu({ kind, anchor: event.currentTarget })

  const body = (
    <div
      ref={card} className={`wk-card${phone ? ' sheet' : ''}`} style={phone ? undefined : place}
      role="dialog" aria-label={`Task: ${task.title}`}
    >
      <div className="wk-card-head">
        {todo ? (
          <button type="button" className={`wk-check prio-${task.priority} ${task.done ? 'done' : ''}`} onClick={() => void (task.done ? reopenTask(task.ref) : completeTask(task.ref))} aria-label={task.done ? `Reopen “${task.title}”` : `Mark “${task.title}” done`} title={task.done ? 'Reopen' : 'Mark done'}>
            <TI icon={IconCircle} size={18} className="wk-check-off" />
            <TI icon={IconCircleCheck} size={18} className="wk-check-on" />
          </button>
        ) : <span className="wk-check sheet" title="On the shared sheet"><TI icon={IconTable} size={16} /></span>}
        {todo ? (
          <textarea
            ref={titleBox} className="wk-card-title" rows={1} aria-label="Title" {...title.bind}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur() }
              if (event.key === 'Escape') { event.preventDefault(); title.revert(); event.currentTarget.blur() }
            }}
          />
        ) : <h2 className="wk-card-title static">{task.title}</h2>}
        <button type="button" className="vc-icon-btn sm wk-card-close" onClick={closeTaskCard} aria-label="Close" title="Close (Esc)"><TI icon={IconX} size={15} /></button>
      </div>

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

      <TaskChats taskRef={task.ref} onLeave={closeTaskCard} />

      <div className="wk-card-foot">
        {todo
          ? <button type="button" className="wk-card-link" onClick={() => { closeTaskCard(); showInTasks(task.ref) }}><TI icon={IconArrowUpRight} size={14} />Open in Tasks</button>
          : sheet && <a className="wk-card-link" href={sheet.url} target="_blank" rel="noreferrer"><TI icon={IconExternalLink} size={14} />Open in the sheet</a>}
        {todo && (
          <button type="button" className="wk-card-link danger" onClick={() => { closeTaskCard(); void deleteTask(task.ref) }}><TI icon={IconTrash} size={14} />Delete</button>
        )}
      </div>

      {todo && menu?.kind === 'due' && <DueMenu anchor={menu.anchor} now={now} dueDate={todo.dueDate} title={todo.title} idKey={`card-${todo.id}`} onClose={() => setMenu(null)} onDue={(dueDate) => void updateTask(task.ref, { dueDate })} />}
      {todo && menu?.kind === 'priority' && <PriorityMenu anchor={menu.anchor} priority={todo.priority} title={todo.title} onClose={() => setMenu(null)} onPriority={(priority) => void updateTask(task.ref, { priority })} />}
      {todo && menu?.kind === 'repeat' && <RepeatMenu anchor={menu.anchor} recurrence={todo.recurrence} title={todo.title} onClose={() => setMenu(null)} onRepeat={(recurrence) => void updateTask(task.ref, { recurrence })} />}
      {todo && menu?.kind === 'snooze' && <SnoozeMenu anchor={menu.anchor} now={now} todo={todo} onClose={() => setMenu(null)} onSnooze={(until) => void snoozeTask(task.ref, until)} onWake={() => void snoozeTask(task.ref, null)} />}
    </div>
  )

  return createPortal(phone ? <div className="wk-card-scrim" onClick={(event) => { if (event.target === event.currentTarget) closeTaskCard() }}>{body}</div> : body, document.body)
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
