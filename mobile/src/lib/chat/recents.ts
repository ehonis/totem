// The Overview's "Recent chats": the chats to get back into. First the ones with
// words still in their composer (an unsent draft), then the ones most recently
// opened here or answered. Totems' own chats and temporary chats stay out. Pure.
import type { ChatThread } from './types'

export const OPENED_KEY = 'totem.chat.opened.v1'
export const DRAFTS_KEY = 'totem.chat.drafts'
const OPENED_MAX = 200

export interface RecentChat { thread: ChatThread; draft: string | null; at: number }

const hasContent = (t: ChatThread) => t.messages.length > 0 || (t.messageCount || 0) > 0

export function recentChats(
  threads: readonly ChatThread[],
  { drafts = {}, opened = {}, limit = 4, now = Date.now() }: { drafts?: Record<string, string>; opened?: Record<string, number>; limit?: number; now?: number } = {},
): RecentChat[] {
  const rows: RecentChat[] = []
  for (const t of threads) {
    if (t.totemId || t.kind === 'temporary' || !hasContent(t)) continue
    if (t.expiresAt && t.expiresAt <= now) continue
    const draft = (drafts[t.id] || '').trim() || null
    rows.push({ thread: t, draft, at: Math.max(opened[t.id] || 0, t.updatedAt || 0) })
  }
  return rows
    .sort((a, b) => (a.draft ? 0 : 1) - (b.draft ? 0 : 1) || b.at - a.at)
    .slice(0, limit)
}

/** Record that a chat was opened; the oldest marks go past OPENED_MAX. */
export function markOpened(opened: Record<string, number>, id: string, at: number): Record<string, number> {
  const next = { ...opened, [id]: at }
  const ids = Object.keys(next)
  if (ids.length <= OPENED_MAX) return next
  return Object.fromEntries(ids.sort((a, b) => next[b] - next[a]).slice(0, OPENED_MAX).map((k) => [k, next[k]]))
}

export function readJson<T>(storage: { getItem(k: string): string | null }, key: string, fallback: T): T {
  try {
    const v = JSON.parse(storage.getItem(key) || 'null')
    return v && typeof v === 'object' && !Array.isArray(v) ? v as T : fallback
  } catch { return fallback }
}
