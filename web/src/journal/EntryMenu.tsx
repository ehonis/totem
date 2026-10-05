// The ⋯ menu on a journal entry.
//
// One bare glyph rather than a row of buttons, the same bargain `GoalCard` already
// makes: deleting is the action wanted least often and the one least affordable by
// accident, and it had a permanent button sitting next to a permanent "Again". The
// exception is **Don't ingest**, which stays a real button on the card while the
// countdown runs — it is the one action here with a deadline, and burying a
// time-boxed decision behind a menu is how you miss it.
//
// Items are built by the caller so this file knows nothing about journal state; it
// owns the popover behaviour only (outside click, Escape, focus, danger styling).
import React, { useEffect, useRef, useState } from 'react'
import { EllipsisHorizontalIcon, Hi } from '../icons'

export interface MenuItem {
  key: string
  label: string
  icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  title?: string
  /** Draw a divider above this item. */
  separated?: boolean
}

export default function EntryMenu({ items, label, disabled = false }: {
  items: MenuItem[]
  label: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const usable = items.filter(Boolean)
  if (!usable.length) return null

  return (
    <div className="journal-menu-anchor" ref={ref}>
      <button
        type="button"
        className="journal-menu-toggle"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      ><Hi icon={EllipsisHorizontalIcon} size={18} /></button>
      {open && (
        <div className="journal-menu" role="menu" aria-label={label}>
          {usable.map((item) => (
            <React.Fragment key={item.key}>
              {item.separated && <div className="journal-menu-separator" />}
              <button
                type="button"
                role="menuitem"
                className={item.danger ? 'danger' : undefined}
                disabled={item.disabled}
                title={item.title}
                onClick={() => { setOpen(false); item.onSelect() }}
              >
                {item.icon && <Hi icon={item.icon} size={14} />}
                <span>{item.label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
