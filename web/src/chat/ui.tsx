import React from 'react'
import { DRIVER_LOGOS } from '../providers'
import {
  IconBrandGithub, IconBrandStrava, IconCalendarEvent, IconChecklist, IconDeviceDesktop, IconFileText, IconListCheck,
  IconMicrophone, IconTarget, IconTerminal2, IconTool, IconWorld, IconBrain, IconMail, IconNotebook, IconPhoto,
  IconSearch, IconPencil, IconDatabase,
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
  'computer-use': { icon: IconDeviceDesktop, label: 'Computer' },
  computer_use: { icon: IconDeviceDesktop, label: 'Computer' },
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
}

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
