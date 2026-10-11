// totems/drafts.mjs — totems the owner started building but has not created.
//
// One JSON file per draft under data/totem-drafts/. A draft holds what the
// builder page shows: his description, the designed totem as he last left it
// (his own edits included), the model he picked and the conversation with the
// builder. The bridge writes the builder's answer here itself, so leaving the
// page while it thinks loses nothing; `pending` marks a turn still running.
// Creating the totem deletes its draft.

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DRAFT_ID = /^[A-Za-z0-9_-]{8,64}$/
const MAX_MESSAGES = 60
const MAX_DRAFT_BYTES = 64_000
// A builder turn that has not finished in this long died with the process.
export const PENDING_STALE_MS = 6 * 60_000

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

function cleanMessage(m) {
  if (!m || typeof m !== 'object') return null
  const role = m.role === 'owner' ? 'owner' : m.role === 'builder' ? 'builder' : null
  const text = str(m.text, 4000).trim()
  if (!role || !text) return null
  const out = { role, text, at: Number(m.at) || Date.now() }
  const questions = Array.isArray(m.questions) ? m.questions.map((q) => str(q, 300)).filter(Boolean).slice(0, 3) : []
  if (role === 'builder' && questions.length) out.questions = questions
  if (role === 'builder' && m.error === true) out.error = true
  return out
}

function cleanChoice(c) {
  if (!c || typeof c !== 'object' || typeof c.provider !== 'string') return null
  return { provider: str(c.provider, 64), model: str(c.model, 120), effort: ['low', 'medium', 'high'].includes(c.effort) ? c.effort : '' }
}

/** Keep only what a draft is made of, bounded. Fields not in `patch` keep their old values. */
export function mergeDraft(prev, patch = {}, now = Date.now()) {
  const out = { ...(prev || {}) }
  if ('description' in patch) out.description = str(patch.description, 4000)
  if ('draft' in patch) {
    const d = patch.draft && typeof patch.draft === 'object' ? patch.draft : null
    out.draft = d && JSON.stringify(d).length <= MAX_DRAFT_BYTES ? d : (prev?.draft ?? null)
  }
  if ('choice' in patch) out.choice = cleanChoice(patch.choice)
  if ('messages' in patch) out.messages = (Array.isArray(patch.messages) ? patch.messages : []).map(cleanMessage).filter(Boolean).slice(-MAX_MESSAGES)
  if ('pending' in patch) out.pending = patch.pending ? { text: str(patch.pending.text, 4000), startedAt: Number(patch.pending.startedAt) || now } : null
  out.createdAt = prev?.createdAt || now
  out.updatedAt = now
  return out
}

/** Whether a draft is still waiting on a builder turn that can finish. */
export const isPending = (rec, now = Date.now()) => !!(rec?.pending && now - rec.pending.startedAt < PENDING_STALE_MS)

export function createDraftStore(dir) {
  const file = (id) => join(dir, `${id}.json`)
  // Writes to one draft are queued, so an autosave and the builder's answer
  // landing together can't interleave a read-modify-write.
  const queues = new Map()
  const queued = (id, fn) => {
    const next = (queues.get(id) || Promise.resolve()).then(fn, fn)
    queues.set(id, next.catch(() => {}))
    return next
  }

  async function get(id) {
    if (!DRAFT_ID.test(String(id))) return null
    try {
      const rec = JSON.parse(await readFile(file(id), 'utf8'))
      return { ...rec, id, pending: isPending(rec) ? rec.pending : null }
    } catch { return null }
  }

  return {
    get,
    async list() {
      let names = []
      try { names = await readdir(dir) } catch { return [] }
      const recs = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => get(n.slice(0, -5))))
      return recs.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)
    },
    /**
     * Merge `patch` into the draft and return the stored record. With
     * `create: false` a draft that is gone (discarded, or made into a totem)
     * stays gone and this returns null.
     */
    save(id, patch, { create = true } = {}) {
      if (!DRAFT_ID.test(String(id))) return Promise.reject(new Error('bad draft id'))
      return queued(id, async () => {
        const prev = await get(id)
        if (!prev && !create) return null
        const rec = mergeDraft(prev, patch)
        delete rec.id
        await mkdir(dir, { recursive: true })
        const tmp = `${file(id)}.${process.pid}.tmp`
        await writeFile(tmp, JSON.stringify(rec), { mode: 0o600 })
        await rename(tmp, file(id))
        return { ...rec, id }
      })
    },
    remove(id) {
      if (!DRAFT_ID.test(String(id))) return Promise.resolve()
      return queued(id, () => rm(file(id), { force: true }))
    },
  }
}
