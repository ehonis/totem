// A small accessible menu for the Tasks page: snooze, due date, priority and the
// header's "…". Portalled to <body> (AGENTS.md § Gotchas: a fixed box inside a
// scroller is placed against the wrong frame), placed against its anchor in
// viewport pixels, flipped up when there is no room below.
//
// Opening moves focus to the first item; ↑/↓ (and j/k), Home and End move between
// items; Enter or Space picks; Esc, Tab-out or a click outside closes; focus goes
// back to whatever had it before, so the list's keyboard cursor is never lost.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Hi, CheckIcon } from '../icons'

export interface MenuItem {
  key: string
  label: string
  /** Right-aligned: the time a snooze ends, the date a due choice lands on. */
  detail?: string
  icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>
  iconClass?: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

export type MenuEntry = MenuItem | 'separator' | { heading: string }

interface MenuProps {
  /** The element the menu hangs from; its rectangle places the menu. */
  anchor: HTMLElement | null
  label: string
  items: MenuEntry[]
  onClose: () => void
  /** Extra controls under the items (a date field); its own keys are left alone. */
  footer?: React.ReactNode
  width?: number
}

const ITEM = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])'

export default function Menu({ anchor, label, items, onClose, footer, width = 260 }: MenuProps) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<React.CSSProperties>({ top: -9999, left: -9999 })
  const returnTo = useRef<HTMLElement | null>(typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null)
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    const rect = anchor?.getBoundingClientRect()
    const height = box.current?.offsetHeight ?? 300
    if (!rect) { setPlace({ top: 80, left: Math.max(8, window.innerWidth - width - 16) }); return }
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const below = window.innerHeight - rect.bottom
    setPlace(below < height + 12 && rect.top > below
      ? { left, top: Math.max(8, rect.top - height - 6) }
      : { left, top: rect.bottom + 6 })
  }, [anchor, width, items.length, Boolean(footer)])

  useEffect(() => {
    box.current?.querySelector<HTMLElement>(ITEM)?.focus()
    const back = returnTo.current
    function outside(event: PointerEvent) {
      const target = event.target as Node
      if (box.current?.contains(target) || anchor?.contains(target)) return
      close.current()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      // Back to where focus was, unless the choice moved it somewhere on purpose.
      if (back && document.contains(back) && (document.activeElement === document.body || box.current?.contains(document.activeElement))) back.focus({ preventScroll: true })
    }
  }, [anchor])

  function keydown(event: React.KeyboardEvent) {
    const typing = (event.target as HTMLElement).closest('input, textarea, select')
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
    if (event.key === 'Tab') {
      // Tab stays inside while a footer field is here; with items only it closes.
      if (!footer) { event.preventDefault(); close.current() }
      return
    }
    if (typing) return
    const list = Array.from(box.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])
    if (!list.length) return
    const at = list.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => { event.preventDefault(); event.stopPropagation(); list[(index + list.length) % list.length]?.focus() }
    if (event.key === 'ArrowDown' || event.key === 'j') go(at + 1)
    else if (event.key === 'ArrowUp' || event.key === 'k') go(at < 0 ? list.length - 1 : at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(list.length - 1)
    else event.stopPropagation()
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div ref={box} className="tk-menu" role="menu" aria-label={label} style={{ ...place, width }} onKeyDown={keydown}>
      {items.map((entry, index) => {
        if (entry === 'separator') return <div key={`sep-${index}`} className="tk-menu-sep" role="separator" />
        if ('heading' in entry) return <div key={`h-${index}`} className="tk-menu-heading" role="presentation">{entry.heading}</div>
        return (
          <button
            key={entry.key}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.checked === undefined ? undefined : entry.checked}
            tabIndex={-1}
            disabled={entry.disabled}
            className={`tk-menu-item${entry.danger ? ' danger' : ''}`}
            onClick={() => { entry.onSelect(); close.current() }}
          >
            <span className="tk-menu-icon" aria-hidden="true">
              {entry.icon ? <Hi icon={entry.icon} size={15} className={entry.iconClass} /> : entry.checked ? <Hi icon={CheckIcon} size={14} /> : null}
            </span>
            <span className="tk-menu-label">{entry.label}</span>
            {entry.detail && <span className="tk-menu-detail">{entry.detail}</span>}
            {entry.icon && entry.checked && <Hi icon={CheckIcon} size={14} className="tk-menu-check" />}
          </button>
        )
      })}
      {footer && <div className="tk-menu-footer">{footer}</div>}
    </div>,
    document.body,
  )
}
