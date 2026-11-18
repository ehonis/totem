import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChat, getState, setActive, startTaskDraft, linkTask, threadTitle } from '../chat/store'
import ProjectIcon from '../chat/ProjectIcon'
import { ThreadItem } from '../chat/ThreadList'
import { TI, useDismiss, usePopoverPlacement } from '../chat/ui'
import {
  IconArrowsSort, IconChevronDown, IconChevronRight, IconCircle, IconCircleCheck, IconDots, IconEdit, IconExternalLink,
  IconFolder, IconPlus, IconSearch, IconTable, IconX, IconCheck, IconUser, IconAdjustmentsHorizontal, IconZzz,
} from '../chat/icons'
import { useThreadTaskDrop } from '../chat/dnd'
import { pushToast } from '../toast'
import { SnoozeMenu } from '../todos/TaskMenus'
import '../todos/todos.css'
import { buildWork, dueLabel, folderOf, matches, snoozeSubject, type WorkGroup, type WorkGroupBy, type WorkRow, type WorkShow, type WorkSort, type WorkTask } from './groups'
import { FolderPicker } from './pickers'
import AddTask from './AddTask'
import { completeTask, findTask, setTaskFolder, snoozeTask, taskHome, useWork } from './state'
import { openTaskCard, useTaskCard } from './card'
import { folderLabel, PERSONAL } from '../todos/folders'
import './work.css'

// The chats panel's third face, beside Chats and Totems: the owner's open tasks
// and the shared sheet's action items, grouped by the chat project or folder each
// is filed under (the same folders the Tasks page shows; unfiled is Personal),
// each with the chats that work on it right below. A click on a task opens its
// card (TaskCard.tsx), where every setting is edited; the count beside it unfolds
// its chats. A local task's row also snoozes it in one click (the zzz on hover).

const VIEW_KEY = 'totem.work.view'
const FOLDED_KEY = 'totem.work.folded'
const OPEN_KEY = 'totem.work.open'
const ADD_FOLDER_KEY = 'totem.work.addFolder'

interface View { sort: WorkSort; groupBy: WorkGroupBy; show: WorkShow; sheet: boolean }
const DEFAULT_VIEW: View = { sort: 'due', groupBy: 'folder', show: 'all', sheet: true }

function readJson<T>(key: string, fallback: T): T {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback } catch { return fallback }
}
function writeJson(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* private window */ } }

function useStoredSet(key: string): [Set<string>, (id: string, on?: boolean) => void] {
  const [set, setSet] = useState(() => new Set<string>(readJson<string[]>(key, [])))
  const toggle = useCallback((id: string, on?: boolean) => setSet((cur) => {
    const next = new Set(cur)
    if (on ?? !next.has(id)) next.add(id)
    else next.delete(id)
    writeJson(key, [...next])
    return next
  }), [key])
  return [set, toggle]
}

const SORTS: Array<[WorkSort, string]> = [['due', 'Due date'], ['priority', 'Priority'], ['activity', 'Recent activity'], ['title', 'Name']]
const SHOWS: Array<[WorkShow, string]> = [['all', 'All'], ['linked', 'With chats'], ['unlinked', 'No chats']]

/** Sort, group and filter, T3 Code's sidebar menu. */
function ViewMenu({ view, onView, hasSheet, sheetName }: { view: View; onView: (v: View) => void; hasSheet: boolean; sheetName: string }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, [pop, btn] as React.RefObject<HTMLElement>[], close)
  const placement = usePopoverPlacement(open, btn, { width: 236, height: 420, gap: 4, align: 'end', narrow: 0, fit: true, minHeight: 160 })
  const changed = view.sort !== DEFAULT_VIEW.sort || view.groupBy !== DEFAULT_VIEW.groupBy || view.show !== DEFAULT_VIEW.show || view.sheet !== DEFAULT_VIEW.sheet
  return (
    <>
      <button ref={btn} type="button" className={`vc-icon-btn sm ${open || changed ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-label="Sort and filter" title="Sort and filter" aria-expanded={open}>
        <TI icon={IconArrowsSort} size={15} />
      </button>
      {open && placement && createPortal(
        <div ref={pop} className="vc-menu wk-view-menu" style={placement.style} role="menu">
          <div className="vc-menu-label">Sort by</div>
          {SORTS.map(([id, label]) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={view.sort === id} onClick={() => onView({ ...view, sort: id })}>
              <span>{label}</span>{view.sort === id && <TI icon={IconCheck} size={15} className="vc-menu-check" />}
            </button>
          ))}
          <div className="vc-menu-sep" />
          <div className="vc-menu-label">Group</div>
          <div className="vc-seg">
            <button type="button" className={view.groupBy === 'folder' ? 'on' : ''} onClick={() => onView({ ...view, groupBy: 'folder' })}>By folder</button>
            <button type="button" className={view.groupBy === 'none' ? 'on' : ''} onClick={() => onView({ ...view, groupBy: 'none' })}>One list</button>
          </div>
          <div className="vc-menu-label">Show</div>
          <div className="vc-seg">
            {SHOWS.map(([id, label]) => <button key={id} type="button" className={view.show === id ? 'on' : ''} onClick={() => onView({ ...view, show: id })}>{label}</button>)}
          </div>
          {hasSheet && (
            <button type="button" role="menuitemcheckbox" aria-checked={view.sheet} onClick={() => onView({ ...view, sheet: !view.sheet })}>
              <TI icon={IconTable} size={16} /><span className="wk-menu-grow">{sheetName}</span>{view.sheet && <TI icon={IconCheck} size={15} className="vc-menu-check" />}
            </button>
          )}
          {changed && (
            <>
              <div className="vc-menu-sep" />
              <button type="button" className="muted" onClick={() => { onView(DEFAULT_VIEW); close() }}>Reset view</button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

function RowMenu({ row, anchor, onClose, onNewChat, onFile, onEdit }: { row: WorkRow; anchor: React.RefObject<HTMLElement>; onClose: () => void; onNewChat: () => void; onFile: () => void; onEdit: () => void }) {
  const pop = useRef<HTMLDivElement>(null)
  useDismiss(true, [pop, anchor] as React.RefObject<HTMLElement>[], onClose)
  const placement = usePopoverPlacement(true, anchor, { width: 220, height: 260, gap: 2, align: 'end', narrow: 0, fit: true, minHeight: 120 })
  if (!placement) return null
  const { task } = row
  return createPortal(
    <div ref={pop} className="vc-menu wk-row-menu" style={placement.style} role="menu">
      <button type="button" role="menuitem" onClick={() => { onClose(); onEdit() }}><TI icon={IconAdjustmentsHorizontal} size={16} /><span>{row.task.kind === 'local' ? 'Edit task…' : 'Details…'}</span></button>
      <button type="button" role="menuitem" onClick={() => { onClose(); onNewChat() }}><TI icon={IconEdit} size={16} /><span>New chat for this task</span></button>
      <button type="button" role="menuitem" onClick={() => { onClose(); onFile() }}><TI icon={IconFolder} size={16} /><span>Move to folder…</span></button>
      <button type="button" role="menuitem" onClick={() => { onClose(); void completeTask(task.ref) }}><TI icon={IconCircleCheck} size={16} /><span>{task.kind === 'local' ? 'Mark done' : 'Mark done for me'}</span></button>
      {task.kind === 'sheet' && task.url && <button type="button" role="menuitem" onClick={() => { onClose(); window.open(task.url, '_blank', 'noopener') }}><TI icon={IconExternalLink} size={16} /><span>Open in the sheet</span></button>}
    </div>,
    document.body,
  )
}

function TaskRow({ row, open, onToggle, onOpenChat, activeId, runs }: {
  row: WorkRow; open: boolean; onToggle: () => void; onOpenChat: () => void; activeId: string | null; runs: Record<string, unknown>
}) {
  const { task, chats } = row
  const [menu, setMenu] = useState(false)
  const [filing, setFiling] = useState(false)
  const [snoozing, setSnoozing] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const snoozeRef = useRef<HTMLButtonElement>(null)
  // The folder picker hangs off the row: the "…" it came from hides once the menu closes.
  const rowRef = useRef<HTMLDivElement>(null)
  const projects = useChat((s) => s.projects)
  const folder = folderOf(task, projects)?.id ?? null
  const carded = useTaskCard() === task.ref
  // A card opened from elsewhere (the composer's task strip) brings its row into view.
  useEffect(() => { if (carded) rowRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [carded])
  const draftFor = useChat((s) => (!s.activeId ? s.draftTaskId : null))
  const now = new Date()
  const due = dueLabel(task.dueDate, now)
  const holdsActive = chats.some((c) => c.id === activeId)
  const live = chats.some((c) => runs[c.id])
  const waiting = chats.some((c) => c.needsReply && !runs[c.id])
  const drop = useThreadTaskDrop(task.ref, (id) => {
    linkTask(id, task.ref)
    const t = getState().threads.find((c) => c.id === id)
    pushToast(`Linked ${t ? `“${threadTitle(t)}”` : 'the chat'} to “${task.title}”`, 'info')
  })
  const newChat = () => { startTaskDraft(task.ref, taskHome(task.ref)); onOpenChat() }
  const openChat = (id: string) => { setActive(id); onOpenChat() }
  return (
    <div className={`wk-task ${open ? 'open' : ''} ${drop.over ? 'drop-over' : ''}`} {...drop.props}>
      <div ref={rowRef} className={`vc-thread wk-task-row ${holdsActive && !open ? 'active' : ''} ${draftFor === task.ref || carded ? 'active' : ''} ${menu || snoozing ? 'menu-open' : ''}`}>
        {task.kind === 'local'
          ? (
            <button type="button" className={`wk-check prio-${task.priority}`} onClick={() => completeTask(task.ref)} aria-label={`Mark “${task.title}” done`} title="Mark done">
              <TI icon={IconCircle} size={16} className="wk-check-off" />
              <TI icon={IconCircleCheck} size={16} className="wk-check-on" />
            </button>
          )
          : (
            // The sheet's mark until hovered: done here is the owner's alone, the sheet is unchanged.
            <button type="button" className="wk-check sheet" onClick={() => completeTask(task.ref)} aria-label={`Mark “${task.title}” done for you (the sheet is unchanged)`} title={`${task.status ? `${task.status} on the sheet. ` : ''}Mark done for you; the sheet is unchanged`}>
              <TI icon={IconTable} size={15} className="wk-check-off" />
              <TI icon={IconCircleCheck} size={16} className="wk-check-on" />
            </button>
          )}
        <button type="button" className="vc-thread-main wk-task-main" onClick={() => openTaskCard(task.ref)} title={`${task.title}: show its settings and chats`} aria-haspopup="dialog" aria-expanded={carded}>
          <span className="vc-thread-title">{task.title}</span>
          {live ? <span className="vc-live-dot" aria-label="A chat is answering" /> : waiting ? <span className="vc-reply-dot" aria-label="A chat is waiting on you" /> : null}
          {due && <span className={`wk-due ${due.tone}`}>{due.text}</span>}
        </button>
        {chats.length > 0 && (
          <button type="button" className="wk-count" onClick={onToggle} aria-expanded={open} aria-label={`${chats.length} chats: ${open ? 'hide' : 'show'} them`} title={open ? 'Hide its chats' : 'Show its chats'}>
            <TI icon={open ? IconChevronDown : IconChevronRight} size={11} />{chats.length}
          </button>
        )}
        <div className="wk-task-acts">
          {(task.todo || task.kind === 'sheet') && <button ref={snoozeRef} type="button" className="vc-thread-act" onClick={() => setSnoozing((v) => !v)} aria-label={`Snooze “${task.title}”`} title="Snooze" aria-haspopup="menu" aria-expanded={snoozing}><TI icon={IconZzz} size={15} /></button>}
          <button type="button" className="vc-thread-act wk-act-new" onClick={newChat} aria-label="New chat for this task" title="New chat for this task"><TI icon={IconPlus} size={15} /></button>
          <button ref={moreRef} type="button" className="vc-thread-act" onClick={() => setMenu((v) => !v)} aria-label="More" title="More"><TI icon={IconDots} size={15} /></button>
        </div>
      </div>
      {menu && <RowMenu row={row} anchor={moreRef} onClose={() => setMenu(false)} onNewChat={newChat} onFile={() => setFiling(true)} onEdit={() => openTaskCard(task.ref)} />}
      {snoozing && <SnoozeMenu
        anchor={snoozeRef.current} now={now} todo={snoozeSubject(task)} onClose={() => setSnoozing(false)}
        onSnooze={(until) => void snoozeTask(task.ref, until)} onWake={() => void snoozeTask(task.ref, null)}
      />}
      {filing && <FolderPicker
        open anchor={rowRef} onClose={() => setFiling(false)}
        value={folder} noneLabel={PERSONAL} noneIcon="person" label={`File “${task.title}”`}
        onPick={(id) => { void setTaskFolder(task.ref, id) }}
      />}
      {open && chats.length > 0 && (
        <div className="wk-chats">
          {chats.map((t) => <ThreadItem key={t.id} t={t} active={t.id === activeId} live={!!runs[t.id]} onOpen={openChat} />)}
        </div>
      )}
    </div>
  )
}

function GroupHead({ group, folded, onFold, count, nested, onAdded }: { group: WorkGroup; folded: boolean; onFold: () => void; count: number; nested: boolean; onAdded: (task: WorkTask) => void }) {
  const [adding, setAdding] = useState(false)
  const name = group.project ? group.project.name : PERSONAL
  return (
    <>
      <div className="wk-group-head">
        <button type="button" className="wk-group-fold" onClick={onFold} aria-expanded={!folded} title={group.parent ? `${group.parent.name} / ${name}` : name}>
          <TI icon={folded ? IconChevronRight : IconChevronDown} size={12} className="wk-group-chev" />
          {group.project ? <ProjectIcon p={group.project} size={14} /> : <TI icon={IconUser} size={14} className="vc-proj-icon" />}
          <span className="wk-group-name">{name}</span>
          {group.parent && !nested && <span className="wk-group-parent">{group.parent.name}</span>}
          <span className="wk-group-count">{count}</span>
        </button>
        <button type="button" className="vc-icon-btn sm wk-group-add" onClick={() => setAdding(true)} aria-label={`Add a task to ${name}`} title={`Add a task to ${name}`}>
          <TI icon={IconPlus} size={14} />
        </button>
      </div>
      {adding && !folded && <AddTask folderId={group.project?.id || null} placeholder="New task…" autoFocus onAdded={onAdded} onDone={() => setAdding(false)} />}
    </>
  )
}

export default function TasksPanel({ onOpenChat }: { onOpenChat: () => void }) {
  const tasks = useWork((s) => s.tasks)
  const loaded = useWork((s) => s.loaded)
  const error = useWork((s) => s.error)
  const sheetName = useWork((s) => s.sheetName)
  const threads = useChat((s) => s.threads)
  const projects = useChat((s) => s.projects)
  const runs = useChat((s) => s.runs)
  const activeId = useChat((s) => s.activeId)
  const [view, setViewState] = useState<View>(() => ({ ...DEFAULT_VIEW, ...readJson<Partial<View>>(VIEW_KEY, {}) }))
  const setView = (v: View) => { setViewState(v); writeJson(VIEW_KEY, v) }
  const [query, setQuery] = useState('')
  const [folded, fold] = useStoredSet(FOLDED_KEY)
  const [openRows, toggleRow] = useStoredSet(OPEN_KEY)
  // Where the top line files a new task: the folder last chosen on it (Personal at first).
  const [addFolder, setAddFolderState] = useState<string | null>(() => readJson<string | null>(ADD_FOLDER_KEY, null))
  const setAddFolder = (id: string | null) => { setAddFolderState(id); writeJson(ADD_FOLDER_KEY, id) }
  // A new task shows where it went: its folder's group unfolds, and a filter that hides it says so.
  const added = (task: WorkTask) => {
    const group = folderOf(task, getState().projects)?.id || '__none__'
    if (folded.has(group)) fold(group, false)
    // A new task has no chats yet.
    if (view.show === 'linked' || !matches(task, [], query)) pushToast(`Added “${task.title}” to ${folderLabel(task.folderId, getState().projects)}. The filter hides it.`, 'info')
  }

  const shown = useMemo(() => (view.sheet ? tasks : tasks.filter((t) => t.kind !== 'sheet')), [tasks, view.sheet])
  const groups = useMemo(
    () => buildWork(shown, threads, projects, { sort: view.sort, groupBy: view.groupBy, show: view.show, query }),
    [shown, threads, projects, view, query],
  )
  // The open chat's task unfolds, so switching chats keeps you oriented.
  const activeStored = useChat((s) => s.threads.find((t) => t.id === s.activeId)?.taskId || null)
  const activeTask = activeStored ? findTask(activeStored)?.ref || null : null
  useEffect(() => { if (activeTask) toggleRow(activeTask, true) }, [activeTask, toggleRow])
  // Unfolded tasks that have since gone (done, deleted) are forgotten, so the stored set stays small.
  useEffect(() => {
    if (!loaded) return
    const live = new Set(tasks.filter((t) => !t.done).map((t) => t.ref))
    // A sheet that failed to read this time lists no rows: keep its rows' state for the next read.
    for (const ref of openRows) if (!live.has(ref) && (sheetName || !ref.startsWith('sheet:'))) toggleRow(ref, false)
  }, [loaded, tasks, sheetName]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const searching = query.trim().length > 0
  return (
    <div className="vc-threads wk-panel">
      <div className="wk-toolbar">
        <label className="wk-search">
          <TI icon={IconSearch} size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tasks and chats" aria-label="Filter tasks and chats" onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }} />
          {query && <button type="button" className="wk-search-clear" onClick={() => setQuery('')} aria-label="Clear the filter"><TI icon={IconX} size={13} /></button>}
        </label>
        <ViewMenu view={view} onView={setView} hasSheet={!!sheetName} sheetName={sheetName} />
      </div>
      <AddTask folderId={addFolder} onFolder={setAddFolder} onAdded={added} />
      {/* Filter and quick-add stay pinned above the scroller. */}
      <div className="vc-threads-list">
        {!loaded && <div className="vc-nav-note">Reading your tasks…</div>}
        {loaded && error && <div className="vc-nav-note wk-error">{error}</div>}
        {loaded && !error && !total && (
          <div className="vc-nav-note">{searching ? 'Nothing matches.' : view.show === 'linked' ? 'No task has a chat yet. Start one with + on a task.' : 'No open tasks. Add one above.'}</div>
        )}
        {groups.map((g, i) => {
          const isFolded = !searching && view.groupBy === 'folder' && folded.has(g.key || '__none__')
          // A folder straight after its project's group reads as inside it.
          const nested = !!g.parent && groups[i - 1]?.key === g.parent.id
          return (
            <div key={g.key || '__none__'} className={`wk-group ${nested ? 'nested' : ''}`}>
              {view.groupBy === 'folder' && <GroupHead group={g} folded={isFolded} onFold={() => fold(g.key || '__none__')} count={g.rows.length} nested={nested} onAdded={added} />}
              {!isFolded && g.rows.map((row) => (
                <TaskRow
                  key={row.task.ref} row={row} runs={runs} activeId={activeId} onOpenChat={onOpenChat}
                  open={openRows.has(row.task.ref) || (searching && row.chats.length > 0)} onToggle={() => toggleRow(row.task.ref)}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
