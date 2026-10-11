// Client for /api/screen/* — the desktop of the machine Totem runs on
// (screen/ on the server). Status answers 404 with the same body when the
// screen is off, so the view can say why rather than just "not found".

import { AuthError, api, authHeaders } from '../api'

export interface ScreenPart { state: string; detail?: string }

export interface ScreenStatus {
  enabled: boolean
  state: 'ready' | 'partial' | 'unavailable' | 'off'
  detail?: string
  platform?: string
  node?: string
  wsPath?: string
  viewer?: ScreenPart
  screenshots?: ScreenPart
  /** The "remember for" choices the bridge accepts, in minutes. */
  rememberMinutes?: number[]
}

export async function getScreenStatus(): Promise<ScreenStatus> {
  const r = await fetch('/api/screen/status', { headers: authHeaders() })
  if (r.status === 401) throw new AuthError()
  const body = await r.json().catch(() => ({}))
  if (r.status === 404) return { enabled: false, state: 'off', detail: body?.detail }
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`)
  return body as ScreenStatus
}

export const screenEnabled = (s: ScreenStatus | null) => !!s && s.enabled && s.state !== 'off'

// "Remember for …": the bridge seals the Mac login and hands back a token; the
// browser keeps only that token (never the password) and trades it back for the
// login on the next connect, until it expires. screen/credentials.mjs.
export interface MacLogin { username?: string; password: string }

export const sealLogin = (login: MacLogin, minutes: number) =>
  api<{ token: string; expiresAt: string }>('/api/screen/credentials/seal', { method: 'POST', body: JSON.stringify({ ...login, minutes }) })

export const openLogin = (token: string) =>
  api<MacLogin & { expiresAt: string }>('/api/screen/credentials/open', { method: 'POST', body: JSON.stringify({ token }) })

const SAVED_KEY = 'totem.screen.login'
const CHOICE_KEY = 'totem.screen.rememberMinutes'

/** The saved token, if it has not expired yet. */
export function savedLogin(): { token: string; expiresAt: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null')
    if (saved?.token && Date.parse(saved.expiresAt) > Date.now()) return saved
  } catch {}
  localStorage.removeItem(SAVED_KEY)
  return null
}
export const saveLogin = (saved: { token: string; expiresAt: string }) => localStorage.setItem(SAVED_KEY, JSON.stringify(saved))
export const forgetLogin = () => localStorage.removeItem(SAVED_KEY)

/** The last "remember for" choice, 0 meaning "until this page reloads". */
export const rememberChoice = () => Number(localStorage.getItem(CHOICE_KEY)) || 0
export const setRememberChoice = (minutes: number) => localStorage.setItem(CHOICE_KEY, String(minutes))
