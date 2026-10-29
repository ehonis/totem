import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useChat, groupThreads, threadTitle, renameThread, setPinned, keepThread, removeThread, regenerateTitle, moveThread, markRead, markUnread, setProjectContext, settleThread, unsettleThread, snoozeThread, wakeThread } from './store'
import { pendingQuestions } from './questions'
import type { ChatThread, Project } from './types'
import { TI, useDismiss } from './ui'
import { IconDots, IconPinned, IconPencil, IconTrash, IconSearch, IconX, IconCheck, IconSparkles, IconFolder, IconFolderOff, IconHome, IconChevronLeft, IconMail, IconMailOpened, IconClock, IconAlarmOff, IconArrowBackUp, IconChevronUp, IconChevronDown, IconPlus } from './icons'
import { dragThreadProps } from './dnd'
import { useRowOnScreen } from './onScreen'
import ProjectIcon from './ProjectIcon'
import { pushToast } from '../toast'
import ThreadIcon from './ThreadIcon'
import SnoozeMenu from './SnoozeMenu'
import { shelve, shelfOf, nextWake, wokeAt, countdown, ago, settledAt, wakeDescription, type Shelf } from './settle'

function MoveMenu({ t, onBack, onClose }: { t: ChatThread; onBack: () => void; onClose: () => void }) {
  const projects = useChat((s) => s.projects)
  const inProject = !!(t.projectId && projects.some((p) => p.id === t.projectId))
  const move = (p: Project) => { onClose(); moveThread(t.id, p.id); pushToast(`Moved “${threadTitle(t)}” to ${p.name}`, 'info') }
  // Each project with its folders under it.
  const rows = projects.filter((p) => !p.parentId).flatMap((p) => [{ p, folder: false }, ...projects.filter((f) => f.parentId === p.id).map((f) => ({ p: f, folder: true }))])
  return (
    <>
      <button type="button" role="menuitem" className="muted" onClick={onBack}><TI icon={IconChevronLeft} size={16} /><span>Move to…</span></button>
      <div className="vc-menu-sep" />
      {inProject && (
        <button type="button" role="menuitem" onClick={() => { onClose(); moveThread(t.id, null); pushToast(`Moved “${threadTitle(t)}” to Home`, 'info') }}>
          <TI icon={IconHome} size={16} /><span>Home (no project)</span>
        </button>
      )}
      {rows.map(({ p, folder }) => (
        <button key={p.id} type="button" role="menuitem" className={folder ? 'vc-menu-indent' : ''} disabled={p.id === t.projectId} onClick={() => move(p)}>
          <ProjectIcon p={p} size={16} /><span>{p.name}</span>
        </button>
      ))}
      {!projects.length && <div className="vc-menu-label">No projects yet. Make one from the Projects list.</div>}
    </>
  )
}

function ThreadMenu({ t, shelf, live, onRename, onSnooze, onClose }: { t: ChatThread; shelf: Shelf; live: boolean; onRename: () => void; onSnooze: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [moving, setMoving] = useState(false)
  const inProject = useChat((s) => !!(t.projectId && s.projects.some((p) => p.id === t.projectId)))
  useDismiss(true, ref, onClose)
  if (moving) {
    return (
      <div className="vc-menu vc-thread-menu" ref={ref} role="menu" onClick={(e) => e.stopPropagation()}>
        <MoveMenu t={t} onBack={() => setMoving(false)} onClose={onClose} />
      </div>
    )
  }
  return (
    <div className="vc-menu vc-thread-menu" ref={ref} role="menu" onClick={(e) => e.stopPropagation()}>
      {t.needsReply
        ? <button type="button" role="menuitem" onClick={() => { onClose(); markRead(t.id) }}><TI icon={IconMailOpened} size={16} /><span>Mark as read</span></button>
        : <button type="button" role="menuitem" onClick={() => { onClose(); markUnread(t.id) }}><TI icon={IconMail} size={16} /><span>Mark as unread</span></button>}
      {shelf === 'settled'
        ? <button type="button" role="menuitem" onClick={() => { onClose(); unsettleThread(t.id) }}><TI icon={IconArrowBackUp} size={16} /><span>Un-settle</span></button>
        : <button type="button" role="menuitem" disabled={live} onClick={() => { onClose(); settleThread(t.id) }}><TI icon={IconCheck} size={16} /><span>Settle</span></button>}
      {shelf === 'snoozed'
        ? <button type="button" role="menuitem" onClick={() => { onClose(); wakeThread(t.id) }}><TI icon={IconAlarmOff} size={16} /><span>Wake now</span></button>
        : <button type="button" role="menuitem" onClick={onSnooze}><TI icon={IconClock} size={16} /><span>Snooze…</span></button>}
      <div className="vc-menu-sep" />
      <button type="button" role="menuitem" onClick={() => { onClose(); onRename() }}><TI icon={IconPencil} size={16} /><span>Rename</span></button>
      {t.messages.some((m) => m.role === 'user') && (
        <button type="button" role="menuitem" onClick={() => { onClose(); regenerateTitle(t.id) }}><TI icon={IconSparkles} size={16} /><span>Regenerate title and icon</span></button>
      )}
      <button type="button" role="menuitem" onClick={() => { onClose(); setPinned(t.id, !t.pinned) }}><TI icon={IconPinned} size={16} /><span>{t.pinned ? 'Unpin' : 'Pin'}</span></button>
      <button type="button" role="menuitem" onClick={() => setMoving(true)}><TI icon={IconFolder} size={16} /><span>Move to…</span></button>
      {inProject && (
        <button type="button" role="menuitem" onClick={() => { onClose(); setProjectContext(t.id, !!t.projectContextOff) }}>
          <TI icon={t.projectContextOff ? IconFolder : IconFolderOff} size={16} /><span>{t.projectContextOff ? 'Use project context' : 'Leave out project context'}</span>
        </button>
      )}
      {t.kind === 'temporary' && (
        <button type="button" role="menuitem" onClick={() => { onClose(); keepThread(t.id) }}><TI icon={IconCheck} size={16} /><span>Keep this chat</span></button>
      )}
      <div className="vc-menu-sep" />
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => {
          onClose()
          removeThread(t.id)
          pushToast(`Deleted “${threadTitle(t)}”`, 'info')
        }}
      >
        <TI icon={IconTrash} size={16} /><span>Delete</span>
      </button>
    </div>
  )
}

/**
 * One chat in a list. Where it sits decides its look and its quick actions
 * (settle.ts): an active chat offers Snooze and Settle on hover; a snoozed one
 * shows the time left and Wake now; a settled one is dimmed, shows how long ago
 * it settled, and offers Un-settle.
 */
export function ThreadItem({ t, active, live, onOpen, shelf = 'active', now = Date.now() }: { t: ChatThread; active: boolean; live: boolean; onOpen: (id: string) => void; shelf?: Shelf; now?: number }) {
  const [menu, setMenu] = useState(false)
  const [snoozing, setSnoozing] = useState(false)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const retitling = useChat((s) => !!s.retitling[t.id])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const rowRef = useRowOnScreen(t.id)
  const close = useCallback(() => setMenu(false), [])
  const closeSnooze = useCallback(() => setSnoozing(false), [])
  const title = threadTitle(t)
  if (editing) {
    return (
      <div className="vc-thread editing">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft.trim() && draft.trim() !== title) renameThread(t.id, draft.trim()); setEditing(false) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') { setDraft(title); setEditing(false) }
          }}
          aria-label="Chat title"
        />
      </div>
    )
  }
  const woke = shelf === 'active' && !!wokeAt(t, now) && !active
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  // The time on the right of a parked chat, and the button that sits over it on hover.
  const meta = shelf === 'snoozed'
    ? <span className="vc-thread-meta snoozed" title={`Wakes ${wakeDescription(t.snoozedUntil!, now)}`}>{countdown(t.snoozedUntil!, now)}</span>
    : shelf === 'settled'
      ? <span className="vc-thread-meta" title={t.settledOverride === 'settled' ? 'Settled' : `Settled after ${autoDays} ${autoDays === 1 ? 'day' : 'days'} without activity`}>{ago(settledAt(t, now, autoDays), now)}</span>
      : null
  // Questions from the agent outrank everything else on the row, as in T3.
  const asking = !!pendingQuestions(t)
  return (
    <div ref={rowRef} className={`vc-thread shelf-${shelf} ${active ? 'active' : ''} ${menu || snoozing ? 'menu-open' : ''} ${(t.needsReply && !live) || woke ? 'waiting' : ''}`} {...dragThreadProps(t.id)}>
      <button type="button" className="vc-thread-main" onClick={() => onOpen(t.id)} title={title}>
        <ThreadIcon t={t} size={16} busy={retitling} />
        <span className={`vc-thread-title ${retitling ? 'vc-shimmer vc-retitling' : ''}`}>{title}</span>
        {asking ? <span className="vc-asking" title="Totem asked you questions">Awaiting input</span>
          : live ? <span className="vc-live-dot" aria-label="Answering" />
          : woke ? <span className="vc-woke" title={`Woke ${wakeDescription(wokeAt(t, now), now)}`}>Woke</span>
          : t.needsReply && <span className="vc-reply-dot" aria-label="Waiting on you" title="Waiting on you" />}
        {meta}
      </button>
      <div className="vc-thread-actions">
        {shelf === 'active' && (
          <>
            <button type="button" className="vc-thread-act" onClick={stop(() => { setMenu(false); setSnoozing((v) => !v) })} aria-label={`Snooze ${title}`} title="Snooze">
              <TI icon={IconClock} size={15} />
            </button>
            <button type="button" className="vc-thread-act" onClick={stop(() => settleThread(t.id))} disabled={live} aria-label={`Settle ${title}`} title={live ? 'Settle once the reply finishes' : 'Settle'}>
              <TI icon={IconCheck} size={15} />
            </button>
          </>
        )}
        {shelf === 'snoozed' && (
          <button type="button" className="vc-thread-act" onClick={stop(() => wakeThread(t.id))} aria-label={`Wake ${title} now`} title="Wake now">
            <TI icon={IconAlarmOff} size={15} />
          </button>
        )}
        {shelf === 'settled' && (
          <button type="button" className="vc-thread-act" onClick={stop(() => unsettleThread(t.id))} aria-label={`Un-settle ${title}`} title="Un-settle">
            <TI icon={IconArrowBackUp} size={15} />
          </button>
        )}
      </div>
      <button type="button" className="vc-thread-more" onClick={(e) => { e.stopPropagation(); setSnoozing(false); setMenu((m) => !m) }} aria-label={`Options for ${title}`}>
        <TI icon={IconDots} size={16} />
      </button>
      {menu && <ThreadMenu t={t} shelf={shelf} live={live} onRename={() => { setDraft(title); setEditing(true) }} onSnooze={() => { setMenu(false); setSnoozing(true) }} onClose={close} />}
      {snoozing && <SnoozeMenu onSnooze={(until) => snoozeThread(t.id, until)} onClose={closeSnooze} />}
    </div>
  )
}

/** The current time, ticking each minute and exactly when the next snooze runs out. */
export function useNow(threads: ChatThread[]) {
  const [now, setNow] = useState(Date.now)
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const wake = nextWake(threads, now)
  React.useEffect(() => {
    if (!wake) return
    // setTimeout overflows past 2^31-1 ms (about 24 days); the minute tick covers the rest.
    const id = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, wake - Date.now()) + 50))
    return () => clearTimeout(id)
  }, [wake])
  return now
}

const SHELVES_KEY = 'totem.chats.openShelves'
const SETTLED_FIRST = 10
const SETTLED_PAGE = 25
const readOpenShelves = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(SHELVES_KEY) || '[]')) } catch { return new Set<string>() } }

/** Snoozed or Settled: a folding heading over its chats, folded until opened (remembered per list). */
function ShelfSection({ kind, scope, threads, activeId, runs, onOpen, now, first }: {
  kind: 'snoozed' | 'settled'
  scope: string
  threads: ChatThread[]
  activeId: string | null
  runs: Record<string, unknown>
  onOpen: (id: string) => void
  now: number
  /** The first shelf in its list, which pushes the shelves to the bottom. */
  first: boolean
}) {
  const key = `${scope}:${kind}`
  const [open, setOpen] = useState(() => readOpenShelves().has(key))
  const [shown, setShown] = useState(SETTLED_FIRST)
  React.useEffect(() => { setShown(SETTLED_FIRST) }, [scope])
  const toggle = () => {
    const next = readOpenShelves()
    if (open) next.delete(key)
    else next.add(key)
    localStorage.setItem(SHELVES_KEY, JSON.stringify([...next]))
    setOpen(!open)
  }
  const label = kind === 'snoozed' ? 'Snoozed' : 'Settled'
  // Folded, the open chat still shows, so it never vanishes from under him.
  const rows = open ? (kind === 'settled' ? threads.slice(0, shown) : threads) : threads.filter((t) => t.id === activeId)
  const hidden = open && kind === 'settled' ? threads.length - rows.length : 0
  return (
    <div className={`vc-shelf vc-shelf-${kind} ${first ? 'first' : ''}`}>
      <button type="button" className="vc-shelf-head" onClick={toggle} aria-expanded={open}>
        <span>{open ? label : `${label} (${threads.length})`}</span>
        <span className="vc-shelf-rule" aria-hidden />
        <TI icon={open ? IconChevronUp : IconChevronDown} size={13} />
      </button>
      {rows.map((t) => <ThreadItem key={t.id} t={t} shelf={kind} now={now} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpen} />)}
      {hidden > 0 && (
        <button type="button" className="vc-shelf-more" onClick={() => setShown((n) => n + SETTLED_PAGE)}>
          <TI icon={IconPlus} size={14} /><span>Show {Math.min(hidden, SETTLED_PAGE)} more</span>
        </button>
      )}
    </div>
  )
}

/**
 * One list's chats on their three shelves: the active ones (drawn by the
 * caller), then Snoozed and Settled. Every list has its own (Home, a project,
 * each folder), so a settled chat stays where it lives.
 */
export function ShelvedChats({ threads, scope, activeId, onOpen, children }: {
  threads: ChatThread[]
  /** Which list this is, for remembering which shelves are open: 'home' or a project id. */
  scope: string
  activeId: string | null
  onOpen: (id: string) => void
  children: (active: ChatThread[], now: number) => React.ReactNode
}) {
  const runs = useChat((s) => s.runs)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const now = useNow(threads)
  const { active, snoozed, settled } = useMemo(() => shelve(threads, now, autoDays, (id) => !!runs[id]), [threads, now, autoDays, runs])
  return (
    <>
      {children(active, now)}
      {snoozed.length > 0 && <ShelfSection kind="snoozed" scope={scope} threads={snoozed} activeId={activeId} runs={runs} onOpen={onOpen} now={now} first />}
      {settled.length > 0 && <ShelfSection kind="settled" scope={scope} threads={settled} activeId={activeId} runs={runs} onOpen={onOpen} now={now} first={!snoozed.length} />}
    </>
  )
}

export default function ThreadList({ activeId, onOpen, limit, heading = 'Recents', searchSignal = 0, projectId = null, before }: {
  activeId: string | null
  onOpen: (id: string) => void
  limit?: number
  heading?: string
  /** Bump to open and focus the search box (the panel's magnifier). */
  searchSignal?: number
  /** Show this project's chats; null shows Home (chats in no project that still exists). */
  projectId?: string | null
  /** Rendered at the top of the scrolling list (Home's project list). */
  before?: React.ReactNode
}) {
  const allThreads = useChat((s) => s.threads)
  const projects = useChat((s) => s.projects)
  const threads = useMemo(() => {
    const known = new Set(projects.map((p) => p.id))
    // A totem's chat lives on its totem, not in Recents.
    return allThreads.filter((t) => !t.totemId && (projectId ? t.projectId === projectId : !(t.projectId && known.has(t.projectId))))
  }, [allThreads, projects, projectId])
  const runs = useChat((s) => s.runs)
  const loaded = useChat((s) => s.loaded)
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  React.useEffect(() => { if (searchSignal) setSearching(true) }, [searchSignal])

  const filtered = useMemo(() => {
    // An empty chat (opened, never sent) is not history.
    const shown = threads.filter((t) => t.messages.length > 0 || t.id === activeId || runs[t.id])
    const term = q.trim().toLowerCase()
    if (!term) return shown
    return shown.filter((t) => threadTitle(t).toLowerCase().includes(term) || t.messages.some((m) => m.content.toLowerCase().includes(term)))
  }, [threads, q, activeId, runs])
  // Searching looks through every chat, parked or not, in one list.
  const found = useMemo(() => (q ? groupThreads(filtered) : []), [filtered, q])
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const renderGroups = (groups: { label: string; threads: ChatThread[] }[], now = Date.now()) => groups.map((g) => (
    <div key={g.label} className="vc-thread-group">
      <div className="vc-thread-group-label">{g.label}</div>
      {g.threads.map((t) => <ThreadItem key={t.id} t={t} now={now} shelf={q ? shelfOf(t, now, autoDays, !!runs[t.id]) : 'active'} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpen} />)}
    </div>
  ))

  const head = (
    <>
      <div className="vc-threads-head">
        <span>{heading}</span>
        <button type="button" className="vc-icon-btn sm" onClick={() => { setSearching((s) => !s); setQ('') }} aria-label="Search chats" title="Search chats">
          <TI icon={searching ? IconX : IconSearch} size={15} />
        </button>
      </div>
      {searching && (
        <input className="vc-threads-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
      )}
    </>
  )

  // With something above the chats (Home's projects), the heading scrolls with
  // the list so it sits between the two rather than above both.
  return (
    <div className="vc-threads">
      {!before && head}
      <div className="vc-threads-list">
        {before}
        {before && head}
        {loaded && !threads.length && <div className="vc-threads-empty">{projectId ? 'Chats in this project will show up here.' : 'Your chats will show up here.'}</div>}
        {q && !filtered.length && <div className="vc-threads-empty">No chats match “{q}”.</div>}
        {q ? renderGroups(found) : (
          <ShelvedChats threads={filtered} scope={projectId || 'home'} activeId={activeId} onOpen={onOpen}>
            {(active, now) => renderGroups(groupThreads(limit ? active.slice(0, limit) : active), now)}
          </ShelvedChats>
        )}
      </div>
    </div>
  )
}
