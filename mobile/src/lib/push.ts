// The notification centre's half of web/src/push.ts. Web Push subscription is a
// browser thing; the app registers for native push separately (see notifications/).
import { authHeaders as bridgeHeaders } from './api'
import { bridgeFetch } from './connection'

const authHeaders = () => bridgeHeaders({ 'content-type': 'application/json' })
const fetch = bridgeFetch

export async function sendTestPush(body?: { title?: string; body?: string }) {
  const response = await fetch('/api/push/test', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}) })
  return response.json()
}

export const getDevices = async () => {
  const response = await fetch('/api/push/subscriptions', { headers: authHeaders() })
  return response.json()
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
