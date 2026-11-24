import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useChat, getState, openProject, setActive, createProject } from './store'
import ProjectIcon from './ProjectIcon'
import { TI } from './ui'
import { IconChevronDown, IconFolderPlus, IconHome, IconLayoutList, IconArrowUpRight, IconX } from './icons'
import { pushError } from '../toast'
import { ThreadItem, ShelfSection, useNow } from './ThreadList'
import ChatsPanelDrafts from './ChatsPanelDrafts'
import ComboPicker, { type ComboItem } from '../work/ComboPicker'
import { folderOrder } from '../work/groups'
import { attentionOf } from './attention'
import { keptOpenId } from './settle'
import { sidebarLists, placeLabel, scopeLabel, validScope, inScope, type SidebarScope } from './sidebar'
import type { ChatThread, Project } from './types'

// The chats panel, T3 Code's way (sidebar.ts has the rules): one list of every
// chat in every project and folder, nothing filed away out of sight. Unsent
// drafts first, then Pinned, then everything still in play (latest first), then
// the shelves at the bottom: Working (open), Snoozed and Settled (folded). Each
// live chat is a card naming where it lives and what it is doing, with its
// linked task under the title, as T3 shows a thread's pull request.
//
// The scope button narrows the list to one project (with its folders) or Home,
// the way T3's project filter does; it never moves him anywhere, and the open
// project's page is one click from it. Totems' own chats are not here: they
// live on the Totems page (the rail).

// --- the scope, shared with "New chat" -------------------------------------------
const SCOPE_KEY = 'totem.chats.scope'
const readScope = () => { try { return localStorage.getItem(SCOPE_KEY) || 'all' } catch { return 'all' } }
let scope: string = readScope()
const scopeSubs = new Set<() => void>()
export function setSidebarScope(next: SidebarScope) {
  scope = next
  try { localStorage.setItem(SCOPE_KEY, next) } catch { /* private window */ }
  scopeSubs.forEach((fn) => fn())
}
function useScope(projects: Project[]): SidebarScope {
  const raw = useSyncExternalStore((fn) => { scopeSubs.add(fn); return () => { scopeSubs.delete(fn) } }, () => scope)
  return validScope(raw, projects)
}

/** Where "New chat" starts one: the project the list is scoped to, else Home. */
export function newChatInScope() {
  const s = validScope(scope, getState().projects)
  openProject(s !== 'all' && s !== 'home' ? s : null)
}

const ALL = '__all__'
const HOME = '__home__'

/** The scope button: All chats, Home, or one project or folder, searchable, with "New project …". */
function ScopeBar({ value, projects, outside, onOpenPage }: { value: SidebarScope; projects: Project[]; outside: boolean; onOpenPage: () => void }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const project = value !== 'all' && value !== 'home' ? projects.find((p) => p.id === value) : undefined
  const items = useMemo<ComboItem[]>(() => [
    { key: ALL, label: 'All chats', icon: <TI icon={IconLayoutList} size={16} /> },
    { key: HOME, label: 'Home', icon: <TI icon={IconHome} size={16} />, muted: true },
    ...folderOrder(projects).map((p, i) => {
      const parent = p.parentId ? projects.find((x) => x.id === p.parentId) : undefined
      return { key: p.id, label: p.name, icon: <ProjectIcon p={p} size={16} />, indent: !!parent, searchDetail: parent?.name, keywords: parent?.name, section: i === 0 ? 'Projects' : undefined }
    }),
  ], [projects])
  const make = async (name: string) => {
    try { const p = await createProject({ name }, { open: false }); setSidebarScope(p.id); openProject(p.id) } catch (e: any) { pushError(`Couldn't create it: ${e.message}`) }
  }
  return (
    <div className="sb-scope">
      <button ref={btn} type="button" className={`sb-scope-btn ${value !== 'all' ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} title="Show every chat, or one project's">
        {project ? <ProjectIcon p={project} size={14} /> : <TI icon={value === 'home' ? IconHome : IconLayoutList} size={14} />}
        <span className="sb-scope-name">{scopeLabel(value, projects)}</span>
        {/* Something outside the scope is waiting on him: say so, so nothing hides behind the filter. */}
        {outside && <span className="vc-reply-dot" aria-label="A chat outside this view is waiting on you" title="A chat outside this view is waiting on you" />}
        <TI icon={IconChevronDown} size={13} className="sb-scope-chev" />
      </button>
      {project && (
        <button type="button" className="vc-icon-btn sm" onClick={() => { openProject(project.id); onOpenPage() }} aria-label={`Open ${project.name}`} title={`${project.name}: files, instructions and memory`}>
          <TI icon={IconArrowUpRight} size={15} />
        </button>
      )}
      {value !== 'all' && (
        <button type="button" className="vc-icon-btn sm" onClick={() => setSidebarScope('all')} aria-label="Show all chats" title="Show all chats">
          <TI icon={IconX} size={14} />
        </button>
      )}
      <ComboPicker
        open={open} anchor={btn as React.RefObject<HTMLElement>} onClose={close} label="Show chats in"
        items={items} value={value === 'all' ? ALL : value === 'home' ? HOME : value}
        placeholder="Search projects…" empty="No matching projects."
        onPick={(key) => setSidebarScope(key === ALL ? 'all' : key === HOME ? 'home' : key)}
        create={(q) => [{ key: 'new-project', label: `New project “${q}”`, icon: <TI icon={IconFolderPlus} size={16} /> }]}
        onAction={(key, q) => { if (key === 'new-project' && q) void make(q) }}
      />
    </div>
  )
}

/**
 * Everything under "New chat" in the panel and the phone drawer. `chatShowing`: the chat page is
 * on screen, so the open chat is in sight and keeps its place (settle.ts keptOpenId); on another
 * page it is just the chat last opened, and settles like any other.
 */
export function ChatsNav({ onOpenChat, chatShowing = true }: { onOpenChat: () => void; chatShowing?: boolean }) {
  const threads = useChat((s) => s.threads)
  const projects = useChat((s) => s.projects)
  const runs = useChat((s) => s.runs)
  const handoffs = useChat((s) => s.handoffs)
  const activeId = useChat((s) => s.activeId)
  const openedSettled = useChat((s) => s.openedSettled)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const loaded = useChat((s) => s.loaded)
  const scoped = useScope(projects)
  const now = useNow(threads)
  const open = useCallback((id: string) => { setActive(id); onOpenChat() }, [onOpenChat])
  const live = useCallback((id: string) => !!runs[id], [runs])
  const needsYou = useCallback((t: ChatThread) => !!attentionOf(t, handoffs[t.id]), [handoffs])
  const lists = useMemo(
    () => sidebarLists(threads, { now, autoDays, live, needsYou, openId: chatShowing ? keptOpenId(activeId, openedSettled) : null, activeId, scope: scoped, projects }),
    [threads, now, autoDays, live, needsYou, activeId, openedSettled, chatShowing, scoped, projects],
  )
  // Waiting on him somewhere the scope hides (finished and unread, or asking).
  const outside = useMemo(() => scoped !== 'all' && threads.some((t) => !t.totemId && !inScope(t, scoped, projects) && ((t.needsReply && !runs[t.id]) || !!attentionOf(t, handoffs[t.id]))), [threads, scoped, projects, runs, handoffs])
  const card = (t: ChatThread) => {
    const project = t.projectId ? projects.find((p) => p.id === t.projectId) || null : null
    return <ThreadItem key={t.id} t={t} card now={now} active={t.id === activeId} live={!!runs[t.id]} onOpen={open} place={{ project, label: placeLabel(t, projects) }} />
  }
  const slim = (shelf: 'snoozed' | 'settled') => (t: ChatThread) => {
    const project = t.projectId ? projects.find((p) => p.id === t.projectId) || null : null
    return <ThreadItem key={t.id} t={t} shelf={shelf} now={now} active={t.id === activeId} live={!!runs[t.id]} onOpen={open} place={{ project, label: placeLabel(t, projects) }} />
  }
  const { pinned, inbox, working, snoozed, settled } = lists
  const nothing = !pinned.length && !inbox.length && !working.length
  const draftsProject = scoped !== 'all' && scoped !== 'home' ? scoped : null
  return (
    <div className="vc-threads sb-panel">
      <ScopeBar value={scoped} projects={projects} outside={outside} onOpenPage={onOpenChat} />
      <div className="vc-threads-list sb-list">
        <ChatsPanelDrafts projectId={draftsProject} homeOnly={scoped === 'home'} onOpen={onOpenChat} />
        {pinned.length > 0 && <div className="sb-pinned" aria-label="Pinned">{pinned.map(card)}</div>}
        {pinned.length > 0 && inbox.length > 0 && <div className="sb-divider" role="separator" />}
        {inbox.map(card)}
        {loaded && nothing && (
          <div className="vc-threads-empty">
            {snoozed.length || settled.length ? 'All settled. Nothing is waiting on you.' : scoped === 'all' ? 'Your chats will show up here.' : 'Chats here will show up in this list.'}
          </div>
        )}
        {working.length > 0 && (
          <ShelfSection kind="working" scope={scoped} threads={working} activeId={activeId} first>
            {(rows) => rows.map(card)}
          </ShelfSection>
        )}
        {snoozed.length > 0 && (
          <ShelfSection kind="snoozed" scope={scoped} threads={snoozed} activeId={activeId} first={!working.length}>
            {(rows) => rows.map(slim('snoozed'))}
          </ShelfSection>
        )}
        {settled.length > 0 && (
          <ShelfSection kind="settled" scope={scoped} threads={settled} activeId={activeId} first={!working.length && !snoozed.length}>
            {(rows) => rows.map(slim('settled'))}
          </ShelfSection>
        )}
      </div>
    </div>
  )
}
