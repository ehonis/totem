/**
 * A select that can show a glyph beside each choice.
 *
 * A native `<select>` cannot render an SVG in an `<option>` — the browser draws that
 * list itself — so a picker with icons has to be built. This is the smallest honest
 * version: a `combobox` button over a `listbox`, keyboard-driven (arrows, Home/End,
 * Enter, Escape, type-to-jump), closing on outside click. It exists because the sport
 * a goal counts is the one field in the composer where the glyph is genuinely faster to
 * read than the word — you scan for the bike, you don't read "Cycling".
 *
 * Everything else in the composer stays a native `<select>` on purpose. Native is better
 * than this on a phone, and "icons everywhere" would be paying that cost for decoration.
 *
 * The list is portalled to `<body>` and positioned `fixed`, which is the one part that
 * isn't obvious. Absolutely positioning it inside the trigger is simpler and was wrong:
 * the composer is a `.event-modal`, which scrolls, and a scroll container clips anything
 * that overflows it — so the sport list came out sawn off at the bottom of the dialog.
 * Escaping to the body is what a native select does too. The cost is that the list would
 * drift if the page scrolled underneath it, so it closes on scroll rather than tracking.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDownIcon, Hi } from '../icons'

export interface IconSelectOption {
  value: string
  label: string
  icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>
  /** Small grey note after the label, for anything the label alone can't carry. */
  hint?: string
}

export default function IconSelect({ value, options, onChange, label, disabled = false, id }: {
  value: string
  options: IconSelectOption[]
  onChange: (value: string) => void
  label: string
  disabled?: boolean
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)))
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, flipped: false })
  const wrap = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const listId = useId()

  const selected = options.find((o) => o.value === value) ?? options[0]

  // Measured before paint so the list never renders once in the wrong place and jumps.
  useLayoutEffect(() => {
    if (!open) return
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect) return
    const height = Math.min(260, options.length * 34 + 8)
    // Open upward when the space below can't hold it but the space above can — near the
    // bottom of a tall dialog, downward is exactly where there is no room.
    const flipped = rect.bottom + height > window.innerHeight - 8 && rect.top > height + 8
    setBox({
      top: flipped ? rect.top - height - 4 : rect.bottom + 4,
      left: rect.left, width: rect.width, flipped,
    })
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      // The list lives in a portal, so "outside" has to mean outside both of them.
      if (!wrap.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false)
    }
    // The list's own keyboard scrolling fires scroll events too, and a capture listener
    // sees those as readily as a page scroll — without this the list closes the instant
    // it opens, because `scrollIntoView` below runs the moment it mounts.
    const close = (event?: Event) => {
      const target = event?.target as Node | null
      if (target && listRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    // Capture: the modal scrolls, not the window, and a bubbling listener never sees it.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Keep the highlighted row on screen when arrowing past the fold. Called defensively
  // because scrollIntoView is the one DOM method jsdom leaves off HTMLElement, and a
  // missing scroll is not worth an exception that unmounts the composer.
  useEffect(() => {
    if (!open) return
    const row = listRef.current?.children[active] as HTMLElement | undefined
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  const commit = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setOpen(false)
  }

  const openAt = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { if (open) { event.stopPropagation(); setOpen(false) } return }
    if (event.key === 'Tab') { setOpen(false); return }

    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openAt() }
      return
    }

    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); commit(active); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => (i + 1) % options.length); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i - 1 + options.length) % options.length); return }
    if (event.key === 'Home') { event.preventDefault(); setActive(0); return }
    if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1); return }

    // Type-to-jump, with the usual one-second buffer so "sw" finds Swimming rather than
    // bouncing between the two options starting with s and w.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now()
      typed.current = { text: (now - typed.current.at < 1000 ? typed.current.text : '') + event.key.toLowerCase(), at: now }
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text))
      if (hit >= 0) setActive(hit)
    }
  }

  return (
    <div className="icon-select" ref={wrap}>
      <button
        type="button" id={id} className={`icon-select-trigger${open ? ' open' : ''}`} disabled={disabled}
        role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-controls={listId} aria-label={label}
        onClick={() => (open ? setOpen(false) : openAt())}
        onKeyDown={onKeyDown}
      >
        {selected?.icon && <Hi icon={selected.icon} size={16} />}
        <span className="icon-select-value">{selected?.label ?? ''}</span>
        <Hi icon={ChevronDownIcon} size={14} className="icon-select-caret" />
      </button>

      {open && createPortal(
        <div
          className="icon-select-list" role="listbox" id={listId} aria-label={label}
          ref={listRef} tabIndex={-1}
          style={{ top: box.top, left: box.left, width: box.width }}
        >
          {options.map((option, i) => (
            <div
              key={option.value || '__any'}
              role="option"
              aria-selected={option.value === value}
              className={`icon-select-option${i === active ? ' active' : ''}${option.value === value ? ' selected' : ''}`}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: the outside-click listener above fires on mousedown,
              // and a click handler would race it and close the list before choosing.
              onMouseDown={(event) => { event.preventDefault(); commit(i) }}
            >
              {option.icon && <Hi icon={option.icon} size={16} />}
              <span>{option.label}</span>
              {option.hint && <span className="muted icon-select-hint">{option.hint}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
