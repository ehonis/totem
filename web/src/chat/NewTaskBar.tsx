// The strip atop the composer while `$task` has made the box a task line: what the
// words were read as (due day, priority, folder, as the Tasks page's quick-add line
// shows them), each with a × that keeps the word as text, and a × that turns the
// box back into a message.
import React from 'react'
import type { Project } from './types'
import type { Hint } from '../todos/parse'
import { hintKey } from '../todos/parse'
import { dueText } from '../todos/format'
import { folderFor, folderLabel } from '../todos/folders'
import { FolderIcon } from '../work/FolderField'
import { TI } from './ui'
import { IconChecklist, IconCalendar, IconFlag, IconLoader2, IconX } from './icons'

const PRIORITY = { 4: 'P1', 3: 'P2', 2: 'P3', 1: 'P4' } as const

export default function NewTaskBar({ hints, folderId, typedFolder, projects, now, busy, onIgnore, onLeave }: {
  hints: readonly Hint[]
  /** Where the task will be filed (typed with #folder, else where the chat is being started). */
  folderId: string | null
  /** The folder came from a #word, so its chip can be undone like the others. */
  typedFolder: boolean
  projects: readonly Project[]
  now: Date
  busy: boolean
  onIgnore: (key: string) => void
  onLeave: () => void
}) {
  const folder = folderFor(folderId, projects)
  const keep = (e: React.MouseEvent) => e.preventDefault()
  return (
    <div className="vc-newtask" aria-label="New task">
      <span className="vc-newtask-tag">
        {busy ? <TI icon={IconLoader2} size={14} className="vc-spin" /> : <TI icon={IconChecklist} size={14} />}
        New task
        <button type="button" aria-label="Write a message instead" title="Write a message instead" onMouseDown={keep} onClick={onLeave} disabled={busy}>
          <TI icon={IconX} size={11} />
        </button>
      </span>
      {hints.filter((h) => h.kind !== 'folder').map((h) => (
        <span key={`${h.kind}-${h.start}`} className={`vc-newtask-chip ${h.kind}`}>
          <TI icon={h.kind === 'due' ? IconCalendar : IconFlag} size={12} />
          {h.kind === 'due' && h.dueDate ? dueText(h.dueDate, now) : h.priority ? PRIORITY[h.priority] : h.text}
          <button type="button" aria-label={`Keep “${h.text}” as text`} onMouseDown={keep} onClick={() => onIgnore(hintKey(h))}>
            <TI icon={IconX} size={11} />
          </button>
        </span>
      ))}
      <span className="vc-newtask-chip folder" title={typedFolder ? undefined : 'Where this chat is; type #folder for another'}>
        <FolderIcon project={folder} size={12} />
        {folderLabel(folderId, projects)}
        {typedFolder && (() => {
          const h = hints.find((x) => x.kind === 'folder')!
          return (
            <button type="button" aria-label={`Keep “${h.text}” as text`} onMouseDown={keep} onClick={() => onIgnore(hintKey(h))}>
              <TI icon={IconX} size={11} />
            </button>
          )
        })()}
      </span>
      <span className="vc-newtask-help">↵ adds it and starts a chat</span>
    </div>
  )
}
