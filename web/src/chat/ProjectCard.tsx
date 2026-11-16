import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  useChat, updateProject, saveProjectMemory, addProjectFiles, removeProjectFiles, deleteProject, openArtifact,
  setActive, threadTitle, threadChoice, foldersOf, moveMemoryUp, moveFilesUp, setProjectFavicon,
} from './store'
import { memoryEntries } from './memoryEntries'
import { uploadFile } from './api'
import { ARTIFACT_PREVIEWABLE, artifactIcon } from './ArtifactPanel'
import ModelPicker, { chipLabel } from './ModelPicker'
import ProjectIcon, { PROJECT_ICONS } from './ProjectIcon'
import { THREAD_ICONS } from './threadIcons.gen'
import type { Project, ProjectFile } from './types'
import { TI, formatBytes, when } from './ui'
import {
  IconUpload, IconTrash, IconExternalLink, IconPaperclip, IconFolderUp, IconWorld, IconX,
  IconBrain, IconChevronDown, IconChevronUp, IconFiles, IconFileText, IconSettings, IconSparkles,
} from './icons'
import { usePinFold } from './pins'
import { pushError, pushToast } from '../toast'
import { downloads } from '../downloads'
import { LANDING_TIMEOUT_MS, landKey } from '../landing'
import '../work/work.css'

// A project's or folder's card, T3 Code's thread card for the place a chat lives:
// its name, then one row per thing its chats share (files, instructions, memory,
// default model, settings), each opening under its row, one at a time. On the
// place's own page (ProjectHome) it is pinned at the chat pane's top right, over
// the chat's task card when a new chat is being started from a task (ChatView
// stacks both in `.vc-pins`); it folds to its name like the task card. On a phone
// it sits in the page, under the composer.

export type CardSection = 'files' | 'instructions' | 'memory' | 'model' | 'settings'

const PIN_FOLD_KEY = 'totem.projectPin.folded'

// A section asked for from outside (a search hit on the instructions or memory).
// Kept until a card for that place takes it, since the card may mount after the ask.
// It lapses with the landing that asked (LANDING_TIMEOUT_MS), so a later visit opens nothing unasked.
let asked: { projectId: string; section: CardSection; at: number } | null = null
const askSubs = new Set<() => void>()
export function openProjectSection(projectId: string, section: CardSection, now = Date.now()) {
  asked = { projectId, section, at: now }
  for (const fn of askSubs) fn()
}
const subscribeAsk = (fn: () => void) => { askSubs.add(fn); return () => { askSubs.delete(fn) } }

/** Where a search hit on a section lands: the open section carries this key. */
export const sectionLandKey = (projectId: string, section: CardSection) => landKey('project-section', `${projectId}:${section}`)

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

interface CardProps { projectId: string; mode: 'pinned' | 'inline'; maxUploadBytes?: number }

export default function ProjectCard(props: CardProps) {
  const known = useChat((s) => s.projects.some((p) => p.id === props.projectId) || !!s.projectDetail[props.projectId])
  // The card measures its column once mounted (usePinFold), so it mounts only with a project to draw.
  return known ? <Card key={props.projectId} {...props} /> : null
}

function Card({ projectId, mode, maxUploadBytes }: CardProps) {
  const summary = useChat((s) => s.projects.find((p) => p.id === projectId))
  const detail = useChat((s) => s.projectDetail[projectId])
  const parent = useChat((s) => (summary?.parentId ? s.projects.find((p) => p.id === summary.parentId) : undefined))
  const models = useChat((s) => s.models)
  const card = useRef<HTMLDivElement>(null)
  const pinned = mode === 'pinned'
  const fold = usePinFold(PIN_FOLD_KEY, card)
  // On a phone the card sits in the page, folded to one row so the chats stay on the first screen.
  const [inlineFolded, setInlineFolded] = useState(true)
  const folded = pinned ? fold.folded : inlineFolded
  const setFolded = pinned ? fold.setFolded : setInlineFolded
  const [current, setCurrent] = useState<CardSection | null>(null)
  // A section once opened stays mounted, only hidden, while another row is open or the card is
  // folded (as it does by itself when the column narrows, say for the canvas): a draft survives.
  const [visited, setVisited] = useState<CardSection[]>([])
  const open = (section: CardSection | null) => {
    setCurrent(section)
    if (section) setVisited((v) => (v.includes(section) ? v : [...v, section]))
  }

  const ask = useSyncExternalStore(subscribeAsk, () => asked)
  useEffect(() => {
    if (!ask || ask.projectId !== projectId) return
    asked = null
    if (Date.now() - ask.at > LANDING_TIMEOUT_MS) return
    open(ask.section)
    fold.reveal()
    setInlineFolded(false)
  }, [ask, projectId])

  const project = detail || (summary ? { ...summary, files: undefined } : null)
  const memoryCount = useMemo(() => (detail ? memoryEntries(detail.memory || '').length : null), [detail?.memory])
  if (!project) return null

  const kind = parent ? 'folder' : 'project'
  const follows = parent ? `${parent.name}’s model` : 'the default in Settings → Providers'
  const choice = threadChoice(null, { provider: project.provider, modelSettings: project.modelSettings, projectId: project.id })
  const instructionsLine = (project.instructions || '').split('\n').map((l) => l.trim()).find(Boolean)

  const rows: { id: CardSection; icon: React.ComponentType<any>; label: string; value: string; empty?: boolean; title?: string }[] = [
    { id: 'files', icon: IconFiles, label: 'Files', value: project.fileCount ? plural(project.fileCount, 'file') : 'None', empty: !project.fileCount },
    { id: 'instructions', icon: IconFileText, label: 'Instructions', value: instructionsLine || 'None', empty: !instructionsLine },
    { id: 'memory', icon: IconBrain, label: 'Memory', value: memoryCount == null ? '…' : memoryCount ? plural(memoryCount, 'note') : 'Empty', empty: !memoryCount },
    {
      id: 'model', icon: IconSparkles, label: 'Model', value: `${chipLabel(choice.settings, choice.provider, models)}${project.provider ? '' : parent ? ` · from ${parent.name}` : ' · default'}`,
      title: project.provider ? `New chats here start on this` : `Follows ${follows}`,
    },
    { id: 'settings', icon: IconSettings, label: 'Settings', value: 'Name, icon', empty: true },
  ]

  const body = (section: CardSection) => {
    switch (section) {
      case 'files': return detail ? <FilesSection project={detail} maxUploadBytes={maxUploadBytes} /> : <p className="vc-proj-blank">Loading files…</p>
      case 'instructions': return (
        <TextSection
          value={project.instructions || ''}
          onSave={(v) => updateProject(project.id, { instructions: v })}
          placeholder="e.g. This is my day job at a logistics company. Answer like a senior colleague: short, concrete, no hedging. Use British spelling."
          intro={parent
            ? `Every chat in this folder follows these, on top of ${parent.name}’s instructions.`
            : 'Every chat in this project follows these. Say who it’s for, what you’re working on, and how you want answers.'}
          rows={8}
        />
      )
      case 'memory': return detail ? <MemorySection project={detail} /> : <p className="vc-proj-blank">Loading memory…</p>
      case 'model': return (
        <div className="vc-proj-field">
          <p className="vc-proj-hint">
            {project.provider
              ? `New chats in this ${kind} start on this. You can still change it in any one chat.`
              : `New chats here start on ${follows} until you pick one for this ${kind}.`}
          </p>
          <div className="vc-proj-model">
            <ModelPicker provider={choice.provider} settings={choice.settings} onChange={(patch) => updateProject(project.id, patch)} />
            {project.provider && (
              <button type="button" className="vc-btn sm ghost" onClick={() => updateProject(project.id, { provider: null, modelSettings: null })}>Use {follows}</button>
            )}
          </div>
        </div>
      )
      case 'settings': return <SettingsSection project={project} />
    }
  }

  const label = `${parent ? 'Folder' : 'Project'}: ${project.name}`
  const classes = ['wk-card', 'vc-pcard', pinned ? 'vc-pin pinned' : 'inline', folded ? 'folded' : ''].filter(Boolean).join(' ')
  const foldLabel = folded ? `Show what ${project.name}’s chats share` : pinned ? `Fold ${project.name}’s card` : `Hide what ${project.name}’s chats share`
  return (
    <div ref={card} className={classes} role="complementary" aria-label={label}>
      {pinned ? (
        <div className="wk-card-head vc-pcard-head">
          <span className="vc-pcard-icon"><ProjectIcon p={project} size={17} /></span>
          {folded ? (
            <button type="button" className="wk-card-title static folded" onClick={() => setFolded(false)} title={foldLabel}>{project.name}</button>
          ) : (
            <span className="vc-pcard-name">
              <strong>{project.name}</strong>
              {parent && <span>in {parent.name}</span>}
            </span>
          )}
          <button
            type="button" className="vc-icon-btn sm wk-card-close" onClick={() => setFolded(!folded)} aria-expanded={!folded}
            aria-label={foldLabel} title={folded ? 'Show' : 'Fold'}
          ><TI icon={folded ? IconChevronDown : IconChevronUp} size={15} /></button>
        </div>
      ) : (
        // In the page the heading already names the place, so the head is one button naming what the card holds.
        <button type="button" className="wk-card-head vc-pcard-head vc-pcard-toggle" onClick={() => setFolded(!folded)} aria-expanded={!folded}>
          <span className="vc-pcard-icon"><ProjectIcon p={project} size={17} /></span>
          <span className="vc-pcard-what">Files, instructions, memory…</span>
          <TI icon={folded ? IconChevronDown : IconChevronUp} size={15} className="vc-pcard-chev" />
        </button>
      )}
      <div className="vc-pcard-rows" hidden={folded}>
        {rows.map((r) => {
          const on = current === r.id
          const id = `vc-pcard-${project.id}-${r.id}`
          return (
            <div key={r.id} className={`vc-pcard-item${on ? ' on' : ''}`}>
              <button type="button" className="vc-pcard-row" aria-expanded={on} aria-controls={on ? id : undefined} onClick={() => open(on ? null : r.id)} title={r.title}>
                <span className="wk-card-label"><TI icon={r.icon} size={15} />{r.label}</span>
                <span className={`vc-pcard-value${r.empty ? ' is-empty' : ''}`}>{r.value}</span>
                <TI icon={on ? IconChevronUp : IconChevronDown} size={13} className="vc-pcard-chev" />
              </button>
              {visited.includes(r.id) && (
                <div className="vc-pcard-section" id={id} role="region" aria-label={r.label} hidden={!on} data-land={on ? sectionLandKey(project.id, r.id) : undefined}>
                  {body(r.id)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const SOURCE_LABEL: Record<ProjectFile['source'], string> = { upload: 'Uploaded', chat: 'From a chat', agent: 'Made by Totem' }
type SourceFilter = 'all' | ProjectFile['source']

function FilesSection({ project, maxUploadBytes }: { project: Project; maxUploadBytes?: number }) {
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
    else if (f.url) downloads.start(f.url, f.name)
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
        <select className="vc-pcard-select" value={filter} onChange={(e) => setFilter(e.target.value as SourceFilter)} aria-label="Show files">
          {(['all', 'upload', 'chat', 'agent'] as SourceFilter[]).map((s) => (
            <option key={s} value={s} disabled={s !== 'all' && !counts[s]}>
              {s === 'all' ? `All files (${files.length})` : `${SOURCE_LABEL[s]} (${counts[s] || 0})`}
            </option>
          ))}
        </select>
        <span className="vc-proj-spacer" />
        {picked.size > 0 ? (
          <>
            <button type="button" className="vc-btn sm ghost" onClick={() => setPicked(new Set())}>Clear</button>
            {parent && <button type="button" className="vc-btn sm" onClick={() => moveUp([...picked])} title={`Move ${picked.size === 1 ? 'it' : 'them'} to ${parent.name}, shared with all its chats`} aria-label={`Move ${picked.size} to ${parent.name}`}><TI icon={IconFolderUp} size={15} />Move up</button>}
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
          <TI icon={IconUpload} size={20} />
          <strong>Add files every chat here can read</strong>
          <span>Drop them here or click to choose. Files attached in this {project.parentId ? 'folder' : 'project'}’s chats, and documents Totem makes in them, land here too.</span>
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
              <a className="vc-icon-btn sm" href={f.url} download={f.name} aria-label={`Download ${f.name}`} title="Download"><TI icon={IconExternalLink} size={15} /></a>
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
function TextSection({ value, onSave, placeholder, intro, rows = 14, extra }: {
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

function MemorySection({ project }: { project: Project }) {
  const parent = useChat((s) => (project.parentId ? s.projects.find((p) => p.id === project.parentId) : undefined))
  const [picking, setPicking] = useState(false)
  if (picking && parent) return <MoveMemoryUp project={project} parent={parent} onDone={() => setPicking(false)} />
  const saved = project.memory || ''
  return (
    <TextSection
      value={saved}
      onSave={(v) => saveProjectMemory(project.id, v)}
      placeholder={`Nothing yet. As you chat, Totem notes decisions, facts and preferences here for the ${parent ? 'folder' : 'project'}’s other chats.`}
      intro={parent
        ? <>Totem keeps these notes for this folder’s chats only. They also read {parent.name}’s memory but never write to it. To share something with the whole project, use “Move to {parent.name}”.</>
        : 'Totem keeps these notes up to date as you work, so what one chat settles, the next one already knows. Edit or delete anything that’s wrong.'}
      rows={12}
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

/** A picture instead of an icon: an uploaded image, or a website's own icon. */
function PictureField({ project }: { project: Project }) {
  const [site, setSite] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  async function upload(file?: File) {
    if (!file) return
    setBusy(true)
    try {
      const up = await uploadFile(file, file.name)
      if (up.kind !== 'image' && !/icon$/.test(up.mime)) throw new Error('that is not a PNG, JPEG, GIF, WebP or ICO image')
      await updateProject(project.id, { image: up.id })
    } catch (e: any) { pushError(`Couldn't use that picture: ${e.message}`) } finally { setBusy(false) }
  }
  async function fetchIcon(e: React.FormEvent) {
    e.preventDefault()
    if (!site.trim()) return
    setBusy(true)
    try { await setProjectFavicon(project.id, site.trim()); setSite('') } catch (err: any) { pushError(`Couldn't get that site's icon: ${err.message}`) } finally { setBusy(false) }
  }
  return (
    <div className="vc-proj-picture">
      {project.imageUrl && (
        <span className="vc-proj-picture-now"><ProjectIcon p={project} size={22} />
          <button type="button" className="vc-btn sm ghost" disabled={busy} onClick={() => updateProject(project.id, { image: null })}><TI icon={IconX} size={14} />Remove picture</button>
        </span>
      )}
      <button type="button" className="vc-btn sm" disabled={busy} onClick={() => input.current?.click()}><TI icon={IconUpload} size={15} />Upload image</button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,.ico" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
      <form className="vc-proj-favicon" onSubmit={fetchIcon}>
        <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="example.com" aria-label="Website to take the icon from" disabled={busy} />
        <button type="submit" className="vc-btn sm" disabled={busy || !site.trim()}><TI icon={IconWorld} size={15} />Use site icon</button>
      </form>
    </div>
  )
}

function SettingsSection({ project }: { project: Project }) {
  const [name, setName] = useState(project.name)
  useEffect(() => setName(project.name), [project.name])
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
          {PROJECT_ICONS.map((icon) => {
            const on = !project.image && (project.icon || 'folder') === icon
            return (
              <button key={icon} type="button" role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => updateProject(project.id, { icon, ...(project.image ? { image: null } : {}) })} title={icon}>
                <TI icon={THREAD_ICONS[icon]} size={18} />
              </button>
            )
          })}
        </div>
        <PictureField project={project} />
      </div>
      <div className="vc-proj-field">
        <span>Delete {parent ? 'folder' : 'project'}</span>
        <p className="vc-proj-hint">Deletes the {parent ? 'folder' : 'project'}’s files, instructions and memory{folderCount ? ', and its folders' : ''}. Its chats are kept and move to {where}.{parent ? ` To keep a file or a note, move it to ${parent.name} first.` : ''}</p>
        <div><button type="button" className="vc-btn sm danger" onClick={remove}><TI icon={IconTrash} size={15} />Delete {parent ? 'folder' : 'project'}</button></div>
      </div>
    </div>
  )
}

