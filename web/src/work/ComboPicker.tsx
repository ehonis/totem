import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TI, useDismiss, usePopoverPlacement } from '../chat/ui'
import { IconSearch, IconCheck } from '../chat/icons'

// T3 Code's project selector, for anything Totem asks you to pick from a list:
// a search line on top, the rows under it, the arrow keys and Enter to choose,
// and a "New …" row at the bottom once what you typed matches nothing exactly.
// Portalled to <body> and placed against the viewport (usePopoverPlacement), as
// every popover that can open inside the chats panel or the chat must be.

export interface ComboItem {
  key: string
  label: string
  icon?: React.ReactNode
  /** A folder under its project. Dropped while searching, where `detail` names the project instead. */
  indent?: boolean
  /** Faint text on the right (a parent project, a due day). */
  detail?: string
  /** Faint text on the right only while searching. */
  searchDetail?: string
  /** Words that match besides the label. */
  keywords?: string
  /** A heading drawn above this row, unless searching. */
  section?: string
  muted?: boolean
}

export interface ComboAction { key: string; label: string; icon?: React.ReactNode }

export interface ComboPickerProps {
  open: boolean
  anchor: React.RefObject<HTMLElement>
  onClose: () => void
  items: ComboItem[]
  /** The row that is chosen now: checked, and highlighted when the picker opens. */
  value?: string | null
  onPick: (key: string) => void
  placeholder: string
  label: string
  empty?: string
  /** Rows at the bottom when nothing is typed (e.g. "Unlink"). */
  actions?: ComboAction[]
  /** Rows to add for what was typed, when it matches no row exactly ("New folder …"). */
  create?: (query: string) => ComboAction[]
  onAction?: (key: string, query: string) => void
  width?: number
  align?: 'start' | 'end'
}

export const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** Rows whose label or keywords contain every word typed, in their own order. */
export function filterItems(items: ComboItem[], query: string): ComboItem[] {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (!words.length) return items
  return items.filter((i) => {
    const hay = normalize(`${i.label} ${i.keywords || ''} ${i.searchDetail || ''}`)
    return words.every((w) => hay.includes(w))
  })
}

type Row = { type: 'item'; item: ComboItem } | { type: 'action'; action: ComboAction }

export default function ComboPicker(props: ComboPickerProps) {
  const { open, anchor, onClose, items, value, onPick, placeholder, label, empty = 'Nothing matches.', actions = [], create, onAction, width = 288, align = 'start' } = props
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const pop = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const placement = usePopoverPlacement(open, anchor, { width, height: 380, gap: 4, align, narrow: 0, minHeight: 160, fit: true })
  useDismiss(open, [pop, anchor] as React.RefObject<HTMLElement>[], onClose)

  const searching = query.trim().length > 0
  const rows: Row[] = useMemo(() => {
    const shown = filterItems(items, query)
    const out: Row[] = shown.map((item) => ({ type: 'item', item }))
    if (searching) {
      const exact = items.some((i) => normalize(i.label) === normalize(query.trim()))
      if (!exact && create) for (const action of create(query.trim())) out.push({ type: 'action', action })
    } else {
      for (const action of actions) out.push({ type: 'action', action })
    }
    return out
  }, [items, query, searching, actions, create])

  // Opening starts on the chosen row; typing starts on the first match.
  useEffect(() => {
    if (!open) { setQuery(''); return }
    const at = rows.findIndex((r) => r.type === 'item' && r.item.key === value)
    setHi(at >= 0 ? at : 0)
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  // Only when the query changes: on mount this ran after the effect above and put the
  // highlight back on the first row, away from the chosen one.
  const lastQuery = useRef(query)
  useEffect(() => {
    if (lastQuery.current === query) return
    lastQuery.current = query
    if (open) setHi(0)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row="${hi}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [hi])

  if (!open || !placement) return null

  const choose = (r: Row | undefined) => {
    if (!r) return
    if (r.type === 'item') onPick(r.item.key)
    else onAction?.(r.action.key, query.trim())
    onClose()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(rows.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setHi(0) }
    else if (e.key === 'End') { e.preventDefault(); setHi(rows.length - 1) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(rows[hi]) }
    else if (e.key === 'Tab') onClose()
  }

  const firstAction = rows.findIndex((r) => r.type === 'action')
  return createPortal(
    <div ref={pop} className={`wk-combo ${placement.up ? 'up' : 'down'}`} style={placement.style} role="dialog" aria-label={label} onKeyDown={onKey}>
      <label className="wk-combo-search">
        <TI icon={IconSearch} size={15} />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          role="combobox"
          aria-expanded
          aria-controls="wk-combo-list"
          aria-activedescendant={rows[hi] ? `wk-combo-row-${hi}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="wk-combo-list" id="wk-combo-list" role="listbox" ref={list}>
        {!rows.some((r) => r.type === 'item') && <div className="wk-combo-empty">{empty}</div>}
        {rows.map((r, i) => {
          if (r.type === 'action') {
            return (
              <React.Fragment key={`a:${r.action.key}`}>
                {i === firstAction && i > 0 && <div className="wk-combo-sep" />}
                <button type="button" role="option" aria-selected={i === hi} id={`wk-combo-row-${i}`} data-row={i} className={`wk-combo-row action ${i === hi ? 'on' : ''}`} onMouseMove={() => setHi(i)} onClick={() => choose(r)}>
                  {r.action.icon}
                  <span className="wk-combo-label">{r.action.label}</span>
                </button>
              </React.Fragment>
            )
          }
          const { item } = r
          const selected = item.key === value
          return (
            <React.Fragment key={`i:${item.key}`}>
              {!searching && item.section && <div className="wk-combo-section">{item.section}</div>}
              <button
                type="button" role="option" aria-selected={i === hi} id={`wk-combo-row-${i}`} data-row={i}
                className={`wk-combo-row ${i === hi ? 'on' : ''} ${selected ? 'selected' : ''} ${item.indent && !searching ? 'indent' : ''} ${item.muted ? 'dim' : ''}`}
                onMouseMove={() => setHi(i)} onClick={() => choose(r)} title={item.label}
              >
                {item.icon}
                <span className="wk-combo-label">{item.label}</span>
                {(searching ? item.searchDetail || item.detail : item.detail) && <span className="wk-combo-detail">{searching ? item.searchDetail || item.detail : item.detail}</span>}
                {selected && <TI icon={IconCheck} size={14} className="wk-combo-check" />}
              </button>
            </React.Fragment>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
