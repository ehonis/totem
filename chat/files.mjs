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
//
// A file is opened through a signed link (`link()`): the file's real path, an
// expiry and an HMAC of both, minted for a caller already signed in. An <iframe>,
// an <img>, a fetch() without the bearer and the desktop app's native download
// all carry it, so a browser unlocked with BRIDGE_SECRET (no session cookie)
// opens a file the same way a signed-in one does, the way chat uploads' `?sig=`
// works. The signature grants that one path until it expires and nothing more:
// the roots and the deny list are checked again on every read. The key is random
// per process, never derived from BRIDGE_SECRET (which may be empty), so a
// restart retires every link; a deploy reloads open dashboards anyway.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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

/** How long a signed file link opens its file: long enough for a tab left open over a working day. */
export const FILE_LINK_TTL_MS = 12 * 60 * 60 * 1000
const RAW = '/api/chat/files/raw'

const fail = (status, message) => Object.assign(new Error(message), { status })
const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

export function createFileAccess({ roots = [], deny = [], maxEntries = 1000, key = randomBytes(32), ttlMs = FILE_LINK_TTL_MS, now = Date.now } = {}) {
  const sign = (path, exp) => createHmac('sha256', key).update(`chat-file:${exp}:${path}`).digest('base64url')

  /** The signed URL that opens `real` (a real path `resolve` returned) until it expires. */
  function signedUrl(real) {
    const exp = now() + ttlMs
    return `${RAW}?path=${encodeURIComponent(real)}&exp=${exp}&sig=${sign(real, exp)}`
  }

  /** Whether `sig` was minted by `signedUrl` for exactly `path` and has not expired. */
  function verify(path, exp, sig) {
    if (typeof path !== 'string' || typeof sig !== 'string' || !/^\d{1,15}$/.test(String(exp ?? ''))) return false
    const at = Number(exp)
    if (at <= now() || at > now() + ttlMs) return false
    const a = Buffer.from(sign(path, at)), b = Buffer.from(sig)
    return a.length === b.length && timingSafeEqual(a, b)
  }

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

  /** One file, checked and signed: what the dashboard opens it by. */
  async function link(path) {
    const real = await resolve(path)
    const st = await stat(real)
    if (!st.isFile()) throw fail(400, 'not a file')
    return { path: real, name: basename(real), mime: mimeFor(real), size: st.size, url: signedUrl(real) }
  }

  /**
   * Stream one file to an HTTP response. `signed` is a request that came in on a
   * signature rather than a sign-in: its path must still be its own real path, so
   * a folder swapped for a symlink after signing does not lead somewhere else.
   */
  async function serve(res, path, { download = false, head = false, signed = false } = {}) {
    const real = await resolve(path)
    if (signed && real !== path) throw fail(403, 'this link no longer points at its file')
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
      // Shown on its own (a link opened in a tab), a file never runs as Totem; a PDF
      // keeps the browser's viewer, which a sandbox would block (chat/uploads.mjs does the same).
      ...(inline && mime !== 'application/pdf' ? { 'content-security-policy': 'sandbox' } : {}),
    })
    if (head) return res.end()
    await new Promise((done, failed) => {
      const s = createReadStream(real)
      const closed = () => { s.destroy(); done() }
      res.once('close', closed)
      s.once('close', () => res.off('close', closed))
      s.on('error', failed)
      s.on('end', done)
      s.pipe(res)
    })
  }

  return { resolve, list, link, serve, verify, roots: resolvedRoots }
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
