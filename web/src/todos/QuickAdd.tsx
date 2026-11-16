// The inline "add a task" line at the top of the list. Words the shared parser
// recognises ("tomorrow", "p2", "#Gizmo Labs") show as chips under the line as you
// type; a chip's × keeps the word as plain text. Enter adds the task and keeps focus
// here, so a run of tasks is typed one after another. Looking at one folder, a new
// task is filed there unless another is typed (#folder), so adding never throws the
// view back to All.
import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Hi, CalendarDaysIcon, PlusIcon, XMarkIcon } from '../icons'
import type { Project } from '../chat/types'
import { FolderIcon } from '../work/FolderField'
import { folderFor, folderLabel } from './folders'
import { hintKey, parseQuickAdd, type FolderName, type Hint } from './parse'
import { dueText } from './format'
import { priorityLabel, type Todo, type TodoPatch } from './types'
import { FlagSolidIcon } from './taskIcons'

export interface QuickAddHandle { focus: () => void }

/** What the list shows: everything, Personal (unfiled), one folder (and its folders), or only the task sheet. */
export type Scope = 'all' | 'personal' | 'sheet' | `folder:${string}`

interface Props {
  now: Date
  /** The owner's chat projects and folders, for #folder. */
  folders: readonly FolderName[]
  projects: readonly Project[]
  /** Where a new task lands when no #folder is typed (the folder being looked at), or null. */
  defaultFolder: string | null
  /** Creates the task; resolves once the bridge has it (null when it refused). */
  onCreate: (fields: TodoPatch & { title: string }) => Promise<Todo | null>
}

function chipText(hint: Hint, now: Date, projects: readonly Project[]) {
  if (hint.kind === 'due' && hint.dueDate) return dueText(hint.dueDate, now)
  if (hint.kind === 'priority' && hint.priority) return priorityLabel(hint.priority)
  return folderLabel(hint.folderId, projects)
}

const QuickAdd = forwardRef<QuickAddHandle, Props>(function QuickAdd({ now, folders, projects, defaultFolder, onCreate }, ref) {
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [ignore, setIgnore] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // What the line holds now, read after the create answers (the render's `text` is the one it was sent with).
  const current = useRef(text)
  current.current = text
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), [])
  const parsed = useMemo(() => parseQuickAdd(text, { now, folders, ignore }), [text, now, folders, ignore])
  const scoped = folderFor(defaultFolder, projects)
  const folderId = parsed.folderId ?? scoped?.id ?? null

  async function submit() {
    const title = parsed.title.trim()
    if (!title || busy) return
    setBusy(true)
    const fields: TodoPatch & { title: string } = {
      title,
      dueDate: parsed.dueDate,
      ...(folderId ? { folderId } : {}),
      ...(parsed.priority ? { priority: parsed.priority } : {}),
    }
    // Words typed while the bridge answers are the next task's: what was sent is taken
    // off the front and the rest stays. A line edited some other way is left alone.
    const submitted = text
    const created = await onCreate(fields)
    setBusy(false)
    if (created && current.current.startsWith(submitted)) {
      setText(current.current.slice(submitted.length).trimStart())
      setIgnore([])
    }
    input.current?.focus()
  }

  return (
    <div className="tk-quick">
      <div className="tk-quick-line">
        <span className="tk-quick-plus" aria-hidden="true"><Hi icon={PlusIcon} size={15} /></span>
        <input
          ref={input}
          className="tk-quick-input"
          aria-label="Add a task"
          placeholder={scoped ? `Add a task to ${scoped.name}` : 'Add a task, e.g. “Renew passport fri p1 #folder”'}
          value={text}
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
            if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation()
              if (text) { setText(''); setIgnore([]) } else input.current?.blur()
            }
          }}
        />
        {text.trim() && <kbd className="tk-kbd" aria-hidden="true">↵</kbd>}
      </div>
      {(parsed.hints.length > 0 || (scoped && !parsed.folderId && text.trim())) && (
        <div className="tk-quick-chips" aria-label="Recognised in the title">
          {parsed.hints.map((hint) => (
            <span key={`${hint.kind}-${hint.start}`} className={`tk-chip tk-chip-${hint.kind}`}>
              {hint.kind === 'due' && <Hi icon={CalendarDaysIcon} size={12} />}
              {hint.kind === 'priority' && <Hi icon={FlagSolidIcon} size={12} />}
              {hint.kind === 'folder' && <FolderIcon project={folderFor(hint.folderId, projects)} size={12} />}
              {chipText(hint, now, projects)}
              <button
                type="button"
                aria-label={`Keep “${hint.text}” as text`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setIgnore((current) => [...current, hintKey(hint)])}
              ><Hi icon={XMarkIcon} size={11} /></button>
            </span>
          ))}
          {scoped && !parsed.folderId && (
            <span className="tk-chip tk-chip-folder tk-chip-pick" title="The folder you are looking at; type #folder for another">
              <FolderIcon project={scoped} size={12} />{folderLabel(scoped.id, projects)}
            </span>
          )}
        </div>
      )}
    </div>
  )
})

export default QuickAdd
