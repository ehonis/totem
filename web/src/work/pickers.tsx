import React, { useMemo } from 'react'
import ComboPicker, { type ComboItem } from './ComboPicker'
import { useChat, createProject, rootProject, projectById } from '../chat/store'
import ProjectIcon from '../chat/ProjectIcon'
import { TI } from '../chat/ui'
import { IconFolderPlus, IconHome, IconInbox, IconPlus, IconLinkOff, IconCircle, IconTable } from '../chat/icons'
import { pushError } from '../toast'
import { folderOrder, dueLabel, resolveRef, type WorkTask } from './groups'
import { useWork, createTask } from './state'

// The two pickers built on ComboPicker: where something goes (a project or one
// of its folders, or nowhere) and which task a chat is for.

const HOME = '__home__'

export interface FolderPickerProps {
  open: boolean
  anchor: React.RefObject<HTMLElement>
  onClose: () => void
  /** The project or folder it is in now; null for none. */
  value: string | null
  onPick: (projectId: string | null) => void
  /** What "none" means here: "Home" for a chat, "No folder" for a task. */
  noneLabel: string
  /** Its icon: a house for a chat's Home, an inbox for a task filed nowhere. */
  noneIcon?: 'home' | 'inbox'
  label?: string
  align?: 'start' | 'end'
}

/** Every project with its folders under it, searchable, with "New project/folder …" from what was typed. */
export function FolderPicker({ open, anchor, onClose, value, onPick, noneLabel, noneIcon = 'home', label = 'Choose a folder', align }: FolderPickerProps) {
  const projects = useChat((s) => s.projects)
  const items = useMemo<ComboItem[]>(() => [
    { key: HOME, label: noneLabel, icon: <TI icon={noneIcon === 'inbox' ? IconInbox : IconHome} size={16} />, muted: true },
    ...folderOrder(projects).map((p) => {
      const parent = p.parentId ? projects.find((x) => x.id === p.parentId) : undefined
      return {
        key: p.id, label: p.name, icon: <ProjectIcon p={p} size={16} />, indent: !!parent,
        searchDetail: parent?.name, keywords: parent?.name,
      }
    }),
  ], [projects, noneLabel, noneIcon])
  // A new folder goes in the project of what is chosen now (or the first project).
  const home = rootProject(projectById(value)) || projects.find((p) => !p.parentId)
  const make = async (body: { name: string; parentId?: string }) => {
    try { const p = await createProject(body, { open: false }); onPick(p.id) } catch (e: any) { pushError(`Couldn't create it: ${e.message}`) }
  }
  return (
    <ComboPicker
      open={open} anchor={anchor} onClose={onClose} label={label} align={align}
      items={items} value={value ?? HOME}
      placeholder="Search folders…"
      empty="No matching folders."
      onPick={(key) => onPick(key === HOME ? null : key)}
      create={(q) => [
        ...(home ? [{ key: 'new-folder', label: `New folder “${q}” in ${home.name}`, icon: <TI icon={IconFolderPlus} size={16} /> }] : []),
        { key: 'new-project', label: `New project “${q}”`, icon: <TI icon={IconFolderPlus} size={16} /> },
      ]}
      onAction={(key, q) => {
        if (key === 'new-project' && q) void make({ name: q })
        if (key === 'new-folder' && q && home) void make({ name: q, parentId: home.id })
      }}
    />
  )
}

export interface TaskPickerProps {
  open: boolean
  anchor: React.RefObject<HTMLElement>
  onClose: () => void
  value: string | null
  onPick: (ref: string | null) => void
  /** Where a task made from the picker is filed (the chat's project). */
  projectId?: string | null
  align?: 'start' | 'end'
}

/** Open tasks (then the shared sheet's items), searchable, with "New task …" from what was typed. */
export function TaskPicker({ open, anchor, onClose, value: stored, onPick, projectId = null, align }: TaskPickerProps) {
  const tasks = useWork((s) => s.tasks)
  const value = stored ? resolveRef(stored, tasks) : null
  const sheetName = useWork((s) => s.sheetName)
  const items = useMemo<ComboItem[]>(() => {
    const now = new Date()
    const open = tasks.filter((t) => (!t.done && !t.hidden) || t.ref === value)
    const local = open.filter((t) => t.kind === 'local')
    const sheet = open.filter((t) => t.kind === 'sheet')
    const row = (t: WorkTask, section?: string): ComboItem => ({
      key: t.ref, label: t.title, section,
      icon: <TI icon={t.kind === 'sheet' ? IconTable : IconCircle} size={15} />,
      detail: dueLabel(t.dueDate, now)?.text,
      keywords: t.status,
    })
    return [
      ...local.map((t, i) => row(t, i === 0 && sheet.length ? 'Tasks' : undefined)),
      ...sheet.map((t, i) => row(t, i === 0 ? sheetName || 'Shared sheet' : undefined)),
    ]
  }, [tasks, sheetName, value])
  return (
    <ComboPicker
      open={open} anchor={anchor} onClose={onClose} label="Link to a task" align={align}
      items={items} value={value}
      placeholder="Search tasks…"
      empty="No matching tasks."
      onPick={(key) => onPick(key)}
      actions={value ? [{ key: 'unlink', label: 'Unlink task', icon: <TI icon={IconLinkOff} size={16} /> }] : []}
      create={(q) => [{ key: 'new-task', label: `New task “${q}”`, icon: <TI icon={IconPlus} size={16} /> }]}
      onAction={async (key, q) => {
        if (key === 'unlink') onPick(null)
        if (key === 'new-task' && q) {
          const task = await createTask({ title: q }, projectId)
          if (task) onPick(task.ref)
        }
      }}
    />
  )
}
