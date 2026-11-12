// The inline "add a task" line at the top of the list. Words the shared parser
// recognises ("tomorrow", "p2", "#Acme") show as chips under the line as you type;
// a chip's × keeps the word as plain text. Enter adds the task and keeps focus here,
// so a run of tasks is typed one after another. In the Ventures scope a new task is a
// Ventures task: its venture is the one typed (#tag), else the scope's chip (the only
// tag, or the one picked there), so adding never throws the view back to All.
import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Hi, CalendarDaysIcon, ChevronDownIcon, PlusIcon, XMarkIcon } from '../icons'
import Menu from './Menu'
import { hintKey, parseQuickAdd, type Hint } from './parse'
import { dueText } from './format'
import { priorityLabel, type Todo, type TodoPatch } from './types'
import { FlagSolidIcon } from './taskIcons'

export interface QuickAddHandle { focus: () => void }

/** What the list shows: everything, one area, or only the task sheet. */
export type Scope = 'all' | 'Personal' | 'Ventures' | 'sheet'

interface Props {
  now: Date
  ventureTags: readonly string[]
  scope: Scope
  /** Creates the task; resolves once the bridge has it (null when it refused). */
  onCreate: (fields: TodoPatch & { title: string }) => Promise<Todo | null>
}

function chipText(hint: Hint, now: Date) {
  if (hint.kind === 'due' && hint.dueDate) return dueText(hint.dueDate, now)
  if (hint.kind === 'priority' && hint.priority) return priorityLabel(hint.priority)
  return `#${hint.ventureTag}`
}

const QuickAdd = forwardRef<QuickAddHandle, Props>(function QuickAdd({ now, ventureTags, scope, onCreate }, ref) {
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [ignore, setIgnore] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // What the line holds now, read after the create answers (the render's `text` is the one it was sent with).
  const current = useRef(text)
  current.current = text
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), [])
  const parsed = useMemo(() => parseQuickAdd(text, { now, ventureTags, ignore }), [text, now, ventureTags, ignore])
  // The Ventures scope's venture when none is typed: the last one picked, else the first.
  const [picked, setPicked] = useState<string | null>(null)
  const [pickAnchor, setPickAnchor] = useState<HTMLElement | null>(null)
  const scopeVenture = scope === 'Ventures' && ventureTags.length
    ? (picked && ventureTags.includes(picked) ? picked : ventureTags[0])
    : null
  const venture = parsed.ventureTag ?? scopeVenture

  async function submit() {
    const title = parsed.title.trim()
    if (!title || busy) return
    setBusy(true)
    const fields: TodoPatch & { title: string } = {
      title,
      dueDate: parsed.dueDate,
      area: venture ? 'Ventures' : 'Personal',
      ventureTag: venture,
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
          placeholder={scope === 'Ventures' ? 'Add a Ventures task, e.g. “Send the deck fri p1”' : 'Add a task, e.g. “Renew passport fri p1”'}
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
      {(parsed.hints.length > 0 || (scopeVenture && !parsed.ventureTag && text.trim())) && (
        <div className="tk-quick-chips" aria-label="Recognised in the title">
          {parsed.hints.map((hint) => (
            <span key={`${hint.kind}-${hint.start}`} className={`tk-chip tk-chip-${hint.kind}`}>
              {hint.kind === 'due' && <Hi icon={CalendarDaysIcon} size={12} />}
              {hint.kind === 'priority' && <Hi icon={FlagSolidIcon} size={12} />}
              {chipText(hint, now)}
              <button
                type="button"
                aria-label={`Keep “${hint.text}” as text`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setIgnore((current) => [...current, hintKey(hint)])}
              ><Hi icon={XMarkIcon} size={11} /></button>
            </span>
          ))}
          {scopeVenture && !parsed.ventureTag && (
            ventureTags.length > 1
              ? <button type="button" className="tk-chip tk-chip-venture tk-chip-pick" aria-haspopup="menu" aria-label={`Venture: ${scopeVenture}. Change`} onMouseDown={(event) => event.preventDefault()} onClick={(event) => setPickAnchor(event.currentTarget)}>#{scopeVenture}<Hi icon={ChevronDownIcon} size={11} /></button>
              : <span className="tk-chip tk-chip-venture tk-chip-pick">#{scopeVenture}</span>
          )}
        </div>
      )}
      {pickAnchor && (
        <Menu
          anchor={pickAnchor} label="Venture for the new task" width={220}
          onClose={() => { setPickAnchor(null); input.current?.focus() }}
          items={[{ heading: 'Venture' }, ...ventureTags.map((name) => ({ key: name, label: name, checked: name === scopeVenture, onSelect: () => setPicked(name) }))]}
        />
      )}
    </div>
  )
})

export default QuickAdd
