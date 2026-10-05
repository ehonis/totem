import React, { useState } from 'react'
import { useChat, openProject, createProject, setActive } from './store'
import ProjectIcon from './ProjectIcon'
import { TI } from './ui'
import { IconFolderPlus, IconArrowLeft, IconChevronDown, IconChevronRight } from './icons'
import { pushError } from '../toast'
import ThreadList from './ThreadList'

// The chats panel, scoped. Home is what the panel always was (every chat in no
// project) with the projects listed above it; opening a project swaps the panel
// to that project's chats, the way Claude and ChatGPT do.

const FOLDED_KEY = 'totem.projects.folded'

/** Home's list of projects, with an inline "New project" row. */
function ProjectsSection({ onOpen }: { onOpen: () => void }) {
  const projects = useChat((s) => s.projects)
  const [folded, setFolded] = useState(() => localStorage.getItem(FOLDED_KEY) === '1')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const fold = (v: boolean) => { setFolded(v); localStorage.setItem(FOLDED_KEY, v ? '1' : '0') }

  async function create() {
    const clean = name.trim()
    if (!clean || saving) { setNaming(false); return }
    setSaving(true)
    try {
      await createProject({ name: clean })
      setName('')
      setNaming(false)
      onOpen()
    } catch (e: any) {
      pushError(`Couldn't create the project: ${e.message}`)
    } finally { setSaving(false) }
  }

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
          {naming && (
            <div className="vc-thread editing">
              <input
                autoFocus
                value={name}
                disabled={saving}
                placeholder="Project name"
                aria-label="Project name"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => { if (!name.trim()) setNaming(false) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create()
                  if (e.key === 'Escape') { setName(''); setNaming(false) }
                }}
              />
            </div>
          )}
          {projects.map((p) => (
            <div key={p.id} className="vc-thread">
              <button type="button" className="vc-thread-main" onClick={() => { openProject(p.id); onOpen() }} title={p.name}>
                <ProjectIcon p={p} size={16} />
                <span className="vc-thread-title">{p.name}</span>
                {p.chatCount > 0 && <span className="vc-proj-count">{p.chatCount}</span>}
              </button>
            </div>
          ))}
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

/**
 * Everything under "New chat" in the panel and the phone drawer: Home's projects
 * and recents, or one project's header and chats.
 */
export function ChatsNav({ onOpenChat, searchSignal }: { onOpenChat: () => void; searchSignal: number }) {
  const activeId = useChat((s) => s.activeId)
  const projectId = useChat((s) => s.projectId)
  const project = useChat((s) => s.projects.find((p) => p.id === s.projectId))
  const open = (id: string) => { setActive(id); onOpenChat() }

  if (project) {
    return (
      <>
        <div className="vc-proj-head">
          <button type="button" className="vc-icon-btn sm" onClick={() => openProject(null)} aria-label="Back to all chats" title="All chats">
            <TI icon={IconArrowLeft} size={16} />
          </button>
          <button type="button" className={`vc-proj-title ${!activeId ? 'on' : ''}`} onClick={() => { openProject(project.id); onOpenChat() }} title="Project files, instructions and memory">
            <ProjectIcon p={project} size={17} />
            <span>{project.name}</span>
          </button>
        </div>
        <ThreadList activeId={activeId} onOpen={open} searchSignal={searchSignal} projectId={projectId} heading="Chats" />
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
