// The CLIProxy page's reads (cliproxy/http.mjs), ported from web/src/cliproxy/api.ts:
// the same paths and types. The phone only reads: every change to a login is an
// approval route the dashboard makes (docs/cliproxy.md → The CLIProxy tab).
import { getJSON } from '../api'
import type { UsageAccount, UsagePool } from '../usagePools'

export interface ProxyCooldown { scope: 'credential' | 'model'; model: string | null; reason: string | null; until: number }

export interface ProxyAccount extends UsageAccount {
  name: string
  note: string | null
  priority: number | null
  weight: number | null
  websockets: boolean | null
  runtimeOnly: boolean
  successCount: number
  failedCount: number
  recent: { success: number; failed: number }[]
  cooldowns: ProxyCooldown[]
  passive?: boolean
  activeError?: string | null
}

export interface ProxyOverview {
  configured: boolean
  url: string | null
  reachable?: boolean
  error?: string
  code?: string | null
  accounts: ProxyAccount[]
  pools?: UsagePool[]
  logins?: { state: string; provider: string; startedAt: number; url?: string; expiresAt?: number; submitted?: boolean }[]
}

export interface ProxyHistorySample {
  t: number
  accountId: string
  provider: string
  source: 'active' | 'passive'
  windows: Record<string, { used: number; resetAtMs: number | null; windowMinutes: number | null }>
}
export interface ProxyHistory { supported: boolean; samples: ProxyHistorySample[] }

/** `retry` sends a key the proxy refused once more (the owner fixed the proxy side). */
export const getProxy = (retry = false) => getJSON<ProxyOverview>(`/api/cliproxy${retry ? '?retry=1' : ''}`)
export const getProxyStatus = () => getJSON<{ configured: boolean }>('/api/cliproxy/status')
export const getProxyHistory = () => getJSON<ProxyHistory>('/api/cliproxy/history')
