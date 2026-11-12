// The CLIProxy tab's calls (cliproxy/http.mjs). Changes are approval routes, so
// api() adds this device's approval code to them (approvalCode.ts).
import { useCallback, useEffect, useState } from 'react'
import { api, AuthError } from '../api'
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

export interface GrantInfo {
  eligible: boolean
  ineligibleReason: string | null
  atLimit: boolean
  left: number
  grantId: string | null
  blocker: string | null
  cooldownUntil: string | null
  pending: { grantId: string; at: number } | null
}

const post = <T = { ok: boolean }>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) })
const q = (name: string) => `?name=${encodeURIComponent(name)}`

/** `retry` sends a key the proxy refused once more (the owner fixed the proxy side). */
export const getProxy = (retry = false) => api<ProxyOverview>(`/api/cliproxy${retry ? '?retry=1' : ''}`)
export const getProxyStatus = () => api<{ configured: boolean }>('/api/cliproxy/status')
export interface ProxyHistorySample {
  t: number
  accountId: string
  provider: string
  source: 'active' | 'passive'
  windows: Record<string, { used: number; resetAtMs: number | null; windowMinutes: number | null }>
}
export interface ProxyHistory { supported: boolean; samples: ProxyHistorySample[] }
export const getProxyHistory = () => api<ProxyHistory>('/api/cliproxy/history')
export const setAccountDisabled = (name: string, disabled: boolean) => post('/api/cliproxy/accounts/status', { name, disabled })
export const patchAccount = (name: string, fields: { note?: string; priority?: number | null; weight?: number | null; websockets?: boolean }) =>
  post('/api/cliproxy/accounts/fields', { name, ...fields })
export const refreshAccountLogin = (name: string) => post('/api/cliproxy/accounts/refresh', { name })
export const refreshAllLogins = () => post<{ ok: boolean; results: { name: string; ok: boolean; error?: string }[] }>('/api/cliproxy/accounts/refresh', { all: true })
export const resetAccountCooldown = (name: string) => post('/api/cliproxy/accounts/cooldown', { name })
export const deleteAccount = (name: string) => post('/api/cliproxy/accounts/delete', { name })
export const getAccountModels = (name: string) => api<{ models: { id: string; name: string | null }[] }>(`/api/cliproxy/accounts/models${q(name)}`)
export const startLogin = (provider: 'claude' | 'codex') =>
  post<{ state: string; url: string; provider: string; expiresAt: number; callback: string }>('/api/cliproxy/login', { provider })
export const submitLoginCallback = (state: string, url: string) => post<{ ok: boolean; expiresAt?: number }>('/api/cliproxy/login/callback', { state, url })
export const getLoginStatus = (state: string) =>
  api<{ status: 'wait' | 'ok' | 'error'; error?: string; added?: string | null; updated?: string | null; duplicate?: string | null }>(`/api/cliproxy/login?state=${encodeURIComponent(state)}`)
export const cancelLogin = (state: string) => post('/api/cliproxy/login/cancel', { state })
export const getGrants = (name: string) => api<GrantInfo>(`/api/cliproxy/grants${q(name)}`)
export const claimGrant = (name: string, grantId?: string | null) => post<{ result: string; retryable?: boolean }>('/api/cliproxy/grants/claim', { name, grantId: grantId || undefined })
export const getCredits = (name: string) => api<{ available: number; credits: { expiresAt: string }[] }>(`/api/cliproxy/credits${q(name)}`)
export const consumeCredit = (name: string) => post<{ result: string; retryable?: boolean }>('/api/cliproxy/credits/consume', { name })

/** Fired by Settings → Providers › CLIProxy after a save. */
export const INTEGRATIONS_SAVED = 'totem:integrations-saved'

/** Whether the rail shows the tab: one cheap call once signed in, and after each Integrations save. */
export function useCliproxyStatus(unlocked: boolean, onAuthError: () => void) {
  const [configured, setConfigured] = useState(false)
  const refresh = useCallback(() => getProxyStatus()
    .then((s) => setConfigured(Boolean(s.configured)))
    .catch((e) => { if (e instanceof AuthError) onAuthError() }), [onAuthError])
  useEffect(() => {
    if (!unlocked) return
    void refresh()
    // Saving the proxy in Settings → Providers should bring the tab in at once.
    window.addEventListener(INTEGRATIONS_SAVED, refresh)
    return () => window.removeEventListener(INTEGRATIONS_SAVED, refresh)
  }, [unlocked, refresh])
  return { configured, refresh }
}
