// Chats a window at a time, the way T3 Code loads them. The list holds summaries
// (a preview of each chat's last turn); opening a chat reads its latest window
// (GET /api/threads/<id>?turns=10) and "Load earlier" pages back with `before`.
// Pure functions: the store calls them, and the iPhone app keeps a byte-for-byte
// copy at mobile/src/lib/chat/history.ts.
import type { ChatMessage, ChatThread } from './types'

/** Turns in a page: the same as the bridge's PAGE_TURNS. */
export const PAGE_TURNS = 10

/** What GET /api/threads/<id>?turns=N answers: the chat with one window of messages. */
export type ThreadPage = ChatThread & { history: { hasMore: boolean; before: string | null } }

/** The chat has real messages loaded (not a summary's preview). */
export const isLoaded = (t: ChatThread | undefined | null): t is ChatThread => !!t && !t.summary

const same = (a: ChatMessage, b: ChatMessage) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Keep the old object for every message that did not change, so memoised rows don't redraw. */
function reuse(next: ChatMessage[], prev: ChatMessage[]): ChatMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]))
  return next.map((m) => {
    const old = byId.get(m.id)
    return old && same(old, m) ? old : m
  })
}

/**
 * The chat's latest window arrived. Older pages already loaded stay when the
 * window overlaps them (its first message is one we have); otherwise the window
 * replaces everything and its own `history` says what's left.
 */
export function mergeLatest(existing: ChatThread | undefined, page: ThreadPage): ChatThread {
  const { history, summary: _flag, ...rest } = page
  // A page does not repeat the list's firstUserText; keep it for threadTitle.
  const thread: ChatThread = rest.firstUserText || !existing?.firstUserText ? rest : { ...rest, firstUserText: existing.firstUserText }
  if (!isLoaded(existing) || !page.messages.length) return { ...thread, history }
  const at = existing.messages.findIndex((m) => m.id === page.messages[0].id)
  if (at < 0) return { ...thread, messages: reuse(page.messages, existing.messages), history }
  return {
    ...thread,
    messages: [...existing.messages.slice(0, at), ...reuse(page.messages, existing.messages.slice(at))],
    history: at > 0 ? existing.history || history : history,
  }
}

/** An older page arrived: put it in front, dropping any message already there. */
export function mergeEarlier(existing: ChatThread, page: ThreadPage): ChatThread {
  const have = new Set(existing.messages.map((m) => m.id))
  const older = page.messages.filter((m) => !have.has(m.id))
  return { ...existing, messages: [...older, ...existing.messages], history: page.history }
}

/**
 * A summary from the list. A chat not opened yet takes it whole. An opened one
 * keeps its messages and takes the rest; `stale` says its latest window must be
 * read again because the chat changed on the bridge since.
 */
export function mergeSummary(existing: ChatThread | undefined, summary: ChatThread): { thread: ChatThread; stale: boolean } {
  if (!isLoaded(existing)) return { thread: summary, stale: false }
  const { messages: _preview, summary: _flag, ...meta } = summary
  // An unsent message is this device's own, never the bridge's.
  const lastLocal = existing.messages.filter((m) => !m.unsent).pop()
  const lastRemote = summary.messages[summary.messages.length - 1]
  const stale = summary.updatedAt !== existing.updatedAt
    || (summary.messageCount ?? -1) !== (existing.messageCount ?? -2)
    || (lastRemote?.id ?? null) !== (lastLocal?.id ?? null)
  // What the bridge works out on each read (when the chat's task was finished) is the summary's,
  // there or not: a task reopened since takes it away without the chat itself changing.
  const { taskDoneAt: _read, ...kept } = existing
  return { thread: { ...kept, ...meta, messages: existing.messages, history: existing.history }, stale }
}

/** How much of a message's text a summary keeps: the bridge's SUMMARY_TEXT. */
export const SUMMARY_TEXT = 400
const WAITING = new Set(['inbox', 'questions', 'approval'])
const pendingParts = (m: ChatMessage) => (m.parts || []).filter((p) => WAITING.has(p.type) && (p as { status?: string }).status === 'pending')
const cut = (text: string) => (text.length > SUMMARY_TEXT ? `${text.slice(0, SUMMARY_TEXT)}…` : text)

/**
 * A loaded chat as the bridge would summarise it (chat/store.mjs threadSummary),
 * for a client's paint cache: the last turn cut, with the parts still waiting on
 * the owner, and earlier messages that hold such a part as stubs with no text.
 */
export function summarize(t: ChatThread): ChatThread {
  if (!isLoaded(t)) return t
  const msgs = t.messages
  let from = msgs.length
  while (from > 0 && msgs.length - from < 3) {
    from--
    if (msgs[from].role === 'user') break
  }
  const waiting = msgs.slice(0, from).filter((m) => pendingParts(m).length)
    .map((m): ChatMessage => ({ id: m.id, role: m.role, content: '', createdAt: m.createdAt, parts: pendingParts(m) }))
  const tail = msgs.slice(from).map((m): ChatMessage => {
    const { parts: _parts, content, ...rest } = m
    const parts = pendingParts(m)
    return { ...rest, content: cut(content), ...(parts.length ? { parts } : {}) }
  })
  const first = msgs.find((m) => m.role === 'user')
  const firstUserText = t.firstUserText || (first && msgs.indexOf(first) < from ? first.content.replace(/\s+/g, ' ').trim().slice(0, 160) : undefined)
  const { history: _history, ...meta } = t
  return { ...meta, summary: true, messageCount: Math.max(t.messageCount || 0, msgs.length), messages: [...waiting, ...tail], ...(firstUserText ? { firstUserText } : {}) }
}
