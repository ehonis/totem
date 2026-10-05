// chat/projects.mjs — chat projects: a shared home for related chats.
//
// A project is what Claude and ChatGPT call one: chats that share a default
// account and model, standing instructions, a set of files, and a memory. Every
// chat in a project is told about all of it, so nothing has to be uploaded or
// explained twice. What the chats share is deliberate and small:
//
//   instructions — written by the owner, sent with every turn.
//   memory       — a Markdown file the agent keeps up to date (decisions, facts,
//                  preferences learned in the project). The owner can edit it too.
//   files        — uploads (chat/uploads.mjs ids). Anything attached in a project
//                  chat and every document the agent makes in one is added here.
//
// Chats do not read each other's transcripts; the memory is how one chat's
// conclusions reach the next.
//
// Layout: <dir>/<id>/project.json + <dir>/<id>/memory.md. The memory is a file,
// not a field, because the agent edits it with its own file tools.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const validProjectId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
const validUploadId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)

export const MEMORY_MAX = 40_000
const FILE_SOURCES = new Set(['upload', 'chat', 'agent'])
const FILE_KINDS = new Set(['image', 'file', 'text'])

function normalizeModelSettings(settings) {
  if (!settings || typeof settings !== 'object') return null
  const out = {}
  for (const key of ['modelId', 'speed', 'effort', 'context', 'preset', 'level', 'power']) {
    if (typeof settings[key] === 'string' && settings[key].length <= 80) out[key] = settings[key]
  }
  return Object.keys(out).length ? out : null
}

export function normalizeProjectFile(f) {
  if (!f || typeof f !== 'object' || !validUploadId(f.id)) return null
  const out = {
    id: f.id,
    name: str(f.name, 200) || 'file',
    mime: str(f.mime, 120) || 'application/octet-stream',
    size: num(f.size),
    kind: FILE_KINDS.has(f.kind) ? f.kind : 'file',
    source: FILE_SOURCES.has(f.source) ? f.source : 'upload',
    addedAt: num(f.addedAt) || Date.now(),
  }
  // The chat it came from, so the Files tab can say "from Plan the launch".
  if (typeof f.threadId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(f.threadId)) out.threadId = f.threadId
  return out
}

function normalizeProject(raw, id) {
  const now = Date.now()
  const out = {
    id,
    name: str(raw?.name, 80).trim() || 'Untitled project',
    instructions: str(raw?.instructions, 8000),
    files: Array.isArray(raw?.files) ? raw.files.map(normalizeProjectFile).filter(Boolean).slice(0, 500) : [],
    createdAt: num(raw?.createdAt) || now,
    updatedAt: num(raw?.updatedAt) || now,
  }
  // One of chat/thread-icons.mjs's names.
  if (typeof raw?.icon === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.icon)) out.icon = raw.icon
  if (typeof raw?.provider === 'string' && /^[a-z0-9_-]{1,80}$/i.test(raw.provider)) out.provider = raw.provider
  const ms = normalizeModelSettings(raw?.modelSettings)
  if (ms) out.modelSettings = ms
  return out
}

const EDITABLE = ['name', 'instructions', 'icon', 'provider', 'modelSettings']

export function createProjectStore({ dir } = {}) {
  if (!dir) throw new TypeError('createProjectStore requires dir')
  const folder = (id) => join(dir, id)
  const memoryPath = (id) => join(folder(id), 'memory.md')

  // One writer per project: a turn adding its documents and the owner removing
  // a file both read-modify-write project.json.
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
    if (!validProjectId(id)) return null
    try { return JSON.parse(await readFile(join(folder(id), 'project.json'), 'utf8')) } catch { return null }
  }

  async function rawWrite(project) {
    await mkdir(folder(project.id), { recursive: true })
    const tmp = join(folder(project.id), `project.${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify(project, null, 2))
    await rename(tmp, join(folder(project.id), 'project.json'))
    return project
  }

  async function get(id) {
    const raw = await rawRead(id)
    return raw ? normalizeProject(raw, id) : null
  }

  async function list() {
    let names = []
    try { names = await readdir(dir) } catch { return [] }
    const out = []
    for (const name of names) {
      const p = await get(name)
      if (p) out.push(p)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async function create(body = {}) {
    const id = randomUUID().replace(/-/g, '').slice(0, 20)
    const now = Date.now()
    const project = normalizeProject({ ...Object.fromEntries(EDITABLE.map((k) => [k, body[k]])), createdAt: now, updatedAt: now }, id)
    await rawWrite(project)
    await writeFile(memoryPath(id), '')
    return project
  }

  function update(id, fn) {
    if (!validProjectId(id)) throw Object.assign(new Error('bad project id'), { status: 400 })
    return withLock(id, async () => {
      const raw = await rawRead(id)
      if (!raw) throw Object.assign(new Error('project not found'), { status: 404 })
      const project = normalizeProject(raw, id)
      const out = await fn(project)
      project.updatedAt = Date.now()
      await rawWrite(normalizeProject(project, id))
      return out === undefined ? normalizeProject(project, id) : out
    })
  }

  /** Owner edits. `null`/'' clears provider, model settings and icon. */
  const patch = (id, body = {}) => update(id, (p) => {
    for (const key of EDITABLE) {
      if (!(key in body)) continue
      if (body[key] === null || body[key] === '') delete p[key]
      else p[key] = body[key]
    }
  })

  /** Add files (deduplicated by upload id). Returns the ones that were new. */
  const addFiles = (id, files) => update(id, (p) => {
    const have = new Set(p.files.map((f) => f.id))
    const added = []
    for (const f of files || []) {
      const file = normalizeProjectFile({ addedAt: Date.now(), ...f })
      if (!file || have.has(file.id)) continue
      have.add(file.id)
      p.files.push(file)
      added.push(file)
    }
    return added
  })

  /** Remove files from the project. Returns the removed entries. */
  const removeFiles = (id, ids) => update(id, (p) => {
    const drop = new Set(ids)
    const removed = p.files.filter((f) => drop.has(f.id))
    p.files = p.files.filter((f) => !drop.has(f.id))
    return removed
  })

  async function readMemory(id) {
    if (!validProjectId(id)) return ''
    try { return (await readFile(memoryPath(id), 'utf8')).slice(0, MEMORY_MAX) } catch { return '' }
  }

  async function writeMemory(id, text) {
    if (!(await rawRead(id))) throw Object.assign(new Error('project not found'), { status: 404 })
    await writeFile(memoryPath(id), String(text || '').slice(0, MEMORY_MAX))
  }

  async function remove(id) {
    const project = await get(id)
    if (!project) return null
    await rm(folder(id), { recursive: true, force: true })
    return project
  }

  /** Every upload id any project holds, so thread cleanup and the orphan sweep leave them be. */
  async function fileIds() {
    const ids = new Set()
    for (const p of await list()) for (const f of p.files) ids.add(f.id)
    return ids
  }

  return { list, get, create, patch, update, addFiles, removeFiles, readMemory, writeMemory, memoryPath, remove, fileIds }
}
