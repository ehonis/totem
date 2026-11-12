// chat/uploads.mjs — files attached to chat messages.
//
// Every agent CLI is handed attachments as files on this disk: Codex and Claude
// also get images natively (`-i`, a base64 image block), but all of them get the
// absolute path, because "the file is at /…/receipt.pdf" is the one interface
// cursor, codex, claude and opencode all understand, and it lets the agent open a
// PDF or a spreadsheet with its own tools rather than us guessing how to inline it.
//
// Layout: <dir>/<id>/meta.json + <dir>/<id>/<safe name>. The name keeps its
// extension because codex decides an image's type from it.
//
// Image <img> tags cannot send an Authorization header, so reads are authorised by
// an HMAC of the upload id (`?sig=`), minted with the bridge secret. A signature
// names one file and nothing else; it is not a session.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { VISUAL_CSP } from './visuals.mjs'

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/i
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|javascript|x-sh|toml))/i
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log|ini|toml|js|ts|tsx|jsx|py|sh|sql|css|rtf)$/i
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json',
}

/**
 * How GET /api/chat/uploads/<id> answers: inline or as a download, and under
 * which policy. Everything inline except a PDF is sandboxed, so a file that can
 * carry script (an SVG, a chart page) never runs with Totem's origin when it is
 * opened on its own; an <img> tag is unaffected. A chart the agent rendered
 * (chat/visuals.mjs, saved with `visual`) is the one HTML served as a page, and
 * always under VISUAL_CSP. Other HTML stays a download.
 */
export function servedHeaders(meta, { download = false } = {}) {
  const visual = meta.visual === true && meta.mime === 'text/html'
  const pdf = meta.mime === 'application/pdf'
  const inline = !download && (visual || pdf || /^(image\/|text\/plain)/.test(meta.mime))
  return {
    'content-type': visual ? 'text/html; charset=utf-8' : meta.mime,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(meta.name).replace(/"/g, '')}"`,
    'x-content-type-options': 'nosniff',
    ...(visual ? { 'content-security-policy': VISUAL_CSP, 'referrer-policy': 'no-referrer' } : inline && !pdf ? { 'content-security-policy': 'sandbox' } : {}),
  }
}

export const validUploadId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)

export function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').trim()
  return (base || 'file').slice(0, 120)
}

export function attachmentKind(mime, name) {
  if (IMAGE_MIME.test(mime)) return 'image'
  if (TEXT_MIME.test(mime) || TEXT_EXT.test(name)) return 'text'
  return 'file'
}

export function createUploadStore({ dir, secret, maxBytes = 25 * 1024 * 1024, log = () => {} } = {}) {
  if (!dir) throw new TypeError('createUploadStore requires dir')
  const sign = (id) => createHmac('sha256', String(secret || 'totem')).update(`chat-upload:${id}`).digest('base64url').slice(0, 32)

  function verify(id, sig) {
    if (!validUploadId(id) || typeof sig !== 'string') return false
    const a = Buffer.from(sign(id)), b = Buffer.from(sig)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const urlFor = (id) => `/api/chat/uploads/${id}?sig=${sign(id)}`

  function publicMeta(meta) {
    const out = { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, kind: meta.kind, url: urlFor(meta.id) }
    if (meta.preview) out.preview = meta.preview
    return out
  }

  async function save({ buffer, name, mime, kind: forcedKind, visual = false }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error('empty upload'), { status: 400 })
    if (buffer.length > maxBytes) throw Object.assign(new Error(`file is larger than ${Math.round(maxBytes / 1e6)} MB`), { status: 413 })
    const id = randomUUID().replace(/-/g, '')
    let fileName = safeFileName(name)
    const ext = extname(fileName).toLowerCase()
    let type = String(mime || '').split(';')[0].trim().toLowerCase()
    if (!type || type === 'application/octet-stream') type = MIME_BY_EXT[ext] || 'application/octet-stream'
    // A pasted image arrives as "image.png" or with no name at all; give it the
    // extension its type implies so codex can read it.
    if (!ext) {
      const implied = Object.entries(MIME_BY_EXT).find(([, m]) => m === type)?.[0]
      if (implied) fileName += implied
    }
    const kind = forcedKind === 'text' ? 'text' : attachmentKind(type, fileName)
    const meta = { id, name: fileName, file: fileName, mime: type, size: buffer.length, kind, createdAt: Date.now() }
    // A chart the agent rendered inline (chat/visuals.mjs): the only HTML the
    // uploads route serves as a page, and only under its sandboxing policy.
    if (visual && type === 'text/html') meta.visual = true
    if (kind === 'text') meta.preview = buffer.toString('utf8', 0, 2000).replace(/\s+/g, ' ').trim().slice(0, 240)
    const folder = join(dir, id)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, fileName), buffer)
    await writeFile(join(folder, 'meta.json'), JSON.stringify(meta))
    return publicMeta(meta)
  }

  async function meta(id) {
    if (!validUploadId(id)) return null
    try {
      const m = JSON.parse(await readFile(join(dir, id, 'meta.json'), 'utf8'))
      return { ...m, path: join(dir, id, m.file) }
    } catch { return null }
  }

  async function read(id) {
    const m = await meta(id)
    if (!m) return null
    return { meta: m, buffer: await readFile(m.path) }
  }

  async function remove(id) {
    if (!validUploadId(id)) return
    await rm(join(dir, id), { recursive: true, force: true }).catch(() => {})
  }

  // Files nobody sent: attached in the composer, then the draft was abandoned.
  async function sweepOrphans({ referenced, olderThanMs = 24 * 60 * 60_000 } = {}) {
    let ids = []
    try { ids = await readdir(dir) } catch { return 0 }
    let removed = 0
    for (const id of ids) {
      if (!validUploadId(id) || referenced.has(id)) continue
      try {
        const s = await stat(join(dir, id))
        if (Date.now() - s.mtimeMs < olderThanMs) continue
        await remove(id)
        removed++
      } catch {}
    }
    if (removed) log(`chat: swept ${removed} unsent attachment${removed === 1 ? '' : 's'}`)
    return removed
  }

  return { save, meta, read, remove, verify, sign, urlFor, publicMeta, sweepOrphans, maxBytes }
}
