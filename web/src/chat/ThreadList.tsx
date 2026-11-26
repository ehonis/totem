import React, { useCallback, useRef, useState } from 'react'
import { useChat, getState, linkTask, threadTitle, renameThread, setPinned, keepThread, removeThread, regenerateTitle, moveThread, markRead, markUnread, setProjectContext, settleThread, unsettleThread, snoozeThread, wakeThread } from './store'
import { attentionOf, attentionBadge, attentionTitle } from './attention'
import type { ChatThread } from './types'
import { TI, useDismiss } from './ui'
import { IconDots, IconPinned, IconPencil, IconTrash, IconCheck, IconSparkles, IconFolder, IconFolderOff, IconMail, IconMailOpened, IconClock, IconAlarmOff, IconArrowBackUp, IconChevronUp, IconChevronDown, IconPlus, IconLink, IconX, IconHome, IconCircleCheck } from './icons'
import { useRowOnScreen } from './onScreen'
import { pushToast } from '../toast'
import ThreadIcon from './ThreadIcon'
import SnoozeMenu from './SnoozeMenu'
import { discardDraft, useHasDraft } from './draftsWeb'
import { FolderPicker, TaskPicker } from '../work/pickers'
import { nextWake, wokeAt, countdown, ago, settledAt, activeAt, wakeDescription, offersSettle, taskDoneSince, type Shelf } from './settle'
import type { Project } from './types'
import ProjectIcon from './ProjectIcon'
import TaskBadge from '../work/TaskBadge'
import Spark from './Spark'

function ThreadMenu({ t, shelf, live, unsent, onRename, onSnooze, onMove, onLinkTask, onClose }: { t: ChatThread; shelf: Shelf; live: boolean; unsent: boolean; onRename: () => void; onSnooze: () => void; onMove: () => void; onLinkTask: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const inProject = useChat((s) => !!(t.projectId && s.projects.some((p) => p.id === t.projectId)))
  useDismiss(true, ref, onClose)
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
      {(t.messages.some((m) => m.role === 'user') || !!t.firstUserText) && (
        <button type="button" role="menuitem" onClick={() => { onClose(); regenerateTitle(t.id) }}><TI icon={IconSparkles} size={16} /><span>Regenerate title and icon</span></button>
      )}
      <button type="button" role="menuitem" onClick={() => { onClose(); setPinned(t.id, !t.pinned) }}><TI icon={IconPinned} size={16} /><span>{t.pinned ? 'Unpin' : 'Pin'}</span></button>
      <button type="button" role="menuitem" onClick={() => { onClose(); onMove() }}><TI icon={IconFolder} size={16} /><span>Move to…</span></button>
      <button type="button" role="menuitem" onClick={() => { onClose(); onLinkTask() }}><TI icon={IconLink} size={16} /><span>{t.taskId ? 'Change task…' : 'Link to task…'}</span></button>
      {inProject && (
        <button type="button" role="menuitem" onClick={() => { onClose(); setProjectContext(t.id, !!t.projectContextOff) }}>
          <TI icon={t.projectContextOff ? IconFolder : IconFolderOff} size={16} /><span>{t.projectContextOff ? 'Use project context' : 'Leave out project context'}</span>
        </button>
      )}
      {t.kind === 'temporary' && (
        <button type="button" role="menuitem" onClick={() => { onClose(); keepThread(t.id) }}><TI icon={IconCheck} size={16} /><span>Keep this chat</span></button>
      )}
      {unsent && (
        <button type="button" role="menuitem" onClick={() => { onClose(); discardDraft(t.id) }}><TI icon={IconX} size={16} /><span>Discard draft</span></button>
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
export function ThreadItem({ t, active, live, onOpen, shelf = 'active', now = Date.now(), card = false, place }: {
  t: ChatThread; active: boolean; live: boolean; onOpen: (id: string) => void; shelf?: Shelf; now?: number
  /**
   * T3 Code's card (the chats panel's live list): where the chat lives and what it is doing
   * on the first line, its title on the second, its linked task under them.
   */
  card?: boolean
  /** The chat's project or folder, for a card's first line; null is Home. */
  place?: { project: Project | null; label: string }
}) {
  const [menu, setMenu] = useState(false)
  const [snoozing, setSnoozing] = useState(false)
  // Move to… and Link to task… open T3 Code's picker (work/pickers.tsx) off the row's "…".
  const [picking, setPicking] = useState<'folder' | 'task' | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const closePicker = useCallback(() => setPicking(null), [])
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const retitling = useChat((s) => !!s.retitling[t.id])
  const handoff = useChat((s) => s.handoffs[t.id])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const rowRef = useRowOnScreen(t.id)
  // Words or files left unsent in it; the chat on screen shows its own in the composer.
  const unsent = useHasDraft(t.id) && !active
  // Stable, so a re-render never detaches the row the picker is placed against.
  const setRow = useCallback((node: HTMLDivElement | null) => { rowRef(node); anchorRef.current = node }, [rowRef])
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
      ? <span className="vc-thread-meta" title={t.settledOverride === 'settled' ? 'Settled' : t.doneAt ? 'Marked done, settled once read' : taskDoneSince(t) ? 'Its task was done, settled once read' : `Settled after ${autoDays} ${autoDays === 1 ? 'day' : 'days'} without activity`}>{ago(settledAt(t, now, autoDays), now)}</span>
      : null
  // What the chat waits on him for outranks everything else on the row, as in T3 (attention.ts).
  const needs = attentionOf(t, handoff)
  const unread = !!t.needsReply && !live
  const pen = unsent && <span className="vc-thread-draft" title="Unsent draft" role="img" aria-label="Unsent draft"><TI icon={IconPencil} size={13} /></span>
  // A card says what the chat is doing in words, T3's way: the one thing it waits on him
  // for, Working, Woke, Done (finished and unread), else how long since it last moved.
  const status = !card ? null
    : needs ? <span className={`sb-status sb-needs ${needs.kind}`} title={attentionTitle(needs)}>{attentionBadge(needs)}</span>
      : live ? <span className="sb-status sb-working" title="A reply is running"><Spark size={11} />Working</span>
        : woke ? <span className="sb-status sb-woke" title={`Woke ${wakeDescription(wokeAt(t, now), now)}`}><TI icon={IconAlarmOff} size={12} />Woke</span>
          : unread && !offersSettle(t, shelf, live) ? <span className="sb-status sb-done" title="Finished: waiting for you to read it"><TI icon={IconCircleCheck} size={12} />Done</span>
            : <span className="sb-status sb-time" title={new Date(activeAt(t, now)).toLocaleString()}>{ago(activeAt(t, now), now)}</span>
  const offered = offersSettle(t, shelf, live)
  const settleChip = offered && (
    <button type="button" className="vc-thread-done" onClick={stop(() => settleThread(t.id))} aria-label={`Settle ${title}`} title="Done: settles by itself once you've read it">
      <TI icon={IconCheck} size={12} />Settle
    </button>
  )
  return (
    <div ref={setRow} className={`vc-thread shelf-${shelf} ${card ? 'sb-card' : ''} ${card && offered ? 'has-settle' : ''} ${active ? 'active' : ''} ${menu || snoozing ? 'menu-open' : ''} ${unread || woke ? 'waiting' : ''} ${card && !active && !unread && !woke && !needs ? 'receded' : ''}`}>
      {card ? (
        <button type="button" className="vc-thread-main sb-card-main" onClick={() => onOpen(t.id)} title={place?.label ? `${title}\n${place.label}` : title}>
          <span className="sb-line sb-place">
            {place?.project ? <ProjectIcon p={place.project} size={12} /> : <TI icon={IconHome} size={12} className="vc-proj-icon" />}
            <span className="sb-place-name">{place?.label || 'Home'}</span>
            {t.pinned && <TI icon={IconPinned} size={11} className="sb-pin" />}
            {status}
          </span>
          <span className="sb-line sb-title-line">
            <ThreadIcon t={t} size={15} busy={retitling} />
            <span className={`vc-thread-title ${retitling ? 'vc-shimmer vc-retitling' : ''}`}>{title}</span>
            {pen}
          </span>
        </button>
      ) : (
        <button type="button" className="vc-thread-main" onClick={() => onOpen(t.id)} title={place ? `${title}\n${place.label || 'Home'}` : title}>
          <ThreadIcon t={t} size={16} busy={retitling} />
          {place ? (
            // On a shelf every project's chats are mixed: where this one lives, dim, under its title.
            <span className="sb-shelf-text">
              <span className={`vc-thread-title ${retitling ? 'vc-shimmer vc-retitling' : ''}`}>{title}</span>
              <span className="sb-shelf-place">{place.label || 'Home'}</span>
            </span>
          ) : <span className={`vc-thread-title ${retitling ? 'vc-shimmer vc-retitling' : ''}`}>{title}</span>}
          {pen}
          {needs ? <span className="vc-asking" title={attentionTitle(needs)}>{attentionBadge(needs)}</span>
            : live ? <span className="vc-live-dot" aria-label="Answering" />
            : woke ? <span className="vc-woke" title={`Woke ${wakeDescription(wokeAt(t, now), now)}`}>Woke</span>
            : t.needsReply && !offersSettle(t, shelf, live) && <span className="vc-reply-dot" aria-label="Waiting on you" title="Waiting on you" />}
          {meta}
        </button>
      )}
      {/* The chat's task, as T3 Code shows a thread's pull request: under the title, one click to its card. */}
      {card && t.taskId && (
        <div className="sb-meta">
          <TaskBadge taskRef={t.taskId} />
        </div>
      )}
      {/* The agent called the request finished (mark_chat_done): Settle in plain sight.
          On a card it sits at the end of the title line (over it, since the card is a button)
          and stays put on hover, standing in for the hover actions' own Settle. */}
      {settleChip}
      <div className="vc-thread-actions">
        {unsent && (
          <button type="button" className="vc-thread-act" aria-label={`Discard draft in ${title}`} title="Discard draft" onClick={(e) => {
            e.stopPropagation()
            // From the keyboard, focus stays on the row once its button has gone.
            const main = e.detail === 0 ? e.currentTarget.closest('.vc-thread')?.querySelector<HTMLElement>('.vc-thread-main') : null
            discardDraft(t.id)
            if (main) requestAnimationFrame(() => main.focus())
          }}>
            <TI icon={IconX} size={15} />
          </button>
        )}
        {shelf === 'active' && (
          <>
            <button type="button" className="vc-thread-act" onClick={stop(() => { setMenu(false); setSnoozing((v) => !v) })} aria-label={`Snooze ${title}`} title="Snooze">
              <TI icon={IconClock} size={15} />
            </button>
            {!(card && offered) && (
              <button type="button" className="vc-thread-act" onClick={stop(() => settleThread(t.id))} disabled={live} aria-label={`Settle ${title}`} title={live ? 'Settle once the reply finishes' : 'Settle'}>
                <TI icon={IconCheck} size={15} />
              </button>
            )}
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
      {menu && <ThreadMenu t={t} shelf={shelf} live={live} unsent={unsent} onRename={() => { setDraft(title); setEditing(true) }} onSnooze={() => { setMenu(false); setSnoozing(true) }} onMove={() => setPicking('folder')} onLinkTask={() => setPicking('task')} onClose={close} />}
      {picking === 'folder' && <FolderPicker
        open anchor={anchorRef as React.RefObject<HTMLElement>} onClose={closePicker}
        value={t.projectId || null} noneLabel="Home (no project)" label={`Move “${title}”`}
        onPick={(id) => {
          if ((t.projectId || null) === id) return
          moveThread(t.id, id)
          const p = id ? getState().projects.find((x) => x.id === id) : null
          pushToast(`Moved “${title}” to ${p ? p.name : 'Home'}`, 'info')
        }}
      />}
      {picking === 'task' && <TaskPicker
        open anchor={anchorRef as React.RefObject<HTMLElement>} onClose={closePicker}
        value={t.taskId || null} projectId={t.projectId || null}
        onPick={(ref) => linkTask(t.id, ref)}
      />}
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

export type ShelfKind = 'working' | 'snoozed' | 'settled'
const SHELF_LABEL: Record<ShelfKind, string> = { working: 'Working', snoozed: 'Snoozed', settled: 'Settled' }

/**
 * Working, Snoozed or Settled: a folding heading over its chats, remembered per scope
 * ('all', 'home' or a project id). Working starts open, so what is running is in sight;
 * Snoozed and Settled start folded. Settled shows ten at a time.
 */
export function ShelfSection({ kind, scope, threads, activeId, first, children }: {
  kind: ShelfKind
  scope: string
  threads: ChatThread[]
  activeId: string | null
  /** The first shelf in its list, which pushes the shelves to the bottom. */
  first: boolean
  children: (rows: ChatThread[]) => React.ReactNode
}) {
  const key = `${scope}:${kind}`
  const closedKey = `${scope}:${kind}:closed`
  const [open, setOpen] = useState(() => (kind === 'working' ? !readOpenShelves().has(closedKey) : readOpenShelves().has(key)))
  const [shown, setShown] = useState(SETTLED_FIRST)
  React.useEffect(() => {
    setShown(SETTLED_FIRST)
    setOpen(kind === 'working' ? !readOpenShelves().has(closedKey) : readOpenShelves().has(key))
  }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => {
    const next = readOpenShelves()
    const stored = kind === 'working' ? closedKey : key
    const storeIt = kind === 'working' ? open : !open
    if (storeIt) next.add(stored)
    else next.delete(stored)
    try { localStorage.setItem(SHELVES_KEY, JSON.stringify([...next])) } catch { /* private window */ }
    setOpen(!open)
  }
  const label = SHELF_LABEL[kind]
  // Folded, the open chat still shows, so it never vanishes from under him.
  const rows = open ? (kind === 'settled' ? threads.slice(0, shown) : threads) : threads.filter((t) => t.id === activeId)
  const hidden = open && kind === 'settled' ? threads.length - rows.length : 0
  return (
    <div className={`vc-shelf vc-shelf-${kind} ${first ? 'first' : ''}`}>
      <button type="button" className="vc-shelf-head" onClick={toggle} aria-expanded={open}>
        {kind === 'working' && threads.length > 0 && <Spark size={11} />}
        <span>{label}</span>
        <span className="vc-shelf-count">{threads.length}</span>
        <span className="vc-shelf-rule" aria-hidden />
        <TI icon={open ? IconChevronUp : IconChevronDown} size={13} />
      </button>
      {children(rows)}
      {hidden > 0 && (
        <button type="button" className="vc-shelf-more" onClick={() => setShown((n) => n + SETTLED_PAGE)}>
          <TI icon={IconPlus} size={14} /><span>Show {Math.min(hidden, SETTLED_PAGE)} more</span>
        </button>
      )}
    </div>
  )
}
