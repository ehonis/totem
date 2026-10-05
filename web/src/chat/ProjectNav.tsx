import React, { useMemo, useState } from 'react'
import { useChat, openProject, createProject, setActive, foldersOf } from './store'
import ProjectIcon from './ProjectIcon'
import { TI } from './ui'
import { IconFolderPlus, IconArrowLeft, IconChevronDown, IconChevronRight } from './icons'
import { pushError } from '../toast'
import ThreadList, { ThreadItem } from './ThreadList'
import { useThreadDrop } from './dnd'
import type { Project } from './types'

// The chats panel, scoped. Home is what the panel always was (every chat in no
// project) with the projects listed above it; opening a project swaps the panel
// to that project's chats, the way Claude and ChatGPT do. A project's folders
// sit above its own chats, each opening in place to show the chats inside.
// Any of them (and Home, via the back arrow) takes a chat dragged onto it.

const FOLDED_KEY = 'totem.projects.folded'
const OPEN_FOLDERS_KEY = 'totem.projects.openFolders'

/** Some chat in these projects is waiting on the owner. */
function useWaiting(ids: string[]) {
  const key = ids.join(',')
  return useChat((s) => s.threads.some((t) => t.needsReply && !s.runs[t.id] && !!t.projectId && key.split(',').includes(t.projectId)))
}

/** A typed-in name that becomes a project or folder on Enter. */
function NameRow({ placeholder, onCreate, onCancel }: { placeholder: string; onCreate: (name: string) => Promise<unknown>; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  async function create() {
    const clean = name.trim()
    if (!clean || saving) { onCancel(); return }
    setSaving(true)
    try { await onCreate(clean); onCancel() } catch (e: any) { pushError(`Couldn't create it: ${e.message}`) } finally { setSaving(false) }
  }
  return (
    <div className="vc-thread editing">
      <input
        autoFocus
        value={name}
        disabled={saving}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (!name.trim()) onCancel() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') create()
          if (e.key === 'Escape') onCancel()
        }}
      />
    </div>
  )
}

/** One of Home's project rows: opens the project, takes a dropped chat. */
function ProjectRow({ p, onOpen }: { p: Project; onOpen: () => void }) {
  const projects = useChat((s) => s.projects)
  const waiting = useWaiting([p.id, ...foldersOf(projects, p.id).map((f) => f.id)])
  const drop = useThreadDrop(p.id, p.name)
  return (
    <div className={`vc-thread ${drop.over ? 'drop-over' : ''}`} {...drop.props}>
      <button type="button" className="vc-thread-main" onClick={() => { openProject(p.id); onOpen() }} title={p.name}>
        <ProjectIcon p={p} size={16} />
        <span className="vc-thread-title">{p.name}</span>
        {waiting && <span className="vc-reply-dot" aria-label="A chat is waiting on you" />}
        {p.chatCount > 0 && <span className="vc-proj-count">{p.chatCount}</span>}
      </button>
    </div>
  )
}

/** Home's list of projects, with an inline "New project" row. */
function ProjectsSection({ onOpen }: { onOpen: () => void }) {
  const all = useChat((s) => s.projects)
  const projects = useMemo(() => all.filter((p) => !p.parentId), [all])
  const [folded, setFolded] = useState(() => localStorage.getItem(FOLDED_KEY) === '1')
  const [naming, setNaming] = useState(false)
  const fold = (v: boolean) => { setFolded(v); localStorage.setItem(FOLDED_KEY, v ? '1' : '0') }

  return (
    <div className="vc-proj-section">
      <div className="vc-threads-head">
        <button type="button" className="vc-proj-fold" onClick={() => fold(!folded)} aria-expanded={!folded}>
          <span>Projects</span>
          <TI icon={folded ? IconChevronRight : IconChevronDown} size={13} />
        </button>
        <button type="button" className="vc-icon-btn sm" onClick={() => { fold(false); setNaming(true) }} aria-label="New project" title="New project">
          <TI icon={IconFolderPlus} size={15} />
        </button>
      </div>
      {!folded && (
        <>
          {naming && <NameRow placeholder="Project name" onCreate={async (name) => { await createProject({ name }); onOpen() }} onCancel={() => setNaming(false)} />}
          {projects.map((p) => <ProjectRow key={p.id} p={p} onOpen={onOpen} />)}
          {!projects.length && !naming && (
            <button type="button" className="vc-proj-empty" onClick={() => setNaming(true)}>
              <TI icon={IconFolderPlus} size={16} /><span>New project</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}

const readOpenFolders = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) || '[]')) } catch { return new Set<string>() } }

/** A folder in the project panel: opens its page, unfolds its chats, takes a dropped chat. */
function FolderRow({ f, open, onToggle, onOpenChat }: { f: Project; open: boolean; onToggle: () => void; onOpenChat: (id: string) => void }) {
  const activeId = useChat((s) => s.activeId)
  const scoped = useChat((s) => s.projectId === f.id && !s.activeId)
  const allThreads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const chats = useMemo(() => allThreads.filter((t) => t.projectId === f.id && (t.messages.length > 0 || t.id === activeId || runs[t.id])), [allThreads, f.id, activeId, runs])
  const waiting = useWaiting([f.id])
  const drop = useThreadDrop(f.id, f.name)
  return (
    <div className={`vc-folder ${drop.over ? 'drop-over' : ''}`} {...drop.props}>
      <div className={`vc-thread ${scoped ? 'active' : ''}`}>
        <button type="button" className="vc-folder-fold" onClick={onToggle} aria-expanded={open} aria-label={open ? `Fold ${f.name}` : `Unfold ${f.name}`}>
          <TI icon={open ? IconChevronDown : IconChevronRight} size={13} />
        </button>
        <button type="button" className="vc-thread-main vc-folder-main" onClick={() => openProject(f.id)} title={`${f.name}: files, instructions and memory`}>
          <ProjectIcon p={f} size={16} />
          <span className="vc-thread-title">{f.name}</span>
          {waiting && !open && <span className="vc-reply-dot" aria-label="A chat is waiting on you" />}
          {chats.length > 0 && <span className="vc-proj-count">{chats.length}</span>}
        </button>
      </div>
      {open && (
        <div className="vc-folder-chats">
          {chats.map((t) => <ThreadItem key={t.id} t={t} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpenChat} />)}
          {!chats.length && <div className="vc-folder-empty">Drag a chat here, or open the folder to start one.</div>}
        </div>
      )}
    </div>
  )
}

/** A project's folders, above its own chats, with an inline "New folder" row. */
function FoldersSection({ root, naming, setNaming, onOpenChat }: { root: Project; naming: boolean; setNaming: (v: boolean) => void; onOpenChat: (id: string) => void }) {
  const all = useChat((s) => s.projects)
  const folders = useMemo(() => foldersOf(all, root.id), [all, root.id])
  const activeFolder = useChat((s) => {
    const t = s.activeId ? s.threads.find((x) => x.id === s.activeId) : null
    return t?.projectId && t.projectId !== root.id ? t.projectId : s.projectId !== root.id ? s.projectId : null
  })
  const [openSet, setOpenSet] = useState(readOpenFolders)
  const toggle = (id: string) => setOpenSet((cur) => {
    const next = new Set(cur)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...next]))
    return next
  })
  if (!folders.length && !naming) return null
  return (
    <div className="vc-proj-section">
      <div className="vc-threads-head"><span>Folders</span></div>
      {naming && <NameRow placeholder="Folder name" onCreate={(name) => createProject({ name, parentId: root.id })} onCancel={() => setNaming(false)} />}
      {folders.map((f) => (
        <FolderRow key={f.id} f={f} open={openSet.has(f.id) || activeFolder === f.id} onToggle={() => toggle(f.id)} onOpenChat={onOpenChat} />
      ))}
    </div>
  )
}

/**
 * Everything under "New chat" in the panel and the phone drawer: Home's projects
 * and recents, or one project's header and chats.
 */
export function ChatsNav({ onOpenChat, searchSignal }: { onOpenChat: () => void; searchSignal: number }) {
  const activeId = useChat((s) => s.activeId)
  const scoped = useChat((s) => s.projects.find((p) => p.id === s.projectId))
  // A folder shows inside its project's panel.
  const project = useChat((s) => (scoped?.parentId ? s.projects.find((p) => p.id === scoped.parentId) : undefined)) || scoped
  const [namingFolder, setNamingFolder] = useState(false)
  const open = (id: string) => { setActive(id); onOpenChat() }
  const toHome = useThreadDrop(null, 'Home')
  const toRoot = useThreadDrop(project?.id || null, project?.name || '')

  if (project) {
    return (
      <>
        <div className="vc-proj-head">
          <button type="button" className={`vc-icon-btn sm ${toHome.over ? 'drop-over' : ''}`} onClick={() => openProject(null)} aria-label="Back to all chats" title="All chats (drop a chat here to move it to Home)" {...toHome.props}>
            <TI icon={IconArrowLeft} size={16} />
          </button>
          <button type="button" className={`vc-proj-title ${!activeId && scoped?.id === project.id ? 'on' : ''} ${toRoot.over ? 'drop-over' : ''}`} onClick={() => { openProject(project.id); onOpenChat() }} title="Project files, instructions and memory" {...toRoot.props}>
            <ProjectIcon p={project} size={17} />
            <span>{project.name}</span>
          </button>
          <button type="button" className="vc-icon-btn sm" onClick={() => setNamingFolder(true)} aria-label="New folder" title="New folder: a side topic with its own memory and files">
            <TI icon={IconFolderPlus} size={15} />
          </button>
        </div>
        <ThreadList
          activeId={activeId}
          onOpen={open}
          searchSignal={searchSignal}
          projectId={project.id}
          heading="Chats"
          before={<FoldersSection root={project} naming={namingFolder} setNaming={setNamingFolder} onOpenChat={open} />}
        />
      </>
    )
  }
  return (
    <ThreadList
      activeId={activeId}
      onOpen={open}
      searchSignal={searchSignal}
      projectId={null}
      before={<ProjectsSection onOpen={onOpenChat} />}
    />
  )
}
