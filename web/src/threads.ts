// Chat threads. The bridge is the source of truth (one JSON file per thread, so
// history follows you across devices); localStorage is just an instant-render
// cache + offline fallback. Each thread:
//   { id, kind, messages: [{role:'user'|'assistant', content}], modelSettings, createdAt, updatedAt, expiresAt? }
import { getThreads, putThread, deleteThread as apiDeleteThread } from './api'

const KEY = 'chat_threads_v1'
const MIGRATED = 'chat_threads_migrated_v1'

export function loadThreads() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function saveThreads(threads: any) {
  try { localStorage.setItem(KEY, JSON.stringify(threads)) } catch {}
}

export function isTemporaryThread(thread: any) {
  return thread?.kind === 'temporary'
}

export function isExpiredThread(thread: any, now = Date.now()) {
  return isTemporaryThread(thread) && Number(thread.expiresAt || 0) > 0 && Number(thread.expiresAt) <= now
}

export function pruneExpiredThreads(threads: any, now = Date.now()) {
  const expired = []
  const kept = []
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (isExpiredThread(thread, now)) expired.push(thread)
    else kept.push(thread)
  }
  if (expired.length) {
    saveThreads(kept)
    for (const t of expired) removeThread(t.id)
  }
  return kept
}

// Pull server history (source of truth). On first run, push any threads that
// only existed in this browser's localStorage up to the server, once.
export async function syncThreads() {
  if (!localStorage.getItem(MIGRATED)) {
    for (const t of pruneExpiredThreads(loadThreads())) { try { await putThread(t) } catch {} }
    localStorage.setItem(MIGRATED, '1')
  }
  const { threads } = await getThreads()
  const live = pruneExpiredThreads(threads)
  saveThreads(live)
  return live
}

// Best-effort writes: the cache already holds the change, so network failures
// (offline) are non-fatal and just reconcile on the next syncThreads().
export function pushThread(thread: any) { putThread(thread).catch(() => {}) }
export function removeThread(id: string) { apiDeleteThread(id).catch(() => {}) }

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function threadTitle(thread: any) {
  const first = thread?.messages?.find((m: any) => m.role === 'user')
  const t = first?.content?.replace(/\s+/g, ' ').trim()
  if (t) return t.length > 46 ? t.slice(0, 46) + '…' : t
  return isTemporaryThread(thread) ? 'Temporary chat' : 'New chat'
}

export function relTime(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
