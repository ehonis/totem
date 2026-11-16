import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '../chat/store'
import { TI } from '../chat/ui'
import { IconCalendar, IconChevronDown, IconFlag, IconPlus, IconX } from '../chat/icons'
import { dueText } from '../todos/format'
import { folderFor, folderLabel, folderNames, PERSONAL } from '../todos/folders'
import { hintKey, parseQuickAdd, type Hint } from '../todos/parse'
import { priorityLabel } from '../todos/types'
import { FolderIcon } from './FolderField'
import { FolderPicker } from './pickers'
import type { WorkTask } from './groups'
import { createTask } from './state'

// The chats panel's "Add a task…" line. The folder button at its end is where the
// task goes: any chat project or folder, a new one typed into the picker, or
// Personal, whether or not that folder has open tasks (and so a group) to add from.
// A "#folder" typed in the title is shown on the button (tinted) and wins for that
// task, unless the button is used after it, which keeps the word as text; "tomorrow"
// and "p1" show as chips under the line, each with × to keep the word as text, as on
// the Tasks page.

interface Props {
  /** The folder the button starts on: the one last used (the top line) or the group's. */
  folderId: string | null
  /** The button was used: the top line remembers it for the next task. */
  onFolder?: (folderId: string | null) => void
  placeholder?: string
  autoFocus?: boolean
  /** The task was added (with where it went). */
  onAdded?: (task: WorkTask) => void
  /** Escape, or focus left an empty line: the group's line closes. */
  onDone?: () => void
}

function chipText(hint: Hint, now: Date) {
  if (hint.kind === 'due' && hint.dueDate) return dueText(hint.dueDate, now)
  if (hint.kind === 'priority' && hint.priority) return priorityLabel(hint.priority)
  return hint.text
}

export default function AddTask({ folderId: start, onFolder, placeholder = 'Add a task…', autoFocus = false, onAdded, onDone }: Props) {
  const projects = useChat((s) => s.projects)
  const names = useMemo(() => folderNames(projects), [projects])
  const [text, setText] = useState('')
  const [ignore, setIgnore] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  // The button's folder. A #folder typed in the title wins over it, unless the button is used after.
  const [chosen, setChosen] = useState<string | null>(start)
  const input = useRef<HTMLTextAreaElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const line = useRef<HTMLDivElement>(null)
  const current = useRef(text)
  current.current = text

  const now = new Date()
  const parsed = parseQuickAdd(text, { now, folders: names, ignore })
  // A folder deleted since it was chosen reads as Personal.
  const base = folderFor(chosen, projects)?.id ?? null
  const folderId = parsed.folderId ?? base
  const typed = !!parsed.folderId && parsed.folderId !== base
  const project = folderFor(folderId, projects)
  // A #folder shows on the button rather than as a chip; choosing on the button keeps the word as text.
  const chips = parsed.hints.filter((hint) => hint.kind !== 'folder')
  // Grows with a long title (field-sizing is Chromium-only; the desktop app is WebKit). CSS caps it at five lines.
  // Measured again when the folder button's width changes too.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text, folderId, projects])

  async function add() {
    const title = parsed.title.trim()
    if (saving) return
    if (!title) { if (!text.trim()) onDone?.(); return }
    setSaving(true)
    const submitted = text
    const task = await createTask({ title, dueDate: parsed.dueDate, priority: parsed.priority }, folderId)
    setSaving(false)
    if (!task) return
    // Words typed while the bridge answered are the next task's.
    setText(current.current.startsWith(submitted) ? current.current.slice(submitted.length).trimStart() : current.current)
    setIgnore([])
    onAdded?.(task)
    input.current?.focus()
  }

  return (
    <div
      ref={line} className="wk-add"
      onMouseDown={(e) => {
        // Only the line's own blank space; the picker's events bubble here through its portal.
        if (!line.current?.contains(e.target as Node) || (e.target as HTMLElement).closest('button, textarea')) return
        e.preventDefault()
        input.current?.focus()
      }}
      onBlur={(e) => {
        // Focus moving to the folder button, its picker or a chip keeps the group's line open.
        if (picking || (e.relatedTarget && line.current?.contains(e.relatedTarget as Node))) return
        if (!current.current.trim()) onDone?.()
      }}
    >
      <div className="wk-add-line">
        <TI icon={IconPlus} size={15} className="wk-add-plus" />
        {/* A textarea so a long title wraps in the narrow panel rather than scrolling out of sight. */}
        <textarea
          ref={input} value={text} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus} maxLength={500} rows={1}
          aria-busy={saving || undefined}
          onChange={(e) => {
            const next = e.target.value.replace(/\s*\n\s*/g, ' ')
            setText(next)
            // A word deleted from the title is read afresh if typed again.
            const words = next.toLowerCase().replace(/\s+/g, ' ')
            setIgnore((cur) => (cur.every((key) => words.includes(key)) ? cur : cur.filter((key) => words.includes(key))))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void add() }
            if (e.key === 'Escape') { e.preventDefault(); setText(''); setIgnore([]); onDone?.() }
          }}
        />
        <button
          ref={button} type="button" className={`wk-add-folder ${project ? '' : 'personal'} ${typed ? 'typed' : ''}`.trim()}
          aria-haspopup="dialog" aria-expanded={picking}
          aria-label={`Folder: ${folderLabel(folderId, projects)}${typed ? ', from the title' : ''}. Change`}
          title={typed ? `${folderLabel(folderId, projects)}, from the title. Choose another` : `Goes in ${folderLabel(folderId, projects)}. Choose another`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPicking((v) => !v)}
        >
          <FolderIcon project={project} size={13} />
          <span className="wk-add-folder-name">{project?.name || PERSONAL}</span>
          <TI icon={IconChevronDown} size={12} className="wk-add-folder-chev" />
        </button>
      </div>
      {chips.length > 0 && (
        <div className="wk-add-chips" aria-label="Recognised in the title">
          {chips.map((hint) => (
            <span key={`${hint.kind}-${hint.start}`} className={`tk-chip tk-chip-${hint.kind}`}>
              <TI icon={hint.kind === 'due' ? IconCalendar : IconFlag} size={12} />
              {chipText(hint, now)}
              <button
                type="button" aria-label={`Keep “${hint.text}” as text`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setIgnore((cur) => [...cur, hintKey(hint)])}
              ><TI icon={IconX} size={11} /></button>
            </span>
          ))}
        </div>
      )}
      {picking && (
        <FolderPicker
          open anchor={button} align="end"
          onClose={() => {
            setPicking(false)
            // Back to the line, unless the click that closed it went to another field.
            requestAnimationFrame(() => {
              const at = document.activeElement
              if (!at || at === document.body) input.current?.focus()
            })
          }}
          value={folderId} noneLabel={PERSONAL} noneIcon="person" label="Add the task to"
          onPick={(id) => {
            setChosen(id)
            // Chosen over any #folder already typed: those words stay in the title as text.
            const keys = [...ignore]
            for (let i = 0; i < 20; i++) {
              const hint = parseQuickAdd(text, { now: new Date(), folders: names, ignore: keys, kinds: ['folder'] }).hints[0]
              if (!hint) break
              keys.push(hintKey(hint))
            }
            setIgnore(keys)
            onFolder?.(id)
            input.current?.focus()
          }}
        />
      )}
    </div>
  )
}
