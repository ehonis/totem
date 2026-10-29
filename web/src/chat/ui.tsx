import React from 'react'
import { DRIVER_LOGOS } from '../providers'
import {
  IconBrandGithub, IconBrandStrava, IconCalendarEvent, IconChecklist, IconDeviceDesktop, IconFileText, IconListCheck,
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

/** Close a popover on outside click / Escape. */
export function useDismiss(open: boolean, ref: React.RefObject<HTMLElement>, onClose: () => void) {
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
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

// What a position:fixed descendant of `el` is laid out against: the viewport,
// unless an ancestor is a containing block for fixed boxes — a transform (the
// phone shell's sliding .main), a filter or backdrop-filter (the glass
// composer's .vc-box), perspective, layout/paint containment or a container
// query (.vc-scroll), or will-change on any of those — then that ancestor's
// padding box.
function makesFixedFrame(cs: CSSStyleDeclaration): boolean {
  const backdrop = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none'
  return cs.transform !== 'none' || cs.filter !== 'none' || backdrop !== 'none' || cs.perspective !== 'none'
    || (cs.containerType || 'normal') !== 'normal' || /layout|paint|strict|content/.test(cs.contain || '')
    || /transform|filter|perspective|contain/.test(cs.willChange)
}

function fixedFrame(el: HTMLElement): { left: number; top: number; bottom: number } {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (makesFixedFrame(getComputedStyle(p))) {
      const b = p.getBoundingClientRect()
      const left = b.left + p.clientLeft, top = b.top + p.clientTop
      return { left, top, bottom: top + p.clientHeight }
    }
  }
  return { left: 0, top: 0, bottom: window.innerHeight }
}

/**
 * Where a popover anchored to `anchor` fits on screen. It opens upward, as the
 * composer's menus always have, unless the room above is short of `height` and
 * there is more below; either way it shrinks to the room it has. Fixed
 * positioning, so no scrolling ancestor clips it (measured against fixedFrame). Narrow screens get the full
 * width less `edge` on each side. Recomputed on resize and scroll.
 */
export function usePopoverPlacement(open: boolean, anchor: React.RefObject<HTMLElement>, {
  width, height, gap = 10, edge = 8, offsetX = 0, narrow = 720, align = 'start', alignTo,
}: {
  width: number; height: number; gap?: number; edge?: number; offsetX?: number; narrow?: number; align?: 'start' | 'end'
  /** A selector for an ancestor whose edges the popover lines up with instead of the anchor's own. */
  alignTo?: string
}): React.CSSProperties | undefined {
  const [style, setStyle] = React.useState<React.CSSProperties>()
  React.useLayoutEffect(() => {
    if (!open) { setStyle(undefined); return }
    const place = () => {
      const el = anchor.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.visualViewport?.height || window.innerHeight
      const above = r.top - gap - edge
      const below = vh - dockClear() - r.bottom - gap
      const up = above >= height || above >= below
      const h = Math.max(160, Math.min(height, up ? above : below))
      const w = vw <= narrow ? vw - edge * 2 : Math.min(width, vw - 24)
      // 'end' lines the popover's right edge up with the anchor's.
      const box = (alignTo && el.closest(alignTo)?.getBoundingClientRect()) || r
      const want = align === 'end' ? box.right - w + offsetX : box.left + offsetX
      const left = vw <= narrow ? edge : Math.min(Math.max(12, want), vw - w - 12)
      const f = fixedFrame(el)
      setStyle({
        position: 'fixed', left: left - f.left, right: 'auto', width: w, height: h,
        ...(up ? { top: 'auto', bottom: f.bottom - r.top + gap } : { bottom: 'auto', top: r.bottom + gap - f.top }),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, anchor, width, height, gap, edge, offsetX, narrow, align, alignTo])
  return style
}
