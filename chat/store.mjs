// chat/store.mjs — chat threads, one JSON file per thread.
//
// The bridge owns a thread's messages. A turn is a server-side run (chat/runs.mjs)
// that appends the user message and the assistant reply itself, so closing the
// tab mid-answer — or sending a long task from the phone and locking it — loses
// nothing: the reply is written whether or not anyone is still watching.
//
// That is why a client PUT of an existing thread only merges *metadata* (title,
// kind, provider, model settings, pin). Before this, the browser was the writer:
// it PUT its whole local copy, the server normalised it down to {role, content},
// and the 30-second sync then replaced the browser's copy with that stripped
// version — tool rows and the chosen provider vanished from every thread.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const validThreadId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)

const MESSAGE_STATUSES = new Set(['streaming', 'done', 'error', 'stopped'])
const TOOL_STATUSES = new Set(['running', 'done', 'error'])
const ATTACHMENT_KINDS = new Set(['image', 'file', 'text'])

export function normalizeAttachment(a) {
  if (!a || typeof a !== 'object' || !validThreadId(a.id)) return null
  const out = {
    id: a.id,
    name: str(a.name, 200) || 'file',
    mime: str(a.mime, 120) || 'application/octet-stream',
    size: num(a.size),
    kind: ATTACHMENT_KINDS.has(a.kind) ? a.kind : 'file',
  }
  // A pasted-text chip shows its first lines without fetching the file.
  if (a.preview) out.preview = str(a.preview, 400)
  return out
}

export function normalizePart(p, i = 0) {
  if (!p || typeof p !== 'object') return null
  if (p.type === 'text') return typeof p.text === 'string' ? { type: 'text', text: p.text } : null
  if (p.type === 'image') return validThreadId(p.uploadId) ? { type: 'image', uploadId: p.uploadId, alt: str(p.alt, 200) } : null
  // A document the agent made this turn (a snapshot in uploads; `path` is where
  // the agent wrote it, for "it's saved at …").
  if (p.type === 'file') {
    if (!validThreadId(p.uploadId)) return null
    return { type: 'file', uploadId: p.uploadId, name: str(p.name, 200) || 'file', mime: str(p.mime, 120) || 'application/octet-stream', size: num(p.size), ...(p.path ? { path: str(p.path, 600) } : {}) }
  }
  if (p.type !== 'tool') return null
  const out = {
    type: 'tool',
    id: str(p.id, 160) || `t${i}`,
    kind: str(p.kind, 80) || 'tool',
    title: str(p.title, 200) || 'Tool call',
    detail: str(p.detail, 600),
    status: TOOL_STATUSES.has(p.status) ? p.status : 'done',
  }
  if (p.server) out.server = str(p.server, 80)
  if (p.tool) out.tool = str(p.tool, 120)
  if (p.input) out.input = str(p.input, 4000)
  if (p.output) out.output = str(p.output, 8000)
  if (num(p.startedAt)) out.startedAt = num(p.startedAt)
  if (num(p.endedAt)) out.endedAt = num(p.endedAt)
  return out
}

// A message saved before ids existed gets one from its position, so it reads the
// same id every time (a random one would change on every list and break edits).
export function normalizeMessage(m, i = 0) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null
  const out = {
    id: validThreadId(m.id) ? m.id : `msg-${i}`,
    role: m.role,
    content: typeof m.content === 'string' ? m.content : '',
    createdAt: num(m.createdAt) || 0,
  }
  if (Array.isArray(m.attachments)) {
    const list = m.attachments.map(normalizeAttachment).filter(Boolean).slice(0, 20)
    if (list.length) out.attachments = list
  }
  if (Array.isArray(m.parts)) {
    const parts = m.parts.map((p, j) => normalizePart(p, j)).filter(Boolean)
    if (parts.length) out.parts = parts
  }
  if (m.role === 'assistant') {
    if (MESSAGE_STATUSES.has(m.status)) out.status = m.status
    if (m.error) out.error = str(m.error, 2000)
    if (m.provider) out.provider = str(m.provider, 80)
    if (m.model) out.model = str(m.model, 120)
    if (num(m.durationMs)) out.durationMs = num(m.durationMs)
    // Which lane Auto/Instant/Thinking chose, so the reply can say so.
    if (m.route === 'instant' || m.route === 'thinking') out.route = m.route
    if (num(m.level)) out.level = Math.min(5, Math.round(num(m.level)))
    if (num(m.power)) out.power = Math.min(5, Math.round(num(m.power)))
  }
  if (m.mode && m.mode !== 'chat') out.mode = str(m.mode, 20)
  if (m.voice) out.voice = true
  return out
}

function normalizeModelSettings(settings) {
  if (!settings || typeof settings !== 'object') return null
  const out = {}
  // preset: auto | instant | thinking | manual; level: the Thinking slider, 1-4.
  for (const key of ['modelId', 'speed', 'effort', 'context', 'preset', 'level', 'power']) {
    if (typeof settings[key] === 'string' && settings[key].length <= 80) out[key] = settings[key]
  }
  return Object.keys(out).length ? out : null
}

// A provider's native session, and how many messages of the thread it has seen.
// `through` is what lets a thread move between providers: when Claude resumes a
// session that stopped at message 4 and Codex answered 5 and 6, those two are
// replayed as text before the new request instead of silently missing.
function normalizeSessions(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const [provider, s] of Object.entries(raw)) {
    if (!/^[a-z0-9_-]{1,60}$/i.test(provider) || !s || typeof s.id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(s.id)) continue
    out[provider] = { id: s.id, through: Math.max(0, Math.floor(Number(s.through) || 0)) }
  }
  return Object.keys(out).length ? out : null
}

const METADATA_KEYS = ['kind', 'title', 'icon', 'provider', 'modelSettings', 'pinned', 'expiresAt', 'projectId']

function applyMetadata(thread, body, now) {
  if (body.kind === 'temporary' || body.kind === 'regular') thread.kind = body.kind
  // The project this chat belongs to (chat/projects.mjs); none = Home.
  if ('projectId' in body) {
    const p = str(body.projectId, 64)
    if (/^[A-Za-z0-9_-]{1,64}$/.test(p)) thread.projectId = p
    else delete thread.projectId
  }
  // A project chat is always kept: temporary chats live outside projects.
  if (thread.projectId) thread.kind = 'regular'
  if ('title' in body) {
    const title = str(body.title, 120).trim()
    if (title) thread.title = title
    else delete thread.title
  }
  // One of chat/thread-icons.mjs's names, chosen by the title model.
  if ('icon' in body) {
    const icon = str(body.icon, 40)
    if (/^[a-z0-9-]{1,40}$/.test(icon)) thread.icon = icon
    else delete thread.icon
  }
  if ('provider' in body) {
    const p = str(body.provider, 80)
    if (p) thread.provider = p
    else delete thread.provider
  }
  if ('modelSettings' in body) {
    const ms = normalizeModelSettings(body.modelSettings)
    if (ms) thread.modelSettings = ms
    else delete thread.modelSettings
  }
  if ('pinned' in body) {
    if (body.pinned) thread.pinned = true
    else delete thread.pinned
  }
  if (thread.kind === 'temporary') thread.expiresAt = num(body.expiresAt) || thread.expiresAt || now
  else delete thread.expiresAt
}

export function createThreadStore({ dir, log = () => {}, onDelete = async () => {} } = {}) {
  if (!dir) throw new TypeError('createThreadStore requires dir')
  const file = (id) => join(dir, `${id}.json`)
  const isExpired = (t) => t?.kind === 'temporary' && num(t.expiresAt) > 0 && num(t.expiresAt) <= Date.now()

  // Per-thread write lock. A run persisting its partial reply and a client PATCH
  // renaming the thread both read-modify-write the same file.
  const locks = new Map()
  function withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve()
    const next = prev.then(fn, fn)
    const settled = next.catch(() => {})
    locks.set(id, settled)
    settled.then(() => { if (locks.get(id) === settled) locks.delete(id) })
    return next
  }

  async function rawRead(id) {
    if (!validThreadId(id)) return null
    try { return JSON.parse(await readFile(file(id), 'utf8')) } catch { return null }
  }

  async function rawWrite(thread) {
    await mkdir(dir, { recursive: true })
    const tmp = file(`${thread.id}.${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify(thread))
    await rename(tmp, file(thread.id))
    return thread
  }

  function normalizeThread(raw, id) {
    const now = Date.now()
    const thread = {
      id,
      kind: raw?.kind === 'temporary' ? 'temporary' : 'regular',
      messages: Array.isArray(raw?.messages) ? raw.messages.map((m, i) => normalizeMessage(m, i)).filter(Boolean) : [],
      createdAt: num(raw?.createdAt) || now,
      updatedAt: num(raw?.updatedAt) || now,
    }
    applyMetadata(thread, raw || {}, now)
    const sessions = normalizeSessions(raw?.sessions)
    if (sessions) thread.sessions = sessions
    return thread
  }

  async function remove(id) {
    if (!validThreadId(id)) return
    const existing = await rawRead(id)
    try { await unlink(file(id)) } catch {}
    if (existing) await onDelete(existing).catch((e) => log('chat: thread cleanup failed', e?.message || e))
  }

  async function list() {
    let names = []
    try { names = await readdir(dir) } catch { return [] }
    const out = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const t = await rawRead(name.slice(0, -5))
      if (!t || !validThreadId(t.id)) continue
      if (isExpired(t)) { await remove(t.id); continue }
      out.push(normalizeThread(t, t.id))
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  async function get(id) {
    const t = await rawRead(id)
    if (!t) return null
    if (isExpired(t)) { await remove(id); return null }
    return normalizeThread(t, id)
  }

  /**
   * Client upsert. A thread the server has never seen is taken whole (the
   * one-time localStorage migration, a fresh empty chat); an existing one only has
   * its metadata merged, so a stale browser copy can never overwrite a reply the
   * server wrote after that copy was taken.
   */
  function put(id, body = {}) {
    if (!validThreadId(id)) throw new Error('bad thread id')
    return withLock(id, async () => {
      const existing = await rawRead(id)
      if (!existing) return rawWrite(normalizeThread({ ...body, sessions: null }, id))
      const thread = normalizeThread(existing, id)
      applyMetadata(thread, Object.fromEntries(METADATA_KEYS.filter((k) => k in body).map((k) => [k, body[k]])), Date.now())
      thread.updatedAt = Math.max(thread.updatedAt, num(body.updatedAt) || 0) || Date.now()
      return rawWrite(thread)
    })
  }

  /** Server-side mutation: `fn(thread)` edits a normalised copy in place. */
  function update(id, fn, { create } = {}) {
    if (!validThreadId(id)) throw new Error('bad thread id')
    return withLock(id, async () => {
      const existing = await rawRead(id)
      if (!existing && !create) throw Object.assign(new Error('thread not found'), { status: 404 })
      const thread = normalizeThread(existing || create, id)
      const out = await fn(thread)
      thread.messages = thread.messages.map((m, i) => normalizeMessage(m, i)).filter(Boolean)
      const sessions = normalizeSessions(thread.sessions)
      if (sessions) thread.sessions = sessions
      else delete thread.sessions
      await rawWrite(thread)
      return out === undefined ? thread : out
    })
  }

  return { list, get, put, update, remove, file }
}
