// Where the bridge is and how to prove we're the owner.
//
// The web dashboard is served by the bridge, so every call there is a relative
// path on the same origin. The app has no origin of its own: it keeps the
// bridge's base URL here and every request in api.ts goes through bridgeFetch,
// which prefixes it. The secret lives in the keychain (expo-secure-store), never
// in localStorage, and is cached in memory so authHeaders() stays synchronous
// for the code ported from the web.
//
// A bridge behind Cloudflare Access also needs an Access token (cfAccess.ts). It
// is kept beside the secret and sent as `cf-access-token` on every request; when
// Access stops accepting it, `accessNeeded` asks the UI to sign in again.
//
// The approval code (auth/approval-code.mjs on the bridge) is kept beside them in
// the keychain too, and sent only on the routes that confer approval
// (approvalCode.ts): the bearer secret alone approves nothing. It is stored with
// the base URL it was entered for and dropped when the app moves to another
// server, so one Totem's code is never sent to a different one.
import * as SecureStore from 'expo-secure-store'
import { useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
import { isAccessResponse } from './cfAccess'
import { readWhenUnlocked, type AppActivity } from './readWhenUnlocked'

const BASE_KEY = 'totem.bridge.base'
const SECRET_KEY = 'totem.bridge.secret'
const ACCESS_KEY = 'totem.bridge.cfAccess'
const APPROVAL_KEY = 'totem.bridge.approvalCode'

// expo-secure-store has no web implementation. The web build only exists for
// previewing layouts in a desktop browser, so it keeps the secret in localStorage.
const secure = Platform.OS === 'web'
  ? {
      getItemAsync: async (k: string) => localStorage.getItem(k),
      setItemAsync: async (k: string, v: string) => localStorage.setItem(k, v),
      deleteItemAsync: async (k: string) => localStorage.removeItem(k),
    }
  : SecureStore

export interface Connection {
  baseUrl: string
  secret: string
  /** Cloudflare Access app token, when the bridge sits behind Access. */
  accessToken?: string
  /** Access answered a request instead of the bridge: the token is missing or expired. */
  accessNeeded?: boolean
  /** This device's approval code, when the owner has entered or set one here. */
  approvalCode?: string
}

let current: Connection = { baseUrl: '', secret: '' }
const subs = new Set<() => void>()
const emit = () => subs.forEach((fn) => fn())

/**
 * What was typed, to a base URL with no trailing slash. A full URL is kept. An
 * IP, `localhost`, a bare machine name or a Tailscale/LAN name (`*.ts.net`,
 * `*.local`) is the bridge itself: http on its port (8787 unless given). Any other
 * domain is a published one (a Cloudflare tunnel, a proxy): https on 443.
 */
export function normalizeBaseUrl(input: string, defaultPort = '8787'): string {
  const raw = String(input || '').trim().replace(/\/+$/g, '')
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  const host = raw.replace(/:\d+$/, '')
  const hasPort = /:\d+$/.test(raw)
  const direct = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || !host.includes('.') || /\.(ts\.net|local)$/i.test(host) || hasPort
  if (!direct) return `https://${raw}`
  return `http://${raw}${hasPort ? '' : `:${defaultPort}`}`
}

interface Stored { baseUrl: string; secret: string; accessToken: string; approvalRaw: string | null }
type KeychainGet = (key: string) => Promise<string | null>

/** Everything kept on the device. With the plain keychain getter it throws if a read is refused (a locked phone). */
async function readStored(get: KeychainGet): Promise<Stored> {
  const baseUrl = localStorage.getItem(BASE_KEY) || ''
  const secret = (await get(SECRET_KEY)) || ''
  const accessToken = (await get(ACCESS_KEY)) || ''
  const approvalRaw = await get(APPROVAL_KEY)
  return { baseUrl, secret, accessToken, approvalRaw }
}

/** Only once the reads have failed in the foreground: each refused item counts as absent. */
const lenientGet: KeychainGet = (key) => secure.getItemAsync(key).catch(() => null)

const appActivity: AppActivity = {
  isActive: () => AppState.currentState === 'active',
  untilActive: () => new Promise<void>((resolve) => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') { sub.remove(); resolve() }
    })
    // It may have come to the foreground before the listener was added.
    if (AppState.currentState === 'active') { sub.remove(); resolve() }
  }),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

let loading: Promise<Connection> | null = null

/**
 * Read the connection once. A keychain that refuses the read (the app started in
 * the background on a locked phone) is not a signed-out app: this waits until the
 * app is opened and reads again (readWhenUnlocked.ts), so it can settle late.
 */
export function loadConnection(): Promise<Connection> {
  loading ??= (async () => {
    const outcome = await readWhenUnlocked(() => readStored((key) => secure.getItemAsync(key)), appActivity)
    if (!outcome.ok) console.warn('[connection] keychain unreadable in the foreground; treating it as signed out', outcome.error)
    const { baseUrl, secret, accessToken, approvalRaw } = outcome.ok ? outcome.value : await readStored(lenientGet)
    const approvalCode = boundCode(approvalRaw, baseUrl)
    current = { baseUrl, secret, ...(accessToken ? { accessToken } : {}), ...(approvalCode ? { approvalCode } : {}) }
    emit()
    return current
  })()
  return loading
}

export async function saveConnection(next: Connection) {
  localStorage.setItem(BASE_KEY, next.baseUrl)
  if (next.secret) await secure.setItemAsync(SECRET_KEY, next.secret)
  else await secure.deleteItemAsync(SECRET_KEY).catch(() => {})
  if (next.accessToken) await secure.setItemAsync(ACCESS_KEY, next.accessToken)
  else await secure.deleteItemAsync(ACCESS_KEY).catch(() => {})
  // Another server: the code entered for the last one is not this one's.
  const sameServer = next.baseUrl === current.baseUrl
  if (!sameServer) await secure.deleteItemAsync(APPROVAL_KEY).catch(() => {})
  current = { ...next, approvalCode: sameServer ? current.approvalCode : '', accessNeeded: false }
  emit()
}

/** The stored code, only if it was saved for this base URL. */
function boundCode(raw: string | null, baseUrl: string): string {
  try {
    const saved = JSON.parse(raw || '')
    return saved?.baseUrl === baseUrl && typeof saved.code === 'string' ? saved.code : ''
  } catch {
    return ''
  }
}

/** Sign out: forget the secret and the approval code, keep the address so signing back in is one field. */
export async function clearSecretStored() {
  await secure.deleteItemAsync(SECRET_KEY).catch(() => {})
  await secure.deleteItemAsync(APPROVAL_KEY).catch(() => {})
  current = { ...current, secret: '', approvalCode: '' }
  emit()
}

/** Keep (or, with '', forget) this device's approval code. */
export async function saveApprovalCode(code: string) {
  const value = code.trim()
  if (value) await secure.setItemAsync(APPROVAL_KEY, JSON.stringify({ baseUrl: current.baseUrl, code: value }))
  else await secure.deleteItemAsync(APPROVAL_KEY).catch(() => {})
  current = { ...current, approvalCode: value }
  emit()
}

/** A fresh Access token after signing in again; requests pick it up at once. */
export async function saveAccessToken(token: string) {
  await secure.setItemAsync(ACCESS_KEY, token)
  current = { ...current, accessToken: token, accessNeeded: false }
  emit()
}

/** The header Access reads, merged into whatever headers a request already has. */
export function withAccess(headers: Record<string, string> = {}): Record<string, string> {
  return current.accessToken ? { 'cf-access-token': current.accessToken, ...headers } : headers
}

function markAccessNeeded() {
  if (current.accessNeeded) return
  current = { ...current, accessNeeded: true }
  emit()
}

export const getConnection = () => current
export const getBaseUrl = () => current.baseUrl
export const getStoredSecret = () => current.secret
export const getStoredApprovalCode = () => current.approvalCode || ''
export const isConnected = () => Boolean(current.baseUrl && current.secret)

/** An absolute URL for a bridge path. Absolute URLs pass through untouched. */
export function bridgeUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${current.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
}

/** fetch() against the bridge. Callers pass their own headers (authHeaders()); the Access token is added here too. */
export async function bridgeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init.headers as Record<string, string> | undefined) }
  const r = await fetch(bridgeUrl(path), { ...init, headers: withAccess(headers) })
  if (isAccessResponse(r)) markAccessNeeded()
  return r
}

export function subscribeConnection(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }
export function useConnection(): Connection {
  return useSyncExternalStore(subscribeConnection, getConnection, getConnection)
}
