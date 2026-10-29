// chat/files.mjs — the Files panel's view of the disk, T3 Code's files viewer for Totem.
//
// A chat's agent saves what it makes under data/chat-outputs/<thread>/ and names
// those files by absolute path in its reply. The dashboard is usually opened from
// somewhere else (a phone, another laptop), so a path on the box means nothing
// there until the bridge lists and serves it. This module decides which paths it
// may: anything under one of `roots` (real paths, so a symlink cannot lead out),
// never under a `deny` path (Totem's data and secrets) unless a root sits inside
// that denied path and the file is under the root: data/ is denied, its
// chat-outputs/ is a root.
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'

export const FILE_MIME = {
  md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', csv: 'text/csv',
  tsv: 'text/tab-separated-values', txt: 'text/plain', log: 'text/plain', json: 'application/json', yml: 'text/yaml',
  yaml: 'text/yaml', svg: 'image/svg+xml', pdf: 'application/pdf', xml: 'application/xml', ics: 'text/calendar',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime',
}

export const mimeFor = (path) => FILE_MIME[extname(path).slice(1).toLowerCase()] || 'application/octet-stream'

// Served inline only when the browser shows it as a document rather than running
// it: HTML and SVG from the bridge's own origin could script the dashboard, so
// they always download (the panel previews them in a sandboxed frame instead).
const INLINE = /^(image\/(png|jpeg|gif|webp)|text\/plain|application\/pdf|audio\/|video\/)/

const fail = (status, message) => Object.assign(new Error(message), { status })
const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

export function createFileAccess({ roots = [], deny = [], maxEntries = 1000 } = {}) {
  let realRoots = null
  async function resolvedRoots() {
    if (realRoots) return realRoots
    const out = []
    for (const r of roots.filter(Boolean)) out.push(await realpath(r).catch(() => r))
    realRoots = out
    return out
  }

  /** The real path behind `path`, or an error with a status: 400, 403 or 404. */
  async function resolve(path) {
    let p = String(path || '')
    if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7))
    if (!isAbsolute(p) || p.includes('\0')) throw fail(400, 'an absolute path is required')
    const real = await realpath(p).catch(() => null)
    if (!real) throw fail(404, 'not found')
    const rs = await resolvedRoots()
    if (!rs.some((root) => inside(real, root)) || isDenied(real, rs)) throw fail(403, 'outside the folders Totem shares')
    return real
  }

  const isDenied = (path, rs) => deny.some((d) => inside(path, d) && !rs.some((r) => inside(r, d) && inside(path, r)))

  /** Every file and folder under `dir`, depth first, capped at maxEntries. */
  async function list(dir) {
    const root = await resolve(dir)
    const st = await stat(root)
    if (!st.isDirectory()) throw fail(400, 'not a folder')
    const entries = []
    let truncated = false
    async function walk(abs) {
      let names
      try { names = await readdir(abs, { withFileTypes: true }) } catch { return }
      names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
      for (const d of names) {
        if (d.name === '.git' || d.name === 'node_modules' || d.name === '.DS_Store') continue
        if (entries.length >= maxEntries) { truncated = true; return }
        const path = join(abs, d.name)
        if (isDenied(path, await resolvedRoots())) continue
        if (d.isDirectory()) {
          entries.push({ path, rel: relative(root, path), name: d.name, dir: true })
          await walk(path)
        } else if (d.isFile()) {
          const s = await stat(path).catch(() => null)
          if (s) entries.push({ path, rel: relative(root, path), name: d.name, dir: false, size: s.size, mtime: s.mtimeMs, mime: mimeFor(path) })
        }
      }
    }
    await walk(root)
    return { root, entries, truncated }
  }

  /** Stream one file to an HTTP response. */
  async function serve(res, path, { download = false } = {}) {
    const real = await resolve(path)
    const st = await stat(real)
    if (!st.isFile()) throw fail(400, 'not a file')
    const mime = mimeFor(real)
    const name = basename(real)
    const inline = !download && INLINE.test(mime)
    res.writeHead(200, {
      'content-type': mime,
      'content-length': st.size,
      'cache-control': 'private, no-cache',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
    })
    await new Promise((done, failed) => {
      const s = createReadStream(real)
      s.on('error', failed)
      s.on('end', done)
      s.pipe(res)
    })
  }

  return { resolve, list, serve, roots: resolvedRoots }
}

/**
 * A chat's agent links its files by absolute path (`/Users/…/chat-outputs/<thread>/x.xlsx`),
 * which the browser resolves against the dashboard's origin. A request for such a
 * path is sent to the chat with the file open, decided from the path's shape alone,
 * so asking reveals nothing about which files exist.
 */
export function chatFileRedirect(urlPath, outputsDir) {
  let p
  try { p = decodeURIComponent(urlPath) } catch { return null }
  const base = outputsDir.endsWith(sep) ? outputsDir : outputsDir + sep
  if (!p.startsWith(base)) return null
  const thread = p.slice(base.length).split(sep)[0]
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(thread)) return null
  return `/chat?thread=${encodeURIComponent(thread)}&file=${encodeURIComponent(p)}`
}
