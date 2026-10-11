// Client for /api/apple/* — Messages, Contacts and attachments on the Mac the
// bridge runs on (apple/ on the server). Kept apart from ../api.ts because
// these routes answer errors as `{ error, code }` with the code at the top
// level, and the code is what the view branches on ('no_access',
// 'automation_denied'); the shared helper only reads a nested one.

import { AuthError, authHeaders } from '../api'

export type AppleState = 'ready' | 'partial' | 'no-access' | 'error' | 'off' | 'unsupported'

export interface AppleSource { state: string; detail?: string; messages?: number; chats?: number }

export interface AppleStatus {
  enabled: boolean
  state: AppleState
  detail?: string
  node?: string
  sending?: string
  sources?: { messages?: AppleSource; contacts?: AppleSource; photos?: AppleSource }
}

export interface ChatParticipant { handle: string; name: string | null }

export interface ChatSummary {
  id: number
  guid: string
  title: string
  isGroup: boolean
  service: string
  identifier: string
  participants: ChatParticipant[]
  unread: number
  last: { at: string; fromMe: boolean; text: string } | null
}

export interface MessageAttachment { id: number; name: string | null; mime: string | null; bytes: number; sticker: boolean }
export interface MessageReaction { by: string; kind: string }

export interface Message {
  id: number
  at: string
  fromMe: boolean
  sender: string | null
  senderName: string | null
  text: string
  service: string
  attachments: MessageAttachment[]
  reactions: MessageReaction[]
  readAt?: string
  failed?: boolean
}

export interface ThreadPage { chat: ChatSummary; chatId: number; messages: Message[]; hasMore: boolean }

export interface SearchResult { messageId: number; chatId: number; chat: string; at: string; fromMe: boolean; sender: string | null; text: string }

export interface Contact {
  name: string
  phones: { number: string; label?: string | null }[]
  emails: { address: string; label?: string | null }[]
}

export interface SendResult { sent: boolean; recorded: boolean; failed: boolean; to: string; chatId: number | null; messageId: number | null }

/** An error from an Apple route, with the server's code and its words intact (they hold the fix). */
export class AppleError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message)
    this.name = 'AppleError'
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders(init.body ? { 'content-type': 'application/json' } : {})
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) throw new AuthError()
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = body?.error
    const message = typeof err === 'object' ? err?.message : err
    const code = body?.code ?? (typeof err === 'object' ? err?.code : null) ?? null
    throw new AppleError(message || res.statusText || `HTTP ${res.status}`, res.status, code)
  }
  return body as T
}

const qs = (params: Record<string, string | number | null | undefined>) => {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') out.set(k, String(v))
  const s = out.toString()
  return s ? `?${s}` : ''
}

export const getAppleStatus = () => call<AppleStatus>('/api/apple/status')
export const listChats = (q = '', limit = 200) =>
  call<{ chats: ChatSummary[] }>(`/api/apple/chats${qs({ q: q.trim(), limit })}`).then((r) => r.chats)
export const getThread = (id: number, opts: { limit?: number; before?: number | null } = {}) =>
  call<ThreadPage>(`/api/apple/chats/${id}${qs({ limit: opts.limit ?? 60, before: opts.before ?? null })}`)
export const searchMessages = (q: string, chat?: number | null) =>
  call<{ results: SearchResult[] }>(`/api/apple/search${qs({ q: q.trim(), chat: chat ?? null })}`).then((r) => r.results)
export const findContacts = (q: string) =>
  call<{ contacts: Contact[] }>(`/api/apple/contacts${qs({ q: q.trim() })}`).then((r) => r.contacts)
export const sendMessage = (body: { chat: number; text: string } | { to: string; text: string }) =>
  call<SendResult>('/api/apple/send', { method: 'POST', body: JSON.stringify(body) })

export const attachmentUrl = (id: number) => `/api/apple/attachments/${id}`

/** Whether the bridge has Apple data switched on (a 404 means a bridge with it off, or too old to know). */
export const appleEnabled = (s: AppleStatus | null) =>
  !!s && s.enabled && s.state !== 'off' && s.state !== 'unsupported'
