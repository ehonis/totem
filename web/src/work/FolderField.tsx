import React, { useRef, useState } from 'react'
import { useChat } from '../chat/store'
import ProjectIcon from '../chat/ProjectIcon'
import type { Project } from '../chat/types'
import { TI } from '../chat/ui'
import { IconChevronDown, IconUser } from '../chat/icons'
import { folderFor, folderLabel, PERSONAL } from '../todos/folders'
import { FolderPicker } from './pickers'

// A task's folder, as a label and as a control: one of the owner's chat projects
// or folders, or Personal (unfiled). The Tasks page's rows and pane, the chats
// panel's task card and the composer's strip all draw it the same way.

/** The folder's own icon, or a person for Personal. */
export function FolderIcon({ project, size = 14 }: { project: Project | null; size?: number }) {
  return project ? <ProjectIcon p={project} size={size} /> : <TI icon={IconUser} size={size} className="vc-proj-icon" />
}

/** "Work - Northwind / r+d" with its icon; `short` drops the project before a folder's name. */
export function FolderChip({ folderId, short = false, className = '' }: { folderId: string | null | undefined; short?: boolean; className?: string }) {
  const projects = useChat((s) => s.projects)
  const project = folderFor(folderId, projects)
  const label = short ? project?.name || PERSONAL : folderLabel(folderId, projects)
  return (
    <span className={`wk-folder-chip${project ? '' : ' personal'} ${className}`.trim()} title={folderLabel(folderId, projects)}>
      <FolderIcon project={project} size={12} />
      <span>{label}</span>
    </span>
  )
}

/** A button showing the folder that opens the folder picker. */
export function FolderField({ folderId, onPick, title, className = '', align }: {
  folderId: string | null | undefined
  onPick: (folderId: string | null) => void
  /** The task's title, for the picker's label. */
  title: string
  className?: string
  align?: 'start' | 'end'
}) {
  const projects = useChat((s) => s.projects)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const project = folderFor(folderId, projects)
  return (
    <>
      <button
        ref={anchor} type="button" className={`wk-folder-field ${className}`.trim()} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Folder: ${folderLabel(folderId, projects)}. Change`} onClick={() => setOpen((v) => !v)}
      >
        <FolderIcon project={project} size={14} />
        <span className="wk-folder-field-name">{folderLabel(folderId, projects)}</span>
        <TI icon={IconChevronDown} size={13} className="wk-folder-field-chev" />
      </button>
      {open && (
        <FolderPicker
          open anchor={anchor} onClose={() => setOpen(false)} align={align}
          value={project?.id ?? null} noneLabel={PERSONAL} noneIcon="person" label={`File “${title}”`}
          onPick={(id) => { if (id !== (project?.id ?? null)) onPick(id) }}
        />
      )}
    </>
  )
}
