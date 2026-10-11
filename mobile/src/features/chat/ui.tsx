// The chat's shared bits (web chat/ui.tsx and the --vc-* tokens at the top of
// chat.css): Tabler at Heroicons' weight, provider logos, what a tool call is.
import React from 'react'
import { Image, View, type StyleProp, type ViewStyle } from 'react-native'
import { Hi, type IconType } from '../../lib/icons'
import { DRIVER_LOGOS } from '../../lib/providers'
import { textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import {
  IconBrandGithub, IconBrandStrava, IconCalendarEvent, IconChecklist, IconDeviceDesktop, IconFileText, IconListCheck,
  IconMicrophone, IconTarget, IconTerminal2, IconTool, IconWorld, IconBrain, IconMail, IconNotebook, IconPhoto,
  IconSearch, IconPencil, IconDatabase, IconRobot,
} from './icons'

/** chat.css `.vc` custom properties. */
export const vc = {
  text: textAlpha(94),
  soft: textAlpha(62),
  faint: textAlpha(40),
  bubble: '#232733',
  surface: '#171a22',
  raise: '#1f2330',
  line: '#2a2f3c',
  menu: '#1a1d26',
  code: '#0b0d12',
} as const

/** A Tabler icon at Heroicons' visual weight (stroke 1.75). */
export function TI({ icon, size = 18, color = vc.soft, stroke = 1.75, style }: { icon: IconType; size?: number; color?: string; stroke?: number; style?: StyleProp<ViewStyle> }) {
  return <Hi icon={icon} size={size} color={color} strokeWidth={stroke} style={style} />
}

// The CLIs' marks are black glyphs; the web inverts them (filter: invert(1) brightness(.92)).
const TINTED = new Set(['codex', 'cursor', 'opencode'])

export function ProviderLogo({ driver, name, size = 16 }: { driver?: string; name?: string; size?: number }) {
  const src = DRIVER_LOGOS[driver || '']
  if (!src) {
    return (
      <View style={{ width: size, height: size, borderRadius: 4, backgroundColor: vc.raise, alignItems: 'center', justifyContent: 'center' }}>
        <T size={Math.max(8, size * 0.6)} weight={700} color={vc.soft} lineHeight={size}>{(name || '?').slice(0, 1).toUpperCase()}</T>
      </View>
    )
  }
  return <Image source={src} style={{ width: size, height: size, borderRadius: 4, ...(TINTED.has(driver || '') ? { tintColor: '#ebebeb' } : {}) }} />
}

// The Totem app behind a tool call, for the card's icon and label.
const APPS: Record<string, { icon: IconType; label: string }> = {
  tasks: { icon: IconChecklist, label: 'Tasks' },
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

const KINDS: Record<string, IconType> = {
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

export function toolIcon(kind: string, server?: string, detail?: string): IconType {
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
