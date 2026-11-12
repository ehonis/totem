// Ported from web/src/usageMeta.tsx: the usage vocabulary (number formatting,
// channel and provider colours) the Usage pane shares with the web. The web's
// drawn pieces (ProductIcon, Meter, ActivityChart) are native components in
// features/settings/usage/ instead.
import {
  ChatBubbleLeftRightIcon,
  DevicePhoneMobileIcon,
  SunIcon,
  DocumentTextIcon,
  ServerStackIcon,
} from './icons'

// ---- Number / time formatting ----
export const fmtInt = (n: number | null | undefined) => (n == null ? '-' : n.toLocaleString())
export const fmtUsd = (n: number | null | undefined) => (n == null ? '-' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
export const fmtTok = (n: number | null | undefined) => {
  if (n == null) return '-'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

export function relTime(ms: number | null | undefined): string | null {
  if (!ms) return null
  const diff = Date.now() - ms
  const s = Math.round(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// Where Totem actually got used - the real surface behind each channel id.
export const CHANNEL_ORDER = ['web', 'http', 'mcp', 'morning', 'journal']
export const CHANNEL_META: Record<string, any> = {
  web: { label: 'Web app', icon: ChatBubbleLeftRightIcon, color: '#2563eb' },
  http: { label: 'iOS Shortcut', icon: DevicePhoneMobileIcon, color: '#16a34a' },
  mcp: { label: 'External client (MCP)', icon: ServerStackIcon, color: '#14b8a6' },
  morning: { label: 'Morning briefing', icon: SunIcon, color: '#f59e0b' },
  journal: { label: 'Journal ingest', icon: DocumentTextIcon, color: '#a855f7' },
}

// Which agent backend served each request. Order pins the four known providers
// first; any other id falls through with a generic label/color.
export const PROVIDER_ORDER = ['cursor', 'codex', 'claude', 'opencode']
export const PROVIDER_META: Record<string, any> = {
  cursor: { label: 'Cursor', color: '#5b8cff' },
  codex: { label: 'Codex', color: '#f3f4f6' },
  claude: { label: 'Claude Code', color: '#d97757' },
  opencode: { label: 'OpenCode', color: '#f0506e' },
}
