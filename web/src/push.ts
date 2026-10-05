// Web Push, from the browser side.
//
// Everything here has to cope with iOS's rules, which are stricter than the spec
// and fail quietly rather than loudly:
//
//   * Push works only in a web app added to the Home Screen. In a Safari tab the
//     APIs exist but subscribing never produces a usable subscription, so the UI
//     has to detect standalone mode and explain, not show a dead toggle.
//   * Permission is requested once, from a user gesture. A denial sticks until the
//     app is removed from the Home Screen and re-added — there is no second prompt.
//   * Removing the web app destroys the subscription and its storage silently.
import { authHeaders as bridgeHeaders } from './api'

export type PushState = {
  supported: boolean
  standalone: boolean
  permission: NotificationPermission | 'unsupported'
  subscribed: boolean
  // Why the toggle cannot be used, in words that say what to do about it.
  blocker: string | null
}

const authHeaders = () => bridgeHeaders({ 'content-type': 'application/json' })

// iOS reports an installed web app through a non-standard navigator flag; every
// other platform uses the display-mode media query.
export function isStandalone(): boolean {
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone
  if (typeof iosStandalone === 'boolean' && iosStandalone) return true
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false
}

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export async function readPushState(): Promise<PushState> {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const standalone = isStandalone()
  const permission = supported ? Notification.permission : 'unsupported'

  let subscribed = false
  if (supported) {
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      subscribed = Boolean(await reg?.pushManager.getSubscription())
    } catch {
      subscribed = false
    }
  }

  let blocker: string | null = null
  if (!supported) {
    blocker = 'This browser has no Push API.'
  } else if (isIos() && !standalone) {
    blocker = 'On iOS, notifications only work once Totem is on your Home Screen. '
      + 'Open Totem in Safari, tap Share, then "Add to Home Screen", and open it from there.'
  } else if (permission === 'denied') {
    blocker = isIos()
      ? 'Notifications were declined. iOS will not ask again — remove Totem from your Home Screen, re-add it, and allow notifications when asked.'
      : 'Notifications are blocked for this site in your browser settings.'
  }

  return { supported, standalone, permission, subscribed, blocker }
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  // Served from the origin root so it can claim the whole scope; see web/public/sw.js.
  return navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

// The applicationServerKey has to be raw bytes, not the base64url string the
// server sends.
// Backed by an explicitly allocated ArrayBuffer: `Uint8Array.from` widens to
// `Uint8Array<ArrayBufferLike>`, which no longer satisfies the BufferSource
// that `pushManager.subscribe` wants for applicationServerKey.
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const encodeKey = (buffer: ArrayBuffer | null): string => {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Must be called from a user gesture: iOS refuses the permission prompt otherwise,
// and counts the refusal against the one chance the app gets.
export async function subscribeToPush(label?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const keyResponse = await fetch('/api/push/key', { headers: authHeaders() })
    const { publicKey, configured } = await keyResponse.json()
    if (!configured || !publicKey) {
      return { ok: false, error: 'The server has no VAPID keys yet. Run `node notify/cli.mjs keys` and add them to .env.' }
    }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return { ok: false, error: 'Notification permission was not granted.' }

    const registration = await registerServiceWorker()
    // A fresh install can resolve `register` before the worker is usable.
    await navigator.serviceWorker.ready

    const existing = await registration.pushManager.getSubscription()
    const subscription = existing ?? await registration.pushManager.subscribe({
      // Non-negotiable on every browser, and on iOS a push that shows nothing can
      // cost the subscription.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    })

    const json = subscription.toJSON() as { endpoint?: string; keys?: Record<string, string> }
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        subscription: {
          endpoint: json.endpoint ?? subscription.endpoint,
          keys: json.keys ?? {
            p256dh: encodeKey(subscription.getKey('p256dh')),
            auth: encodeKey(subscription.getKey('auth')),
          },
        },
        label: label || defaultLabel(),
        userAgent: navigator.userAgent,
      }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      return { ok: false, error: body.error || `The server refused the subscription (HTTP ${response.status}).` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {})
  await subscription.unsubscribe()
}

export async function sendTestPush(body?: { title?: string; body?: string }) {
  const response = await fetch('/api/push/test', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body || {}),
  })
  return response.json()
}

export const getDevices = async () => {
  const response = await fetch('/api/push/subscriptions', { headers: authHeaders() })
  return response.json()
}

function defaultLabel(): string {
  if (isIos()) return /iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone'
  if (/Android/.test(navigator.userAgent)) return 'Android'
  if (/Mac/.test(navigator.platform)) return 'Mac'
  return 'This device'
}

// Called on boot. A notification tap lands on /whatever?n=<entryId>; reporting it
// back is the strongest feedback signal there is and costs the user nothing.
export function reportNotificationOpen(): void {
  const params = new URLSearchParams(window.location.search)
  const entryId = params.get('n')
  if (!entryId) return
  fetch('/api/push/opened', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ entryId }),
  }).catch(() => {})
  // Take it back out of the URL so a refresh does not report a second open.
  params.delete('n')
  const query = params.toString()
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
}

// ---------------------------------------------------------------------------
// The notification centre
// ---------------------------------------------------------------------------

export type HistoryItem = {
  id: string
  ts: number
  title: string
  body: string
  url: string | null
  category: string
  level: string
  read: boolean
  entryId: string | null
  factKind: string | null
  ratable: boolean
  openedAt: number | null
  state: string
  feedback: { vote: 'up' | 'down'; reasons: string[]; at: number } | null
}

export type Upcoming = {
  id: string
  title: string
  body: string
  deliverAt: number
  category: string
  factKind: string | null
  source: string | null
}

export type WeightRow = {
  kind: string
  category: string | null
  multiplier: number
  up: number
  down: number
  opened: number
  ignored: number
  acted: number
  delivered: number
  pinned: boolean
  because: string
}

const json = async (url: string) => {
  const r = await fetch(url, { headers: authHeaders() })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}
const post = async (url: string, body: unknown = {}) => {
  const r = await fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export const getNotificationHistory = (): Promise<{ items: HistoryItem[]; unread: number; upcoming: Upcoming[] }> =>
  json('/api/push/history')

export const markNotificationsRead = (ids?: string[]) => post('/api/push/read', ids ? { ids } : {})

export const rateNotification = (
  item: HistoryItem,
  vote: 'up' | 'down',
  reasons: string[] = [],
) => post('/api/push/feedback', {
  entryId: item.entryId,
  category: item.category,
  factKind: item.factKind,
  vote,
  reasons,
})

export const getWeights = (): Promise<{ weights: WeightRow[]; categories: Record<string, string> }> =>
  json('/api/push/weights')

export const resetWeights = (factKind?: string) => post('/api/push/weights/reset', factKind ? { factKind } : {})

// Why a notification was not wanted. The chip is the whole point: "I disliked
// this" does not say whether the fact was wrong, the timing was wrong, the
// wording was wrong or there were simply too many, and those have opposite fixes.
export const DOWNVOTE_REASONS: { id: string; label: string; hint: string }[] = [
  { id: 'not-useful', label: 'Not useful', hint: 'Send this kind less often.' },
  { id: 'wrong-time', label: 'Wrong time', hint: 'Right thing, wrong moment.' },
  { id: 'too-many', label: 'Too many', hint: 'Too much on one day.' },
  { id: 'badly-worded', label: 'Badly worded', hint: 'Right fact, bad sentence.' },
  { id: 'already-done', label: 'Already done it', hint: "It should have known. That's a bug, not a preference." },
]
