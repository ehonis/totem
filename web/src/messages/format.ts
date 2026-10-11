// Pure helpers for the Messages view: times, previews, how a thread breaks into
// runs, and how a poll merges into what is already loaded. No React, no fetch,
// so the tests can pin them down.

import type { ChatSummary, Message, MessageAttachment } from './api'

const DAY = 86_400_000
/** A gap this long in a thread gets its own timestamp line. */
export const DIVIDER_GAP_MS = 60 * 60_000
/** Messages from one person closer together than this read as one run. */
export const RUN_GAP_MS = 5 * 60_000

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b) - startOfDay(a)) / DAY)

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** The conversation list's time: "3:42 PM" today, then "Yesterday", a weekday, a date. */
export function listTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = daysBetween(d, now)
  if (days <= 0) return clock(d)
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' })
}

/** A timestamp line inside a thread: "Today 3:42 PM", "Monday 9:10 AM", "Sep 12, 9:10 AM". */
export function dividerTime(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = daysBetween(d, now)
  if (days <= 0) return `Today ${clock(d)}`
  if (days === 1) return `Yesterday ${clock(d)}`
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${clock(d)}`
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}, ${clock(d)}`
}

/** The second line of a conversation row. */
export function previewText(last: ChatSummary['last']): string {
  if (!last) return ''
  const text = (last.text || '').replace(/\s+/g, ' ').trim() || 'Attachment'
  return last.fromMe ? `You: ${text}` : text
}

export const isImage = (a: MessageAttachment) => !!a.mime && a.mime.startsWith('image/')
export const isVideo = (a: MessageAttachment) => !!a.mime && a.mime.startsWith('video/')

export function fileSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** "Ada loved", or "You liked" for the owner's own tapback. */
export const reactionLabel = (r: { by: string; kind: string }) => `${r.by === 'Me' ? 'You' : r.by} ${r.kind}`

export interface ThreadItem {
  message: Message
  /** Timestamp line above this message, if one belongs there. */
  divider: string | null
  /** Sender name above the bubble (group chats, others' messages, first of a run). */
  showSender: boolean
  /** First / last message of a run from one sender — spacing and the bubble tail. */
  first: boolean
  last: boolean
}

/** Lay a thread out: where the timestamp lines go and where each sender's run starts and ends. */
export function layoutThread(messages: Message[], isGroup: boolean, now = new Date()): ThreadItem[] {
  const who = (m: Message) => (m.fromMe ? '\u0000me' : m.sender || '')
  const time = (m: Message) => new Date(m.at).getTime()
  const items: ThreadItem[] = messages.map((m, i) => {
    const prev = messages[i - 1]
    const divider = !prev || time(m) - time(prev) >= DIVIDER_GAP_MS ? dividerTime(m.at, now) : null
    const first = !prev || !!divider || who(prev) !== who(m) || time(m) - time(prev) >= RUN_GAP_MS
    return { message: m, divider, first, last: true, showSender: isGroup && !m.fromMe && first }
  })
  for (let i = 0; i < items.length - 1; i++) items[i].last = items[i + 1].first
  return items
}

/**
 * Fold a fresh "newest page" (from a poll or after a send) into a thread that
 * may already hold older pages. The fresh page wins for anything it covers
 * (reactions, read receipts change); older messages outside it are kept.
 */
export function mergeLatest(existing: Message[], latest: Message[]): Message[] {
  if (!latest.length) return existing
  const ids = new Set(latest.map((m) => m.id))
  const oldest = new Date(latest[0].at).getTime()
  const kept = existing.filter((m) => !ids.has(m.id) && new Date(m.at).getTime() <= oldest)
  return [...kept, ...latest]
}

/** Put an older page in front of what is loaded, without doubling any message. */
export function prependOlder(existing: Message[], older: Message[]): Message[] {
  const ids = new Set(existing.map((m) => m.id))
  return [...older.filter((m) => !ids.has(m.id)), ...existing]
}

/** Initials for a conversation's avatar: "AL" for Ada Lovelace, "#" for a bare number. */
export function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  if (!words.length || /^\d/.test(words[0])) return '#'
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
}
