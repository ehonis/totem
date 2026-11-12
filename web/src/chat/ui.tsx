import React from 'react'
import { DRIVER_LOGOS } from '../providers'
import {
  IconBrandGithub, IconBrandStrava, IconCalendarEvent, IconChecklist, IconDeviceDesktop, IconFileText, IconListCheck, IconBulb,
  IconMicrophone, IconTarget, IconTerminal2, IconTool, IconWorld, IconBrain, IconMail, IconBrandGoogleDrive, IconNotebook, IconPhoto,
  IconSearch, IconPencil, IconDatabase, IconRobot, IconUsersGroup, IconBrandOffice, IconBrandNotion, IconBrandSlack, IconBrandFigma,
} from './icons'

type TablerIcon = React.ComponentType<{ size?: number; stroke?: number; className?: string; style?: React.CSSProperties }>

/** A Tabler icon at Heroicons' visual weight. */
export function TI({ icon: Icon, size = 18, className = '', stroke = 1.75, style }: { icon: TablerIcon; size?: number; className?: string; stroke?: number; style?: React.CSSProperties }) {
  return <Icon size={size} stroke={stroke} className={`ti ${className}`.trim()} style={style} aria-hidden />
}

export function ProviderLogo({ driver, name, size = 16 }: { driver?: string; name?: string; size?: number }) {
  const src = DRIVER_LOGOS[driver || '']
  if (!src) return <span className="vc-logo vc-logo-fallback" style={{ width: size, height: size }}>{(name || '?').slice(0, 1).toUpperCase()}</span>
  return <img src={src} alt="" className={`vc-logo vc-logo-${driver}`} style={{ width: size, height: size }} aria-hidden />
}

// The Totem app behind a tool call, for the card's icon and label.
const APPS: Record<string, { icon: TablerIcon; label: string }> = {
  tasks: { icon: IconChecklist, label: 'Tasks' },
  // The chat's browser, reached directly (Claude: totem-browser, Codex:
  // totem_browser) or through the gateway (browser__preview_*).
  'totem-browser': { icon: IconWorld, label: 'Browser' },
  totem_browser: { icon: IconWorld, label: 'Browser' },
  browser: { icon: IconWorld, label: 'Browser' },
  goals: { icon: IconTarget, label: 'Goals' },
  lists: { icon: IconListCheck, label: 'Lists' },
  recs: { icon: IconBulb, label: 'Recommendations' },
  'google-calendar': { icon: IconCalendarEvent, label: 'Calendar' },
  calendar: { icon: IconCalendarEvent, label: 'Calendar' },
  strava: { icon: IconBrandStrava, label: 'Strava' },
  github: { icon: IconBrandGithub, label: 'GitHub' },
  plaud: { icon: IconMicrophone, label: 'Plaud' },
  krakatoa: { icon: IconNotebook, label: 'Krakatoa' },
  gmail: { icon: IconMail, label: 'Mail' },
  drive: { icon: IconBrandGoogleDrive, label: 'Drive' },
  // totems__list / totems__invite; an ask is drawn as the totem's own message (totemReply.ts).
  totems: { icon: IconUsersGroup, label: 'Totems' },
  'computer-use': { icon: IconDeviceDesktop, label: 'Computer' },
  computer_use: { icon: IconDeviceDesktop, label: 'Computer' },
  // claude.ai connectors, for when the CLI sent no logo (an older reply, another CLI).
  microsoft_365: { icon: IconBrandOffice, label: 'Microsoft 365' },
  notion: { icon: IconBrandNotion, label: 'Notion' },
  slack: { icon: IconBrandSlack, label: 'Slack' },
  figma: { icon: IconBrandFigma, label: 'Figma' },
}

const KINDS: Record<string, TablerIcon> = {
  command: IconTerminal2,
  web_search: IconWorld,
  webSearch: IconWorld,
  webFetch: IconWorld,
  read: IconFileText,
  edit: IconPencil,
  write: IconPencil,
  grep: IconSearch,
  glob: IconSearch,
  view_image: IconPhoto,
  image_generation: IconPhoto,
  // A call that starts another agent (Claude's Agent/Task tool, Codex collab).
  agent: IconRobot,
  Agent: IconRobot,
  Task: IconRobot,
}

const AGENT_NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor', opencode: 'OpenCode', gemini: 'Gemini' }
/** The name a sub-agent's CLI goes by. */
export const agentName = (provider?: string) => AGENT_NAMES[provider || ''] || provider || 'Agent'

export function toolApp(server?: string) {
  if (!server) return null
  return APPS[server] || { icon: IconDatabase, label: server.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }
}

export function toolIcon(kind: string, server?: string, detail?: string): TablerIcon {
  const app = toolApp(server)
  if (app) return app.icon
  // The brain is just files on disk, but reading it is "checking memory".
  if ((kind === 'read' || kind === 'grep' || kind === 'command') && /\/data\/brain\b/.test(detail || '')) return IconBrain
  return KINDS[kind] || IconTool
}

export function formatDuration(ms?: number) {
  if (!ms || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Close a popover on outside click / Escape. A portalled popover passes its own ref too. */
export function useDismiss(open: boolean, ref: React.RefObject<HTMLElement> | React.RefObject<HTMLElement>[], onClose: (how: 'outside' | 'escape') => void) {
  React.useEffect(() => {
    if (!open) return
    const refs = Array.isArray(ref) ? ref : [ref]
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!refs.some((r) => r.current && r.current.contains(e.target as Node))) onClose('outside')
    }
    // The Escape a popover consumes is marked, so a side panel listening on window does not close too.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose('escape') } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, ref, onClose])
}

// --dock-clear (the phone's bottom tab bar plus its gap) in pixels; it is a calc().
function dockClear(): number {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;height:var(--dock-clear,0px)'
  document.body.appendChild(probe)
  const h = probe.getBoundingClientRect().height
  probe.remove()
  return h
}

export interface Placement {
  style: React.CSSProperties
  /** It opens upward from the anchor. */
  up: boolean
}

/** Where a popover anchored at `r` goes, in viewport pixels. Pure, so it is tested. */
export function placePopover(r: { top: number; bottom: number; left: number; right: number }, view: { width: number; height: number; dock: number; layoutHeight?: number }, {
  width, height, gap = 10, edge = 8, offsetX = 0, narrow = 720, align = 'start', minHeight = 160, fit = false,
}: PlacementOptions): Placement {
  const vw = view.width, vh = view.height
  const above = r.top - gap - edge
  const below = vh - view.dock - r.bottom - gap - edge
  // Up, as the composer's menus always open, whenever the whole height fits there
  // or there is at least as much room as below; the choice depends only on where
  // the anchor is, so it opens the same way every time from the same place.
  const up = above >= height || above >= below
  // An anchor scrolled out of view can report more room than the window has.
  const usable = Math.max(0, vh - view.dock - edge * 2)
  const room = Math.max(0, up ? above : below)
  const h = Math.min(height, usable, Math.max(room, Math.min(minHeight, usable)))
  const w = vw <= narrow ? vw - edge * 2 : Math.min(width, vw - edge * 2)
  // 'end' lines the popover's right edge up with the anchor's.
  const want = align === 'end' ? r.right - w + offsetX : r.left + offsetX
  const left = vw <= narrow ? edge : Math.min(Math.max(edge, want), vw - w - edge)
  // Never off the page: a popover that had to be taller than its side's room is
  // pushed back inside, over the anchor if it must.
  const top = Math.min(Math.max(edge, up ? r.top - gap - h : r.bottom + gap), vh - view.dock - edge - h)
  const size = fit ? { maxHeight: h } : { height: h }
  // A popover that fits its content and opens upward hangs from its bottom edge,
  // so a short one still sits just above the anchor.
  const vertical = up && fit ? { top: 'auto', bottom: (view.layoutHeight ?? vh) - (top + h) } : { top, bottom: 'auto' }
  return { up, style: { position: 'fixed', left, right: 'auto', width: w, ...size, ...vertical } }
}

export interface PlacementOptions {
  width: number; height: number; gap?: number; edge?: number; offsetX?: number; narrow?: number; align?: 'start' | 'end'
  /** Shortest it is drawn when the room is tighter than that. */
  minHeight?: number
  /** `height` is a cap and the content decides (max-height); otherwise it is the height. */
  fit?: boolean
}

/**
 * Where a popover anchored to `anchor` fits on screen, for a popover rendered
 * into <body> (createPortal) with `position: fixed`. It must be portalled: inside
 * the chat a fixed box is not reliably laid out against the window. The scroller
 * is a size container and on a project's home carries a mask, and browsers have
 * disagreed on whether a container is a fixed box's containing block, so measuring
 * ancestors guessed wrong and the picker opened shifted by the scroller's offset
 * (and clipped to it). From <body> the viewport is the only frame there is.
 * Recomputed on resize, scroll, the on-screen keyboard and the anchor's size.
 */
export function usePopoverPlacement(open: boolean, anchor: React.RefObject<HTMLElement>, opts: PlacementOptions): Placement | undefined {
  const [placement, setPlacement] = React.useState<Placement>()
  const { width, height, gap, edge, offsetX, narrow, align, minHeight, fit } = opts
  React.useLayoutEffect(() => {
    if (!open) { setPlacement(undefined); return }
    // The dock's height is a CSS calc() read through a probe element, which forces a
    // layout, so it is read once per open and on resize, not on every scroll.
    let dock = dockClear()
    const place = () => {
      const el = anchor.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const view = { width: window.innerWidth, height: window.visualViewport?.height || window.innerHeight, layoutHeight: window.innerHeight, dock }
      const next = placePopover(r, view, { width, height, gap, edge, offsetX, narrow, align, minHeight, fit })
      setPlacement((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    place()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (anchor.current) ro?.observe(anchor.current)
    const vv = window.visualViewport
    const onResize = () => { dock = dockClear(); place() }
    // Scrolling the popover's own list does not move its anchor.
    const onScroll = (e: Event) => { if (!(e.target instanceof Element && e.target.closest('.vc-picker-pop, .vc-picker-access-menu'))) place() }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    vv?.addEventListener('resize', onResize)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      vv?.removeEventListener('resize', onResize)
    }
  }, [open, anchor, width, height, gap, edge, offsetX, narrow, align, minHeight, fit])
  return placement
}
