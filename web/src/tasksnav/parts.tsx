// The tasks in the chats panel's By task order (ChatsNav.tsx): the data (open tasks
// in the panel's scope by due day, snoozed tasks, each task's chats), a task's row
// with its check, snooze and new-chat buttons, a task with its chats in play under
// it, and the Recent / By task switch.
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useChat } from '../chat/store'
import { ThreadItem } from '../chat/ThreadList'
import type { SidebarScope } from '../chat/sidebar'
import ProjectIcon from '../chat/ProjectIcon'
import { TI } from '../chat/ui'
import { IconChevronDown, IconChevronUp, IconCircle, IconCircleCheck, IconTable, IconZzz, IconMessagePlus, IconUser, IconAlarmOff, IconRefresh } from './icons'
import { SnoozeMenu } from '../todos/TaskMenus'
import { wakeLabel } from '../todos/board'
import { chatsByTask, dueLabel, folderOf, snoozeSubject, type WorkTask } from '../work/groups'
import { completeTask, loadWork, snoozeTask, useWork } from '../work/state'
import { PERSONAL } from '../todos/folders'
import { scopedTasks, snoozedTasks, taskActivity, taskSections, wakeOf, type TaskGroup, type TaskSectionId } from './lists'
import type { Project } from '../chat/types'
import '../work/work.css'
import './tasksnav.css'

export function useTaskData(scope: SidebarScope, now: number) {
  const tasks = useWork((s) => s.tasks)
  const loaded = useWork((s) => s.loaded)
  const error = useWork((s) => s.error)
  const threads = useChat((s) => s.threads)
  const projects = useChat((s) => s.projects)
  const runs = useChat((s) => s.runs)
  const draftTaskId = useChat((s) => (!s.activeId ? s.draftTaskId : null))
  const live = useCallback((id: string) => !!runs[id], [runs])
  const scoped = useMemo(() => scopedTasks(tasks, scope, projects), [tasks, scope, projects])
  const sections = useMemo(() => taskSections(scoped, new Date(now)), [scoped, now])
  const snoozed = useMemo(() => snoozedTasks(scoped, now), [scoped, now])
  const byTask = useMemo(() => chatsByTask(threads, tasks), [threads, tasks])
  const open = sections.reduce((n, s) => n + s.tasks.length, 0)
  return { now, tasks, projects, runs, live, loaded, error, draftTaskId, sections, snoozed, byTask, open }
}

export type TaskData = ReturnType<typeof useTaskData>

/** What the panel does with a picked task: start a chat for it in its folder (pick.ts), and show the chat page. */
export type PickTask = (ref: string) => void

/** Nothing to list, or the list could not be read (said, with Retry; never "No open tasks"). */
export function TasksEmpty({ d }: { d: TaskData }) {
  if (d.error && !d.open) {
    return (
      <div className="st-empty st-error" role="status">
        <span>Couldn’t load your tasks · {d.error}</span>
        <button type="button" className="st-more" onClick={() => void loadWork()}><TI icon={IconRefresh} size={13} />Retry</button>
      </div>
    )
  }
  return d.loaded && !d.open ? <p className="st-empty">No open tasks.</p> : null
}

/** A task's folder, small: its icon and name, Personal when unfiled. */
export function FolderTag({ task, projects }: { task: WorkTask; projects: Project[] }) {
  const folder = folderOf(task, projects)
  const parent = folder?.parentId ? projects.find((p) => p.id === folder.parentId) : undefined
  return (
    <span className="st-folder" title={parent ? `${parent.name} › ${folder!.name}` : folder?.name || PERSONAL}>
      {folder ? <ProjectIcon p={folder} size={12} /> : <TI icon={IconUser} size={12} />}
      <span>{folder?.name || PERSONAL}</span>
    </span>
  )
}

export function DueTag({ task, now }: { task: WorkTask; now: Date }) {
  const due = dueLabel(task.dueDate, now)
  return due ? <span className={`wk-due ${due.tone}`}>{due.text}</span> : null
}

/** The round check: done for a local task, done for him alone for a sheet row (the sheet is untouched). */
export function TaskCheck({ task }: { task: WorkTask }) {
  const sheet = task.kind === 'sheet'
  return (
    <button
      type="button" className={`wk-check st-check ${sheet ? 'sheet' : `prio-${task.priority}`}`} onClick={(e) => { e.stopPropagation(); void completeTask(task.ref) }}
      aria-label={sheet ? `Mark “${task.title}” done for you (the sheet is unchanged)` : `Mark “${task.title}” done`}
      title={sheet ? `${task.status ? `${task.status} on the sheet. ` : ''}Mark done for you; the sheet is unchanged` : 'Mark done'}
    >
      <TI icon={sheet ? IconTable : IconCircle} size={sheet ? 15 : 16} className="wk-check-off" />
      <TI icon={IconCircleCheck} size={16} className="wk-check-on" />
    </button>
  )
}

/** The zzz button and its menu: tomorrow, three days, a week, or a time. */
export function SnoozeButton({ task, now, onOpenChange }: { task: WorkTask; now: Date; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const toggle = (v: boolean) => { setOpen(v); onOpenChange?.(v) }
  return (
    <>
      <button ref={ref} type="button" className="vc-thread-act" onClick={(e) => { e.stopPropagation(); toggle(!open) }} aria-label={`Snooze “${task.title}”`} title="Snooze" aria-haspopup="menu" aria-expanded={open}>
        <TI icon={IconZzz} size={15} />
      </button>
      {open && <SnoozeMenu
        anchor={ref.current} now={now} todo={snoozeSubject(task)} onClose={() => toggle(false)}
        onSnooze={(until) => void snoozeTask(task.ref, until)} onWake={() => void snoozeTask(task.ref, null)}
      />}
    </>
  )
}

/**
 * One task: its check, its title with the folder and due day under it, and on hover
 * Snooze and New chat. A click on the row starts a chat for it.
 */
export function TaskLine({ task, d, pick, compact = false, head = false }: {
  task: WorkTask; d: TaskData; pick: PickTask; compact?: boolean
  /** The head of a group, with its chats listed under it: no chat count. */
  head?: boolean
}) {
  const [menu, setMenu] = useState(false)
  const now = new Date(d.now)
  const chats = d.byTask.get(task.ref)
  const activity = taskActivity(chats, d.live)
  const selected = d.draftTaskId === task.ref
  const start = () => pick(task.ref)
  // The row picked for the chat being written stays in view (the list is long).
  const ref = useRef<HTMLDivElement>(null)
  // Only when it becomes the pick, never on arrival, which would scroll the composer away.
  const was = useRef(selected)
  React.useEffect(() => {
    if (selected && !was.current) ref.current?.scrollIntoView?.({ block: 'nearest' })
    was.current = selected
  }, [selected])
  return (
    <div ref={ref} className={`st-task ${compact ? 'compact' : ''} ${head ? 'head' : ''} ${selected ? 'on' : ''} ${menu ? 'menu-open' : ''}`}>
      <TaskCheck task={task} />
      <button type="button" className="st-task-main" onClick={start} title={`${task.title}: start a chat for it`}>
        <span className="st-task-title">
          <span className="st-task-name">{task.title}</span>
          {activity === 'live' ? <span className="vc-live-dot" aria-label="A chat is answering" /> : activity === 'waiting' ? <span className="vc-reply-dot" aria-label="A chat is waiting on you" /> : null}
        </span>
        <span className="st-task-sub">
          <FolderTag task={task} projects={d.projects} />
          {chats?.length && !head ? <span className="st-count">{chats.length} chat{chats.length === 1 ? '' : 's'}</span> : null}
        </span>
      </button>
      <DueTag task={task} now={now} />
      <div className="st-task-acts">
        <SnoozeButton task={task} now={now} onOpenChange={setMenu} />
        <button type="button" className="vc-thread-act" onClick={(e) => { e.stopPropagation(); start() }} aria-label={`New chat for “${task.title}”`} title="New chat for this task">
          <TI icon={IconMessagePlus} size={15} />
        </button>
      </div>
    </div>
  )
}

/** A snoozed task: when it is back, and Wake now. */
export function SnoozedLine({ task, d }: { task: WorkTask; d: TaskData }) {
  const wake = wakeOf(task)
  return (
    <div className="st-task snoozed">
      <TI icon={IconZzz} size={14} className="st-snoozed-glyph" />
      <span className="st-task-main static">
        <span className="st-task-title"><span className="st-task-name">{task.title}</span></span>
        <span className="st-task-sub">
          <FolderTag task={task} projects={d.projects} />
          {wake && <span className="st-wake">Back {wakeLabel(new Date(wake), new Date(d.now))}</span>}
        </span>
      </span>
      <div className="st-task-acts">
        <button type="button" className="vc-thread-act" onClick={() => void snoozeTask(task.ref, null)} aria-label={`Wake “${task.title}” now`} title="Wake now">
          <TI icon={IconAlarmOff} size={15} />
        </button>
      </div>
    </div>
  )
}

/** "Snoozed tasks (n)": a folding heading like the due sections', over the snoozed tasks (Wake now on each). */
export function SnoozedShelf({ d }: { d: TaskData }) {
  const [open, setOpen] = useState(false)
  if (!d.snoozed.length) return null
  return (
    <div className="tn-section snoozed">
      <button type="button" className="vc-shelf-head tn-section-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <TI icon={IconZzz} size={13} />
        <span>Snoozed tasks</span>
        <span className="vc-shelf-count">{d.snoozed.length}</span>
        <span className="vc-shelf-rule" aria-hidden />
        <TI icon={open ? IconChevronUp : IconChevronDown} size={13} />
      </button>
      {open && d.snoozed.map((t) => <SnoozedLine key={t.ref} task={t} d={d} />)}
    </div>
  )
}

/** A task with its chats in play under it: the task's row, then each chat as a slim row. */
export function TaskGroupRows({ group, d, pick, activeId, onOpen }: { group: TaskGroup; d: TaskData; pick: PickTask; activeId: string | null; onOpen: (id: string) => void }) {
  return (
    <div className="tn-group">
      <TaskLine task={group.task} d={d} pick={pick} compact head />
      <div className="tn-group-chats">
        {group.chats.map((t) => <ThreadItem key={t.id} t={t} now={d.now} active={t.id === activeId} live={!!d.runs[t.id]} onOpen={onOpen} />)}
      </div>
    </div>
  )
}

const FOLDED_KEY = 'totem.nav.folded'
const readFolded = (): TaskSectionId[] => { try { const v = JSON.parse(localStorage.getItem(FOLDED_KEY) || 'null'); return Array.isArray(v) ? v : ['later', 'undated'] } catch { return ['later', 'undated'] } }

/** Overdue, Today, Next 7 days, Later, No date: folding heads (Later and No date start folded), each over its tasks. */
export function TaskSections({ d, pick, skip }: { d: TaskData; pick: PickTask; skip?: ReadonlySet<string> }) {
  const [folded, setFolded] = useState(readFolded)
  const toggle = (id: TaskSectionId) => setFolded((cur) => {
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify(next)) } catch { /* private window */ }
    return next
  })
  return (
    <>
      {d.sections.map((s) => {
        const tasks = skip ? s.tasks.filter((t) => !skip.has(t.ref)) : s.tasks
        if (!tasks.length) return null
        const shut = folded.includes(s.id)
        // Folded, the task picked for the chat being written still shows.
        const rows = shut ? tasks.filter((t) => t.ref === d.draftTaskId) : tasks
        return (
          <div key={s.id} className={`tn-section ${s.id}`}>
            <button type="button" className="vc-shelf-head tn-section-head" onClick={() => toggle(s.id)} aria-expanded={!shut}>
              <span>{s.label}</span>
              <span className="vc-shelf-count">{tasks.length}</span>
              <span className="vc-shelf-rule" aria-hidden />
              <TI icon={shut ? IconChevronDown : IconChevronUp} size={13} />
            </button>
            {rows.map((t) => <TaskLine key={t.ref} task={t} d={d} pick={pick} compact />)}
          </div>
        )
      })}
    </>
  )
}

/** A two-way switch at the top of the panel. */
export function NavSeg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: React.ReactNode; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tn-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)} title={o.title}>{o.label}</button>
      ))}
    </div>
  )
}
