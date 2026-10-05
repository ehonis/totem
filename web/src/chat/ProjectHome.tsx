import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  useChat, loadProject, updateProject, saveProjectMemory, addProjectFiles, removeProjectFiles, deleteProject, openArtifact,
  setActive, threadTitle, threadChoice, groupThreads, openProject, foldersOf, moveMemoryUp, moveFilesUp,
} from './store'
import { memoryEntries } from './memoryEntries'
import { uploadFile } from './api'
import { ARTIFACT_PREVIEWABLE, artifactIcon } from './ArtifactPanel'
import ModelPicker from './ModelPicker'
import ProjectIcon, { PROJECT_ICONS } from './ProjectIcon'
import ThreadIcon from './ThreadIcon'
import { THREAD_ICONS } from './threadIcons.gen'
import { normalizeModelSettings } from './models'
import type { Project, ProjectFile } from './types'
import { TI, formatBytes } from './ui'
import { IconUpload, IconTrash, IconExternalLink, IconPaperclip, IconFolderUp, IconChevronRight } from './icons'
import { pushError, pushToast } from '../toast'

// A project's own page: what shows in the chat pane when a project is open and
// no chat is. The composer on top starts a chat in the project; below it, the
// tabs hold what the project's chats share.

type Tab = 'chats' | 'files' | 'instructions' | 'memory' | 'settings'
const TABS: { id: Tab; label: string }[] = [
  { id: 'chats', label: 'Chats' },
  { id: 'files', label: 'Files' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
]

const SOURCE_LABEL: Record<ProjectFile['source'], string> = { upload: 'Uploaded', chat: 'From a chat', agent: 'Made by Totem' }
type SourceFilter = 'all' | ProjectFile['source']

function when(ts: number) {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

function ChatsTab({ project }: { project: Project }) {
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const all = useChat((s) => s.projects)
  const folders = useMemo(() => foldersOf(all, project.id), [all, project.id])
  const mine = useMemo(() => threads.filter((t) => t.projectId === project.id && t.messages.length), [threads, project.id])
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
      {groupThreads(mine).map((g) => (
        <div key={g.label}>
          <div className="vc-proj-group">{g.label}</div>
          {g.threads.map((t) => {
            const last = [...t.messages].reverse().find((m) => m.role === 'assistant' && m.content)
            return (
              <button key={t.id} type="button" className="vc-proj-chat" onClick={() => setActive(t.id)}>
                <ThreadIcon t={t} size={17} />
                <span className="vc-proj-chat-text">
                  <span className="vc-proj-chat-title">
                    {threadTitle(t)}
                    {runs[t.id] ? <span className="vc-live-dot" aria-label="Answering" /> : t.needsReply && <span className="vc-reply-dot" aria-label="Waiting on you" />}
                  </span>
                  {last && <span className="vc-proj-chat-sub">{last.content.replace(/[#*_`>|[\]()!]/g, '').replace(/\s+/g, ' ').slice(0, 140)}</span>}
                </span>
                <span className="vc-proj-chat-when">{when(t.updatedAt)}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function FilesTab({ project, maxUploadBytes }: { project: Project; maxUploadBytes?: number }) {
  const threads = useChat((s) => s.threads)
  const parent = useChat((s) => (project.parentId ? s.projects.find((p) => p.id === project.parentId) : undefined))
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState<{ name: string; progress: number }[]>([])
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const files = useMemo(() => [...(project.files || [])].sort((a, b) => b.addedAt - a.addedAt), [project.files])
  const shown = filter === 'all' ? files : files.filter((f) => f.source === filter)
  const counts = useMemo(() => files.reduce((acc, f) => ({ ...acc, [f.source]: (acc[f.source] || 0) + 1 }), {} as Record<string, number>), [files])
  useEffect(() => { setPicked((p) => new Set([...p].filter((id) => files.some((f) => f.id === id)))) }, [files])

  async function upload(list: FileList | File[]) {
    const all = Array.from(list)
    const tooBig = all.filter((f) => maxUploadBytes && f.size > maxUploadBytes)
    if (tooBig.length) pushError(`${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over ${formatBytes(maxUploadBytes!)}.`)
    const ok = all.filter((f) => !tooBig.includes(f))
    if (!ok.length) return
    setUploading(ok.map((f) => ({ name: f.name, progress: 0 })))
    const ids: string[] = []
    await Promise.all(ok.map(async (f, i) => {
      try {
        const att = await uploadFile(f, f.name, { onProgress: (p) => setUploading((u) => u.map((x, j) => (j === i ? { ...x, progress: p } : x))) })
        ids.push(att.id)
      } catch (e: any) { pushError(`${f.name}: ${e.message}`) }
    }))
    await addProjectFiles(project.id, ids)
    setUploading([])
  }

  function remove(ids: string[]) {
    if (!ids.length) return
    removeProjectFiles(project.id, ids)
    setPicked(new Set())
    pushToast(ids.length === 1 ? 'Removed the file from the project' : `Removed ${ids.length} files from the project`, 'info')
  }

  async function moveUp(ids: string[]) {
    if (!parent || !ids.length) return
    try {
      const n = await moveFilesUp(project.id, ids)
      setPicked(new Set())
      pushToast(`Moved ${n === 1 ? 'the file' : `${n} files`} to ${parent.name}`, 'info')
    } catch (e: any) { pushError(`Couldn't move the files: ${e.message}`) }
  }

  function open(f: ProjectFile) {
    if (ARTIFACT_PREVIEWABLE.test(f.mime) || f.kind === 'image') openArtifact({ uploadId: f.id, name: f.name, mime: f.mime, url: f.url, size: f.size })
    else if (f.url) window.open(f.url, '_blank', 'noopener')
  }

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allShownPicked = shown.length > 0 && shown.every((f) => picked.has(f.id))

  return (
    <div
      className={`vc-proj-files ${dragging ? 'dragging' : ''}`}
      // Files dropped here join the project, not the composer: keep the chat's own drop overlay out of it.
      onDragEnter={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) e.stopPropagation() }}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.stopPropagation(); setDragging(true) } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); if (e.dataTransfer.files?.length) upload(e.dataTransfer.files) }}
    >
      <div className="vc-proj-files-bar">
        <div className="vc-seg" role="tablist" aria-label="Show files">
          {(['all', 'upload', 'chat', 'agent'] as SourceFilter[]).map((s) => (
            <button key={s} type="button" className={filter === s ? 'on' : ''} onClick={() => setFilter(s)} disabled={s !== 'all' && !counts[s]}>
              {s === 'all' ? `All ${files.length}` : `${SOURCE_LABEL[s]} ${counts[s] || 0}`}
            </button>
          ))}
        </div>
        <span className="vc-proj-spacer" />
        {picked.size > 0 ? (
          <>
            <button type="button" className="vc-btn sm ghost" onClick={() => setPicked(new Set())}>Clear</button>
            {parent && <button type="button" className="vc-btn sm" onClick={() => moveUp([...picked])} title={`Share with all of ${parent.name}`}><TI icon={IconFolderUp} size={15} />Move {picked.size} to {parent.name}</button>}
            <button type="button" className="vc-btn sm danger" onClick={() => remove([...picked])}><TI icon={IconTrash} size={15} />Remove {picked.size}</button>
          </>
        ) : (
          <button type="button" className="vc-btn sm" onClick={() => input.current?.click()}><TI icon={IconUpload} size={15} />Add files</button>
        )}
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = '' }} />
      </div>

      {uploading.map((u) => (
        <div key={u.name} className="vc-proj-file uploading">
          <TI icon={IconPaperclip} size={18} />
          <span className="vc-proj-file-text"><span className="vc-proj-file-name">{u.name}</span><span className="vc-proj-file-sub">Uploading {Math.round(u.progress * 100)}%</span></span>
        </div>
      ))}

      {!files.length && !uploading.length && (
        <button type="button" className="vc-proj-drop" onClick={() => input.current?.click()}>
          <TI icon={IconUpload} size={22} />
          <strong>Add files to share with every chat in this {project.parentId ? 'folder' : 'project'}</strong>
          <span>Drop them here or click to choose. Files you attach in a project chat, and documents Totem makes in one, show up here too.</span>
        </button>
      )}

      {shown.length > 0 && (
        <label className="vc-proj-pickall">
          <input type="checkbox" checked={allShownPicked} onChange={() => setPicked(allShownPicked ? new Set() : new Set(shown.map((f) => f.id)))} />
          <span>Select all</span>
        </label>
      )}
      {shown.map((f) => {
        const from = f.threadId ? threads.find((t) => t.id === f.threadId) : null
        return (
          <div key={f.id} className={`vc-proj-file ${picked.has(f.id) ? 'picked' : ''}`}>
            <input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} aria-label={`Select ${f.name}`} />
            <button type="button" className="vc-proj-file-main" onClick={() => open(f)} title={`Open ${f.name}`}>
              <TI icon={artifactIcon(f.mime, f.name)} size={18} />
              <span className="vc-proj-file-text">
                <span className="vc-proj-file-name">{f.name}</span>
                <span className="vc-proj-file-sub">
                  {SOURCE_LABEL[f.source]} · {formatBytes(f.size)} · {when(f.addedAt)}
                  {from && <> · <a href={`?project=${project.id}&thread=${from.id}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActive(from.id) }}>{threadTitle(from)}</a></>}
                </span>
              </span>
            </button>
            {f.url && (
              <a className="vc-icon-btn sm" href={`${f.url}&download`} aria-label={`Download ${f.name}`} title="Download"><TI icon={IconExternalLink} size={15} /></a>
            )}
            <button type="button" className="vc-icon-btn sm" onClick={() => remove([f.id])} aria-label={`Remove ${f.name}`} title="Remove from project"><TI icon={IconTrash} size={15} /></button>
          </div>
        )
      })}
      {dragging && <div className="vc-proj-dropping">Drop to add to {project.name}</div>}
    </div>
  )
}

/** A text box saved with an explicit button, so a half-written edit never goes out. */
function TextTab({ value, onSave, placeholder, intro, rows = 14, extra }: {
  value: string
  onSave: (v: string) => Promise<unknown>
  placeholder: string
  intro: React.ReactNode
  rows?: number
  extra?: (draft: string, set: (v: string) => void) => React.ReactNode
}) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const dirty = draft !== value
  // Take the server's copy when it changes underneath (the agent edited the memory) unless he is mid-edit.
  const last = useRef(value)
  useEffect(() => {
    const previous = last.current
    last.current = value
    setDraft((d) => (d === previous ? value : d))
  }, [value])
  async function save() {
    setSaving(true)
    try { await onSave(draft); pushToast('Saved', 'info') } catch (e: any) { pushError(`Couldn't save: ${e.message}`) } finally { setSaving(false) }
  }
  return (
    <div className="vc-proj-text">
      <p className="vc-proj-intro">{intro}</p>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} rows={rows} spellCheck />
      <div className="vc-proj-text-bar">
        {extra?.(draft, setDraft)}
        <span className="vc-proj-spacer" />
        {dirty && <button type="button" className="vc-btn sm ghost" onClick={() => setDraft(value)}>Discard</button>}
        <button type="button" className="vc-btn sm primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

/** A folder's memory entries with checkboxes, moved up into the parent project's memory. */
function MoveMemoryUp({ project, parent, onDone }: { project: Project; parent: Project; onDone: () => void }) {
  const entries = useMemo(() => memoryEntries(project.memory || ''), [project.memory])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [moving, setMoving] = useState(false)
  const toggle = (i: number) => setPicked((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n })
  async function move() {
    setMoving(true)
    try {
      const n = await moveMemoryUp(project.id, entries.filter((_, i) => picked.has(i)).map((e) => e.text))
      pushToast(`Moved ${n === 1 ? 'one entry' : `${n} entries`} to ${parent.name}`, 'info')
      onDone()
    } catch (e: any) { pushError(`Couldn't move the entries: ${e.message}`) } finally { setMoving(false) }
  }
  return (
    <div className="vc-proj-text">
      <p className="vc-proj-intro">Pick what the rest of {parent.name} should know. It moves into {parent.name}’s memory, under the same heading, and leaves this folder’s.</p>
      <div className="vc-mem-pick">
        {!entries.length && <p className="vc-proj-blank">This folder’s memory is empty.</p>}
        {entries.map((e, i) => (
          <React.Fragment key={i}>
            {e.heading && e.heading !== entries[i - 1]?.heading && <div className="vc-proj-group">{e.heading.replace(/^#+\s*/, '')}</div>}
            <label className={`vc-mem-entry ${picked.has(i) ? 'picked' : ''}`}>
              <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
              <span>{e.text.replace(/^\s?([-*+]|\d+[.)])\s/, '')}</span>
            </label>
          </React.Fragment>
        ))}
      </div>
      <div className="vc-proj-text-bar">
        <span className="vc-proj-spacer" />
        <button type="button" className="vc-btn sm ghost" onClick={onDone}>Cancel</button>
        <button type="button" className="vc-btn sm primary" disabled={!picked.size || moving} onClick={move}>
          <TI icon={IconFolderUp} size={15} />{moving ? 'Moving…' : picked.size ? `Move ${picked.size} to ${parent.name}` : `Move to ${parent.name}`}
        </button>
      </div>
    </div>
  )
}

function MemoryTab({ project }: { project: Project }) {
  const parent = useChat((s) => (project.parentId ? s.projects.find((p) => p.id === project.parentId) : undefined))
  const [picking, setPicking] = useState(false)
  if (picking && parent) return <MoveMemoryUp project={project} parent={parent} onDone={() => setPicking(false)} />
  const saved = project.memory || ''
  return (
    <TextTab
      value={saved}
      onSave={(v) => saveProjectMemory(project.id, v)}
      placeholder={`Nothing yet. As you chat, Totem notes decisions, facts and preferences here for the ${parent ? 'folder' : 'project'}’s other chats.`}
      intro={parent
        ? <>Totem keeps these notes for this folder’s chats only. They also read {parent.name}’s memory but never write to it. To share something with the whole project, use “Move to {parent.name}”.</>
        : 'Totem keeps these notes up to date as you work, so what one chat settles, the next one already knows. Edit or delete anything that’s wrong.'}
      rows={16}
      extra={(draft, set) => (
        <>
          {draft ? <button type="button" className="vc-btn sm ghost" onClick={() => set('')}>Clear all</button> : null}
          {parent && saved && (
            <button type="button" className="vc-btn sm" disabled={draft !== saved} title={draft !== saved ? 'Save or discard your edit first' : undefined} onClick={() => setPicking(true)}>
              <TI icon={IconFolderUp} size={15} />Move to {parent.name}…
            </button>
          )}
        </>
      )}
    />
  )
}

function SettingsTab({ project }: { project: Project }) {
  const [name, setName] = useState(project.name)
  useEffect(() => setName(project.name), [project.name])
  const choice = threadChoice(null, { provider: project.provider, modelSettings: project.modelSettings })
  const settings = normalizeModelSettings(project.modelSettings || choice.settings)

  const parent = useChat((s) => (project.parentId ? s.projects.find((p) => p.id === project.parentId) : undefined))
  const folderCount = useChat((s) => foldersOf(s.projects, project.id).length)
  const where = parent ? parent.name : 'Home'
  async function remove() {
    const chats = project.chatCount
    const folders = folderCount ? ` Its ${folderCount} folder${folderCount === 1 ? ' is' : 's are'} deleted the same way, and their chats move to Home.` : ''
    const ok = window.confirm(`Delete “${project.name}”?\n\nIts ${project.fileCount} file${project.fileCount === 1 ? '' : 's'}, instructions and memory are deleted.${chats ? ` Its ${chats} chat${chats === 1 ? '' : 's'} move to ${where}.` : ''}${folders}`)
    if (!ok) return
    try {
      const moved = await deleteProject(project.id)
      pushToast(`Deleted ${project.name}${moved ? `; ${moved} chat${moved === 1 ? '' : 's'} moved to ${where}` : ''}`, 'info')
    } catch (e: any) { pushError(`Couldn't delete it: ${e.message}`) }
  }

  return (
    <div className="vc-proj-settings">
      <label className="vc-proj-field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name.trim() !== project.name) updateProject(project.id, { name: name.trim() }); else setName(project.name) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      </label>
      <div className="vc-proj-field">
        <span>Icon</span>
        <div className="vc-proj-icons" role="radiogroup" aria-label="Project icon">
          {PROJECT_ICONS.map((icon) => (
            <button key={icon} type="button" role="radio" aria-checked={(project.icon || 'folder') === icon} className={(project.icon || 'folder') === icon ? 'on' : ''} onClick={() => updateProject(project.id, { icon })} title={icon}>
              <TI icon={THREAD_ICONS[icon]} size={18} />
            </button>
          ))}
        </div>
      </div>
      <div className="vc-proj-field">
        <span>Default model</span>
        <p className="vc-proj-hint">New chats in this project start on this. You can still change it in any one chat.</p>
        <div className="vc-proj-model">
          <ModelPicker provider={choice.provider} settings={settings} onChange={(patch) => updateProject(project.id, patch)} />
        </div>
      </div>
      <div className="vc-proj-field">
        <span>Delete {parent ? 'folder' : 'project'}</span>
        <p className="vc-proj-hint">Deletes the {parent ? 'folder' : 'project'}’s files, instructions and memory{folderCount ? ', and its folders' : ''}. Its chats are kept and move to {where}.{parent ? ` To keep a file or a note, move it to ${parent.name} first.` : ''}</p>
        <div><button type="button" className="vc-btn sm danger" onClick={remove}><TI icon={IconTrash} size={15} />Delete {parent ? 'folder' : 'project'}</button></div>
      </div>
    </div>
  )
}

export default function ProjectHome({ projectId, composer, maxUploadBytes }: { projectId: string; composer: React.ReactNode; maxUploadBytes?: number }) {
  const summary = useChat((s) => s.projects.find((p) => p.id === projectId))
  const detail = useChat((s) => s.projectDetail[projectId])
  const [tab, setTab] = useState<Tab>('chats')
  useEffect(() => { loadProject(projectId) }, [projectId])
  useEffect(() => setTab('chats'), [projectId])
  const parent = useChat((s) => (summary?.parentId ? s.projects.find((p) => p.id === summary.parentId) : undefined))
  const project = detail || (summary ? { ...summary, files: undefined } : null)
  if (!project) return <div className="vc-proj-page"><p className="vc-proj-blank">Loading the project…</p></div>

  return (
    <div className="vc-proj-page">
      <div className="vc-proj-hero">
        {parent && (
          <button type="button" className="vc-proj-crumb" onClick={() => openProject(parent.id)}>
            <ProjectIcon p={parent} size={15} /><span>{parent.name}</span><TI icon={IconChevronRight} size={13} />
          </button>
        )}
        <h1><ProjectIcon p={project} size={26} />{project.name}</h1>
        {parent && <p className="vc-proj-sub">A folder in {parent.name}. Its chats read {parent.name}’s instructions, memory and files, but what they learn stays here.</p>}
        <div className="vc-proj-composer">{composer}</div>
      </div>
      <div className="vc-proj-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'files' && project.fileCount > 0 && <span className="vc-proj-count">{project.fileCount}</span>}
            {t.id === 'chats' && project.chatCount > 0 && <span className="vc-proj-count">{project.chatCount}</span>}
          </button>
        ))}
      </div>
      <div className="vc-proj-body">
        {tab === 'chats' && <ChatsTab project={project} />}
        {tab === 'files' && (detail ? <FilesTab project={detail} maxUploadBytes={maxUploadBytes} /> : <p className="vc-proj-blank">Loading files…</p>)}
        {tab === 'instructions' && (
          <TextTab
            value={project.instructions || ''}
            onSave={(v) => updateProject(project.id, { instructions: v })}
            placeholder="e.g. This is my day job at a logistics company. Answer like a senior colleague: short, concrete, no hedging. Use British spelling."
            intro={parent
              ? `Every chat in this folder follows these, on top of ${parent.name}’s instructions.`
              : 'Every chat in this project follows these. Say who it’s for, what you’re working on, and how you want answers.'}
            rows={10}
          />
        )}
        {tab === 'memory' && (detail ? <MemoryTab project={detail} /> : <p className="vc-proj-blank">Loading memory…</p>)}
        {tab === 'settings' && <SettingsTab project={project} />}
      </div>
    </div>
  )
}
