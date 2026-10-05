// Chat's bridge calls. Streaming endpoints are read as Server-Sent Events over
// fetch (EventSource cannot send the bearer header).
import { authHeaders, AuthError, api } from '../api'
import type { Attachment, ChatCapabilities, ChatMode, Project, StreamEvent } from './types'

export interface SendArgs {
  threadId: string
  text: string
  attachments?: string[]
  provider?: string | null
  model?: string | null
  effort?: string | null
  kind?: 'regular' | 'temporary'
  /** A new chat started inside a project. */
  projectId?: string
  modelSettings?: any
  mode?: ChatMode
  /** The owner asked for the browser on this message (off unless asked). */
  browser?: boolean
  /** Auto's power dial, 1..5; absent = read from the message. */
  power?: number
  voice?: boolean
  preset?: string
  level?: number
  regenerate?: boolean
  editMessageId?: string
}

export interface StreamHandle {
  /** Stop listening. The run keeps going on the bridge; use stopChat to end it. */
  detach: () => void
  done: Promise<void>
}

async function readSse(r: Response, onEvent: (e: StreamEvent) => void) {
  const reader = r.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const chunks = buf.split('\n\n')
    buf = chunks.pop() || ''
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      try { onEvent(JSON.parse(line.slice(5).trim())) } catch { /* a bad line is not a dead stream */ }
    }
  }
}

function stream(url: string, init: RequestInit, onEvent: (e: StreamEvent) => void, onError: (e: Error) => void): StreamHandle {
  const controller = new AbortController()
  const done = (async () => {
    try {
      const r = await fetch(url, { ...init, signal: controller.signal })
      if (r.status === 401) throw new AuthError()
      if (!r.ok || !r.body) {
        const body = await r.json().catch(() => ({}))
        throw Object.assign(new Error(body?.error || `HTTP ${r.status}`), { status: r.status })
      }
      await readSse(r, onEvent)
    } catch (e: any) {
      if (e?.name !== 'AbortError') onError(e)
    }
  })()
  return { detach: () => controller.abort(), done }
}

export function sendChat(args: SendArgs, onEvent: (e: StreamEvent) => void, onError: (e: Error) => void): StreamHandle {
  return stream('/api/chat', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(args),
  }, onEvent, onError)
}

/** Re-attach to a run already going on the bridge (after a reload, or from another device). */
export function attachRun(threadId: string, since: number, onEvent: (e: StreamEvent) => void, onError: (e: Error) => void): StreamHandle {
  return stream(`/api/chat/runs/${encodeURIComponent(threadId)}/stream?since=${since}`, { headers: authHeaders() }, onEvent, onError)
}

export const stopChat = (threadId: string) =>
  api('/api/chat/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId }) })

export const getRuns = () => api<{ runs: { threadId: string; status: string; mode: string; startedAt: number }[] }>('/api/chat/runs')

export const getCapabilities = () => api<ChatCapabilities>('/api/chat/capabilities')
export const probeCapabilities = () => api<ChatCapabilities>('/api/chat/capabilities/probe', { method: 'POST' })

/** Upload with progress, so a 20 MB PDF on a phone shows it is moving. */
export function uploadFile(file: Blob, name: string, { kind, onProgress }: { kind?: 'text'; onProgress?: (f: number) => void } = {}): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const q = new URLSearchParams({ name, mime: file.type || 'application/octet-stream' })
    if (kind) q.set('kind', kind)
    xhr.open('POST', `/api/chat/uploads?${q}`)
    // The real type travels in `mime`; the body is always opaque bytes, which is one
    // of the few non-JSON types the server's cross-site guard accepts.
    const headers = authHeaders({ 'content-type': 'application/octet-stream' })
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v as string)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total) }
    xhr.onload = () => {
      let body: any = {}
      try { body = JSON.parse(xhr.responseText) } catch {}
      if (xhr.status === 401) return reject(new AuthError())
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body)
      reject(new Error(body?.error || `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Upload failed — check the connection'))
    xhr.send(file)
  })
}

export const deleteUpload = (id: string) => api(`/api/chat/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})

export async function transcribe(audio: Blob): Promise<string> {
  const r = await fetch('/api/chat/transcribe', {
    method: 'POST',
    headers: authHeaders({ 'content-type': audio.type || 'audio/webm' }),
    body: audio,
  })
  if (r.status === 401) throw new AuthError()
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body?.error || `Transcription failed (${r.status})`)
  return (body.text || '').trim()
}

export const uploadUrl = (id: string, att?: { url?: string }) => att?.url || `/api/chat/uploads/${id}`

// --- projects -------------------------------------------------------------------
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

export const listProjects = () => api<{ projects: Project[] }>('/api/chat/projects')
export const getProject = (id: string) => api<{ project: Project }>(`/api/chat/projects/${encodeURIComponent(id)}`)
export const createProjectApi = (body: Partial<Project>) => api<{ project: Project }>('/api/chat/projects', json('POST', body))
export const patchProjectApi = (id: string, body: Record<string, unknown>) => api<{ project: Project }>(`/api/chat/projects/${encodeURIComponent(id)}`, json('PATCH', body))
export const deleteProjectApi = (id: string) => api<{ ok: boolean; movedChats: number }>(`/api/chat/projects/${encodeURIComponent(id)}`, json('DELETE'))
export const putProjectMemory = (id: string, memory: string) => api<{ memory: string }>(`/api/chat/projects/${encodeURIComponent(id)}/memory`, json('PUT', { memory }))
export const addProjectFilesApi = (id: string, uploadIds: string[]) => api<{ project: Project }>(`/api/chat/projects/${encodeURIComponent(id)}/files`, json('POST', { uploadIds }))
export const removeProjectFilesApi = (id: string, ids: string[]) => api<{ removed: number; project: Project }>(`/api/chat/projects/${encodeURIComponent(id)}/files`, json('DELETE', { ids }))
