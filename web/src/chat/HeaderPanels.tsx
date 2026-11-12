import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChat, showAgents, showBrowser, showFiles } from './store'
import { useThreadFiles } from './FilesPanel'
import { useThreadAgents } from './AgentsPanel'
import { useChatBrowser, host } from './BrowserPanel'
import { TI, useDismiss, usePopoverPlacement } from './ui'
import { IconDots, IconFolder, IconRobot, IconWorld } from './icons'
import { FOLD_STEPS, type FoldStep } from './headerFold'

type TablerIcon = React.ComponentProps<typeof TI>['icon']

// The chat header's chips for the side panels a chat has something in (Files,
// Agents, Browser), and its "…" menu. How much of a chip shows, and what has gone
// into "…", is decided by the header's own width (chat/headerFold.ts), never the
// window's, because a side panel can leave the chat column any width. A chip and
// its menu row are drawn from the same item, so they always say the same thing.

export interface HeaderItem {
  id: string
  /** What the chip or row says: "2 files", "1 working", "Browsing", "Keep". */
  label: string
  /** Said after it while there is room: the browser's host, a count. */
  detail?: string
  /** What is left of a chip once the header is tight: "2", or nothing. */
  short?: string
  /** Something is happening there, or it waits on the owner (amber, and it pulses on "…"). */
  tone?: '' | 'live' | 'waiting' | 'low' | 'crit' | 'on'
  title: string
  icon?: TablerIcon
  /** Drawn in place of `icon` (a project's own icon, the Totems mark). */
  glyph?: React.ReactNode
  /** A page thumbnail (the browser's), in place of the icon while it reads as one. */
  image?: string
  /** The fold step that moves it into "…". */
  into: FoldStep
  disabled?: boolean
  /** Where focus goes once it has opened something (a side panel, a picker); otherwise back to "…". */
  focusAfter?: string
  open: () => void
}

const SIDE_PANEL = '.vc-split > .vc-artifact'

/** What the side-panel chips say, from what the chat has; `open` opens a panel by id. */
export interface PanelState {
  files: number
  agents: { total: number; running: number }
  browser: { url: string; image?: string; live: boolean; waiting: boolean } | null
  /** Panels already open have no chip. */
  open: { files: boolean; agents: boolean; browser: boolean }
}

export function panelItems(s: PanelState, openPanel: (id: 'files' | 'agents' | 'browser') => void): HeaderItem[] {
  const items: HeaderItem[] = []
  if (s.files && !s.open.files) {
    items.push({ id: 'files', icon: IconFolder, label: `${s.files} file${s.files === 1 ? '' : 's'}`, short: String(s.files), title: 'Files this chat saved', into: 'menu', focusAfter: SIDE_PANEL, open: () => openPanel('files') })
  }
  if (s.agents.total && !s.open.agents) {
    const { running, total } = s.agents
    items.push({
      id: 'agents',
      icon: IconRobot,
      label: running ? `${running} working` : `${total} agent${total === 1 ? '' : 's'}`,
      short: String(running || total),
      tone: running ? 'live' : '',
      title: running ? `Agents this chat started: ${running} working` : 'Agents this chat started',
      into: 'menu',
      focusAfter: SIDE_PANEL,
      open: () => openPanel('agents'),
    })
  }
  const b = s.browser
  if (b && !s.open.browser) {
    const state = b.waiting ? 'Your turn' : b.live ? 'Browsing' : 'Browser'
    items.push({
      id: 'browser',
      icon: IconWorld,
      label: state,
      detail: host(b.url) || 'blank',
      // Waiting on the owner is the one thing that must still be read at a glance.
      short: b.waiting ? state : '',
      tone: b.waiting ? 'waiting' : b.live ? 'live' : '',
      title: b.waiting ? `The agent needs you in the browser: ${b.url}` : b.url,
      image: b.image,
      into: 'menu',
      focusAfter: SIDE_PANEL,
      open: () => openPanel('browser'),
    })
  }
  return items
}

const OPEN = { files: () => showFiles(true), agents: () => showAgents(true), browser: () => showBrowser(true) }

export function usePanelItems(threadId: string | null): HeaderItem[] {
  const listing = useThreadFiles(threadId)
  const agents = useThreadAgents(threadId)
  const frame = useChatBrowser(threadId)
  const filesOpen = useChat((s) => s.filesOpen)
  const agentsOpen = useChat((s) => s.agentsOpen)
  const browserOpen = useChat((s) => s.browserOpen)
  const waiting = useChat((s) => !!(threadId && s.handoffs[threadId]))
  return panelItems({
    files: listing?.entries.filter((e) => !e.dir).length || 0,
    agents: { total: agents.length, running: agents.filter((e) => e.agent.status === 'running').length },
    browser: frame ? { url: frame.url, image: frame.image, live: frame.live, waiting } : null,
    open: { files: filesOpen, agents: agentsOpen, browser: browserOpen },
  }, (id) => OPEN[id]())
}

/** One name for a chip, its row and "…": "Project context: On", "Browsing: 127.0.0.1:8766". */
const fullLabel = (item: HeaderItem) => (item.detail ? `${item.label}: ${item.detail}` : item.label)

/** The browser's is the page itself while it is big enough to read as one, else a globe. */
function Glyph({ item }: { item: HeaderItem }) {
  if (item.glyph) return <span className="vc-top-menu-glyph">{item.glyph}</span>
  if (!item.image) return item.icon ? <TI icon={item.icon} size={15} /> : null
  return (
    <>
      <img src={item.image} alt="" className="vc-hchip-shot" />
      <TI icon={item.icon || IconWorld} size={15} className="vc-hchip-globe" />
    </>
  )
}

/** A side panel's chip. Its label has three lengths; the header's fold picks one in CSS. */
export function HeaderChip({ item }: { item: HeaderItem }) {
  return (
    <button type="button" className={`vc-hchip ${item.id} ${item.tone || ''}`} onClick={item.open} title={item.title} aria-label={fullLabel(item)} data-fold-into={item.into}>
      <Glyph item={item} />
      <span className="vc-hchip-text" aria-hidden>
        <span className="vc-hchip-long">{item.label}{item.detail && <span className="vc-hchip-detail"> · {item.detail}</span>}</span>
        {item.short && <span className="vc-hchip-short">{item.short}</span>}
      </span>
    </button>
  )
}

/**
 * "…": what the header has folded away (`item.into` among its first `fold` steps), as a
 * menu. Shown by CSS only while something is folded into it. Arrow keys, Home and
 * End move; Escape and Tab close it and give focus back to "…"; choosing a row
 * moves focus to what it opened. The Escape it handles goes no further, so the
 * side panel beside the chat stays open.
 */
export function HeaderMenu({ items, fold }: { items: HeaderItem[]; fold: number }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const refs = useMemo(() => [btnRef, popRef] as React.RefObject<HTMLElement>[], [])
  const close = useCallback((how?: 'outside' | 'escape') => {
    setOpen(false)
    if (how === 'escape') btnRef.current?.focus()
  }, [])
  useDismiss(open, refs, close)
  const placement = usePopoverPlacement(open, btnRef, { width: 260, height: 360, gap: 6, align: 'end', fit: true, minHeight: 80 })
  const steps = new Set<string>(FOLD_STEPS.slice(0, fold))
  const rows = items.filter((i) => steps.has(i.into))

  // The header widened past the fold: the button is gone, and so is its menu.
  useEffect(() => {
    if (!open || typeof ResizeObserver === 'undefined') return
    const el = btnRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { if (!el.getClientRects().length) setOpen(false) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  // Focus goes to the first row once, when the menu has been placed.
  const focused = useRef(false)
  useEffect(() => {
    if (!open) { focused.current = false; return }
    if (placement && !focused.current) {
      focused.current = true
      popRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    }
  }, [open, placement])

  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') || [])]
    const at = list.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus() }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      btnRef.current?.focus()
    }
  }

  const choose = (item: HeaderItem) => {
    setOpen(false)
    item.open()
    // After React has drawn what it opened: there if it can take focus, else back on "…".
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const there = item.focusAfter ? document.querySelector(item.focusAfter) : null
      const target = there?.querySelector<HTMLElement>('input, textarea, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      if (target) target.focus()
      else if (btnRef.current?.isConnected && getComputedStyle(btnRef.current).display !== 'none') btnRef.current.focus()
    }))
  }

  // The dot on "…" is the loudest thing folded into it: amber and pulsing when it waits on the owner.
  const busy = rows.find((i) => i.tone === 'waiting') || rows.find((i) => i.tone === 'live')
  const names = rows.map(fullLabel).join(', ')
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`vc-icon-btn vc-top-more ${open ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More: ${names}`}
        title={names}
      >
        <TI icon={IconDots} size={19} />
        {busy && <i className={`vc-top-more-dot ${busy.id} ${busy.tone}`} aria-hidden />}
      </button>
      {open && createPortal(
        <div ref={popRef} className="vc-top-menu" role="menu" aria-label="More" style={placement?.style || { position: 'fixed', visibility: 'hidden' }} onKeyDown={onKey}>
          {rows.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`vc-top-menu-row ${item.id} ${item.tone || ''}`}
              title={item.title}
              aria-label={fullLabel(item)}
              disabled={item.disabled}
              onClick={() => choose(item)}
            >
              <Glyph item={item} />
              <span className="vc-top-menu-label">{item.label}</span>
              {item.detail && <span className="vc-top-menu-detail">{item.detail}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
