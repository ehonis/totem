import React, { useEffect, useMemo, useState } from 'react'
import { useChat, loadProject, setActive, threadTitle, groupThreads, openProject, foldersOf } from './store'
import { attentionOf } from './attention'
import ProjectCard, { openProjectSection, sectionLandKey } from './ProjectCard'
import ProjectIcon from './ProjectIcon'
import ThreadIcon from './ThreadIcon'
import { useRowOnScreen, useProjectPage } from './onScreen'
import { shelve } from './settle'
import type { ChatThread, Project } from './types'
import { TI, when } from './ui'
import { IconChevronRight } from './icons'
import { findLanding, landKey, useLandOn } from '../landing'
import { plainRefs } from './refs'

// A project's own page: what shows in the chat pane when a project is open and
// no chat is. The composer on top starts a chat in the project; under it, the
// project's folders and chats. What those chats share (files, instructions,
// memory, model, settings) is the project's card (ProjectCard), which ChatView
// pins at the pane's top right; on a phone it sits here, under the composer.
// The composer sits in the middle of the pane, as Home's does, and the list under
// it shows the first few chats with a Show more row, so it never runs on for ever.

/** Chats a project's page shows before Show more, and how many each press adds. */
export const FIRST_CHATS = 5
export const MORE_CHATS = 20

type Group = { label: string; threads: ChatThread[] }

/** The first `limit` chats of `groups`, in order, dropping groups left empty. */
export function firstRows(groups: Group[], limit: number): Group[] {
  const out: Group[] = []
  let left = limit
  for (const g of groups) {
    if (left <= 0) break
    const threads = g.threads.slice(0, left)
    left -= threads.length
    if (threads.length) out.push({ label: g.label, threads })
  }
  return out
}

/** One chat on a project's page; on screen here counts for the running-chats panel. */
function ChatRow({ t, live, settled }: { t: ChatThread; live: boolean; settled: boolean }) {
  const ref = useRowOnScreen(t.id)
  const last = [...t.messages].reverse().find((m) => m.role === 'assistant' && m.content)
  return (
    <button ref={ref} type="button" className={`vc-proj-chat ${settled ? 'settled' : ''}`} onClick={() => setActive(t.id)}>
      <ThreadIcon t={t} size={17} />
      <span className="vc-proj-chat-text">
        <span className="vc-proj-chat-title">
          {threadTitle(t)}
          {live ? <span className="vc-live-dot" aria-label="Answering" /> : t.needsReply && <span className="vc-reply-dot" aria-label="Waiting on you" />}
        </span>
        {last && <span className="vc-proj-chat-sub">{plainRefs(last.content).replace(/[#*_`>|[\]()!]/g, '').replace(/\s+/g, ' ').slice(0, 140)}</span>}
      </span>
      <span className="vc-proj-chat-when">{when(t.updatedAt)}</span>
    </button>
  )
}

function ProjectChats({ project }: { project: Project }) {
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const all = useChat((s) => s.projects)
  const folders = useMemo(() => foldersOf(all, project.id), [all, project.id])
  const mine = useMemo(() => threads.filter((t) => t.projectId === project.id && t.messages.length), [threads, project.id])
  // Parked chats come last, under their own headings, as in the panel (settle.ts).
  const autoSettleDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const handoffs = useChat((s) => s.handoffs)
  // A chat waiting on him stays in play here too, as in the panel (sidebar.ts).
  const shelves = useMemo(() => shelve(mine, Date.now(), autoSettleDays, (id) => !!runs[id], null, (t) => !!attentionOf(t, handoffs[t.id])), [mine, autoSettleDays, runs, handoffs])
  const [limit, setLimit] = useState(FIRST_CHATS)
  // Folded, the open chats share one heading (date headings over five rows would push
  // the composer off the middle); Snoozed and Settled keep theirs. Show more brings the
  // date headings back.
  const shown = useMemo(() => {
    const shelved = [{ label: 'Snoozed', threads: shelves.snoozed }, { label: 'Settled', threads: shelves.settled }]
    const dated = groupThreads(shelves.active)
    const open = limit > FIRST_CHATS ? dated : [{ label: 'Chats', threads: dated.flatMap((g) => g.threads) }]
    return firstRows([...open, ...shelved], limit)
  }, [shelves, limit])
  const hidden = Math.max(0, mine.length - limit)
  const fewer = limit > FIRST_CHATS && mine.length > FIRST_CHATS
  const folderRows = folders.length > 0 && (
    <div>
      <div className="vc-proj-group">Folders</div>
      {folders.map((f) => (
        <button key={f.id} type="button" className="vc-proj-chat" onClick={() => openProject(f.id)}>
          <ProjectIcon p={f} size={17} />
          <span className="vc-proj-chat-text"><span className="vc-proj-chat-title">{f.name}</span></span>
          <span className="vc-proj-chat-when">{f.chatCount} chat{f.chatCount === 1 ? '' : 's'}</span>
          <TI icon={IconChevronRight} size={15} />
        </button>
      ))}
    </div>
  )
  if (!mine.length) {
    return (
      <div className="vc-proj-chats">
        {folderRows}
        <p className="vc-proj-blank">No chats yet. Ask something above and it starts here, with this {project.parentId ? 'folder' : 'project'}’s files, instructions and memory.</p>
      </div>
    )
  }
  return (
    <div className="vc-proj-chats">
      {folderRows}
      {shown.map((g) => (
        <div key={g.label}>
          <div className="vc-proj-group">{g.label}</div>
          {g.threads.map((t) => <ChatRow key={t.id} t={t} live={!!runs[t.id]} settled={g.label === 'Settled'} />)}
        </div>
      ))}
      {(hidden > 0 || fewer) && (
        <div className="vc-proj-more">
          {hidden > 0 && (
            <button type="button" onClick={() => setLimit((n) => n + MORE_CHATS)}>
              Show {Math.min(hidden, MORE_CHATS)} more
            </button>
          )}
          {fewer && <button type="button" onClick={() => setLimit(FIRST_CHATS)}>Show fewer</button>}
          <span className="vc-proj-more-count">{mine.length} chats</span>
        </div>
      )}
    </div>
  )
}

/** `cardInline`: the project's card goes in the page (a phone); otherwise ChatView pins it. */
export default function ProjectHome({ projectId, composer, maxUploadBytes, cardInline = false }: { projectId: string; composer: React.ReactNode; maxUploadBytes?: number; cardInline?: boolean }) {
  const summary = useChat((s) => s.projects.find((p) => p.id === projectId))
  const detail = useChat((s) => s.projectDetail[projectId])
  useProjectPage(projectId)
  useEffect(() => { loadProject(projectId) }, [projectId])
  // A search hit on the project's instructions or memory opens that row of its card and flashes it (landing.ts).
  useLandOn('project', {
    prepare: ({ id, extra }) => { if (id === projectId && (extra.section === 'instructions' || extra.section === 'memory')) openProjectSection(id, extra.section) },
    find: ({ id, extra }) => {
      if (id !== projectId) return null
      return extra.section === 'instructions' || extra.section === 'memory' ? findLanding(sectionLandKey(id, extra.section)) : findLanding(landKey('project', id))
    },
  })
  const parent = useChat((s) => (summary?.parentId ? s.projects.find((p) => p.id === summary.parentId) : undefined))
  const project = detail || (summary ? { ...summary, files: undefined } : null)
  if (!project) return <div className="vc-proj-page loading"><p className="vc-proj-blank">Loading the project…</p></div>

  return (
    <div className="vc-proj-page">
      <div className="vc-proj-hero" data-land={landKey('project', project.id)}>
        {parent && (
          <button type="button" className="vc-proj-crumb" onClick={() => openProject(parent.id)}>
            <ProjectIcon p={parent} size={15} /><span>{parent.name}</span><TI icon={IconChevronRight} size={13} />
          </button>
        )}
        <h1><ProjectIcon p={project} size={26} />{project.name}</h1>
        {parent && <p className="vc-proj-sub">A folder in {parent.name}. Its chats read {parent.name}’s instructions, memory and files, but what they learn stays here.</p>}
        <div className="vc-proj-composer">{composer}</div>
      </div>
      {cardInline && <ProjectCard projectId={project.id} mode="inline" maxUploadBytes={maxUploadBytes} />}
      <ProjectChats key={project.id} project={project} />
    </div>
  )
}
