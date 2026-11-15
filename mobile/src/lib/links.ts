/**
 * Where a tapped link in a reply goes: the one decision for every link the app
 * draws, the phone's twin of web/src/links.ts `classifyLink`.
 *
 *   file      a file on the box (an absolute path, `file://`, the raw-file URL, the
 *             web's `/chat?file=` redirect) → signed by the bridge, then the file
 *             sheet or the viewer, as the web's Files panel opens it.
 *   resource  what the API serves (`/api/…`: uploads, attachments) → the sheet or viewer.
 *   app       any other path on the bridge: a dashboard page → the app's own screen.
 *   external  another site → the in-app browser (or a sibling app), never with a token.
 *   system    mailto:, tel:, sms: → the phone's own app for it.
 *
 * Kept free of React Native imports: its tests run under the bridge's `npm test`.
 */

export type LinkRoute =
  | { kind: 'file'; path: string }
  | { kind: 'resource'; path: string }
  | { kind: 'app'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'system'; url: string }

/** Where a file on the box sits: the folders an agent's absolute paths start with (web/src/links.ts). */
export const FS_PATH = /^\/(Users|home|root|tmp|private|var|opt|mnt|Volumes|srv)\//

const SYSTEM = /^(mailto|tel|sms):/i

/** decodeURIComponent that returns its input when the input isn't valid percent-encoding. */
export const safeDecode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
const decode = safeDecode

/**
 * scheme://host[:port], lowercased, default ports dropped; null for anything but a
 * plain http(s) URL. The one origin rule for every credential decision in the app
 * (links.ts, notifications/destination.ts): an authority holding `\`, `@`, `%`,
 * whitespace or a control character is refused outright, and the host must be
 * letters, digits, dots and dashes or a bracketed IPv6 address. iOS's RFC 3986
 * parser and WHATWG URL (fetch, WebKit) read such authorities differently
 * (`https://evil\@bridge` is evil to one and the bridge to the other), so none of
 * them may ever count as the bridge.
 */
export function originOf(url: string): string | null {
  const m = /^(https?):\/\/([^/?#]*)/i.exec(String(url ?? ''))
  if (!m) return null
  const scheme = m[1].toLowerCase()
  const authority = m[2].toLowerCase()
  if (/[\\@%\s\x00-\x1f\x7f]/.test(authority)) return null
  if (!/^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/.test(authority)) return null
  if (/^[.-]|^\[?$/.test(authority)) return null
  return `${scheme}://${authority.replace(scheme === 'https' ? /:443$/ : /:80$/, '')}`
}

/**
 * What `href` (as the reply wrote it) points at. `bridgeOrigins` are the addresses
 * the bridge answers on: the connection's base URL first (relative paths resolve
 * against it), then PUBLIC_URL if known. Null: nothing the app can open (an
 * in-page anchor, `javascript:`, a relative name like `report.md`).
 */
export function classifyLink(href: string, bridgeOrigins: (string | null | undefined)[]): LinkRoute | null {
  const raw = String(href || '').trim()
  if (!raw || raw.startsWith('#')) return null
  if (SYSTEM.test(raw)) return { kind: 'system', url: raw }
  if (/^file:\/\//i.test(raw)) {
    const path = decode(raw.replace(/^file:\/\/(localhost)?/i, '').split(/[?#]/)[0])
    return FS_PATH.test(path) ? { kind: 'file', path } : null
  }
  if (FS_PATH.test(raw)) return { kind: 'file', path: decode(raw) }

  let rest: string
  // `//host` and `/\host` are other sites, as WHATWG URL resolves them.
  const protocolRelative = /^[/\\]{2}/.test(raw)
  if (/^https?:\/\//i.test(raw) || protocolRelative) {
    const abs = protocolRelative ? `https://${raw.replace(/^[/\\]+/, '')}` : raw
    const origin = originOf(abs)
    if (!origin) return null
    if (!bridgeOrigins.some((b) => b && originOf(b) === origin)) return { kind: 'external', url: abs }
    rest = abs.replace(/^https?:\/\/[^/?#]*/i, '') || '/'
  } else if (raw.startsWith('/')) {
    rest = raw
  } else {
    return null
  }
  // One leading slash: `https://bridge//evil.com/x` must not become a protocol-relative `//evil.com`.
  rest = `/${rest.replace(/^[/\\]+/, '')}`

  const pathEnd = rest.search(/[?#]/)
  const pathname = decode(pathEnd >= 0 ? rest.slice(0, pathEnd) : rest)
  const query = new URLSearchParams((/\?([^#]*)/.exec(rest) || [])[1] || '')
  if (FS_PATH.test(pathname)) return { kind: 'file', path: pathname }
  // The raw-file route names its file; the app signs it again rather than trusting a link's signature.
  if (pathname === '/api/chat/files/raw' && query.get('path')) return { kind: 'file', path: query.get('path')! }
  // The web turns an opened file path into the chat with `?file=`.
  if (pathname === '/chat' && query.get('file') && FS_PATH.test(query.get('file')!)) return { kind: 'file', path: query.get('file')! }
  if (pathname.startsWith('/api/')) return { kind: 'resource', path: rest.split('#')[0] }
  return { kind: 'app', path: rest }
}

/** Whether a URL is on the bridge's own origin: exactly its scheme, host and port. */
export function isBridgeUrl(url: string, baseUrl: string): boolean {
  const base = originOf(baseUrl)
  return Boolean(base && originOf(url) === base)
}

/**
 * The headers a request to `url` may carry: the bearer and the Access token go to
 * the bridge's own origin and nowhere else. Anything else gets none.
 */
export function headersFor(url: string, baseUrl: string, headers: Record<string, string>): Record<string, string> {
  return isBridgeUrl(url, baseUrl) ? headers : {}
}

/** The last segment of a path or URL, decoded: a file's name when nothing better is known. */
export function fileNameOf(pathOrUrl: string): string {
  const path = String(pathOrUrl || '').replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/)[0]
  return decode(path.split('/').filter(Boolean).pop() || '') || 'file'
}

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', csv: 'text/csv', tsv: 'text/tab-separated-values',
  txt: 'text/plain', log: 'text/plain', json: 'application/json', yml: 'text/yaml', yaml: 'text/yaml', xml: 'application/xml',
  ics: 'text/calendar', svg: 'image/svg+xml', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', zip: 'application/zip',
}

/** A file's type from its name (web/src/chat/store.ts mimeOf). */
export function mimeOf(name: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1]?.toLowerCase() || ''
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

export type FileView = 'text' | 'image' | 'pdf' | 'html' | 'save'

/**
 * How the app shows a file: text-like files read in the file sheet, pictures in
 * the viewer, a PDF in the viewer's web view (ui/BridgeWebView.tsx), the rest (a
 * zip, an Office file, for now an HTML page) as a download for the share sheet.
 */
export function fileView(name: string, mime: string): FileView {
  const type = (mime || '').toLowerCase()
  if (/html|svg/.test(type) || /\.(x?html?|svgz?)(\.|$)/i.test(name)) return 'html'
  if (/^image\//.test(type) || /\.(png|jpe?g|gif|webp|heic)$/i.test(name)) return 'image'
  if (/pdf/.test(type) || /\.pdf$/i.test(name)) return 'pdf'
  if (/^text\//.test(type) || /^application\/(json|xml)/.test(type) || /\.(md|markdown|csv|tsv|txt|json|log|ya?ml)$/i.test(name)) return 'text'
  return 'save'
}

/**
 * The address the viewer's web view may load for a file, or null. Only a PDF on
 * the bridge's own origin: the bridge serves it inline, and the web view sends
 * the Access token with its first request. Never an HTML or SVG file: the bridge
 * serves those as downloads without a sandbox, and WebKit would run one as a page
 * on the bridge's origin (the web shows them in a sandboxed srcDoc frame instead).
 */
export function webViewSource(view: FileView, url: string, baseUrl: string, servedType: string): string | null {
  const served = String(servedType || '').split(';')[0].trim().toLowerCase()
  return view === 'pdf' && served === 'application/pdf' && isBridgeUrl(url, baseUrl) ? url : null
}

const UPLOAD_PATH = /^\/api\/chat\/uploads\/[A-Za-z0-9_-]{8,64}(\?[^#\s\\]*)?$/
const RAW_PATH = /^\/api\/chat\/files\/raw\?[^#\s\\]*$/

/**
 * A route param that names a bridge file (`url` on /chat/file and /chat/view, which
 * a deep link can reach): only a `/`-relative bridge path, never an absolute URL,
 * a protocol-relative `//host` or anything with a backslash or whitespace.
 */
export function bridgePath(param: string | undefined | null): string | null {
  const p = String(param ?? '')
  return /^\/(?![/\\])[^\s\\#]*$/.test(p) ? p : null
}

/** An upload id route param, as the bridge accepts them (chat/uploads.mjs validUploadId). */
export const uploadPath = (id: string | undefined | null): string | null =>
  /^[A-Za-z0-9_-]{8,64}$/.test(String(id ?? '')) ? `/api/chat/uploads/${id}` : null

/**
 * Whether a HEAD's status means the file is gone. Only the upload and raw-file
 * routes answer HEAD for a file; any other /api route may not answer HEAD at all,
 * so its 404 says nothing and the link opens with the type its name suggests.
 */
export function headProvesGone(path: string, status: number): boolean {
  return status === 404 && (UPLOAD_PATH.test(path) || RAW_PATH.test(path))
}

/** A file name safe to create in the cache: no separators, never `.`, `..` or empty. */
export function cacheFileName(name: string): string {
  const n = String(name ?? '').replace(/[/\\:\x00-\x1f]/g, '_').trim()
  return !n || n === '.' || n === '..' ? 'file' : n
}
