// chat/favicon.mjs — a website's icon, fetched so a project can wear it.
//
// The owner types a site ("example.app"); this reads the page's <link rel=icon>
// and apple-touch-icon tags, tries the biggest raster one first, then the usual
// /apple-touch-icon.png and /favicon.ico, and returns the first that is really an
// image. SVG is refused: the bridge serves uploads inline from its own origin.

const MAX_PAGE = 1024 * 1024
const MAX_ICON = 1024 * 1024
const TIMEOUT_MS = 8000

const RASTER = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
}

/** "example.app" or "https://example.app/x" → a URL; anything not http(s) → null. */
export function siteUrl(input) {
  const raw = String(input || '').trim()
  if (!raw || raw.length > 500) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch { return null }
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3]).trim() : ''
}

/** Icon links in a page, best first: apple-touch-icon, then by declared size. */
export function iconLinks(html, base) {
  const out = []
  for (const [tag] of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(tag, 'rel').toLowerCase().split(/\s+/)
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon') && !rel.includes('apple-touch-icon-precomposed')) continue
    const href = attr(tag, 'href')
    if (!href || /\.svg(\?|#|$)/i.test(href) || /svg/i.test(attr(tag, 'type'))) continue
    let url
    try { url = new URL(href, base) } catch { continue }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    const size = Math.max(0, ...attr(tag, 'sizes').split(/\s+/).map((s) => Number(s.split(/x/i)[0]) || 0))
    const touch = rel.some((r) => r.startsWith('apple-touch-icon'))
    out.push({ url: url.href, score: (touch ? 180 : 0) + size })
  }
  return out.sort((a, b) => b.score - a.score).map((c) => c.url)
}

/** The image type from the first bytes, so a page that answers 200 with HTML is not taken for an icon. */
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon'
  return null
}

async function get(fetchImpl, url, max) {
  const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0 (Totem favicon fetch)' } })
  if (!r.ok) return null
  const len = Number(r.headers.get('content-length') || 0)
  if (len > max) return null
  const buffer = Buffer.from(await r.arrayBuffer())
  return buffer.length > max ? null : { buffer, url: r.url || url }
}

/**
 * Fetch a site's icon. Returns { buffer, mime, name } or throws with a status the
 * route can send.
 */
export async function fetchFavicon(site, { fetchImpl = fetch } = {}) {
  const url = siteUrl(site)
  if (!url) throw Object.assign(new Error('that is not a website address'), { status: 400 })
  let page = null
  try { page = await get(fetchImpl, url.href, MAX_PAGE) } catch {}
  const base = page?.url || url.href
  const candidates = [
    ...(page ? iconLinks(page.buffer.toString('utf8'), base) : []),
    new URL('/apple-touch-icon.png', base).href,
    new URL('/favicon.ico', base).href,
  ]
  for (const href of [...new Set(candidates)]) {
    let icon = null
    try { icon = await get(fetchImpl, href, MAX_ICON) } catch { continue }
    const mime = icon && sniffImage(icon.buffer)
    if (!mime) continue
    return { buffer: icon.buffer, mime, name: `${url.hostname.replace(/^www\./, '')}-icon${RASTER[mime]}` }
  }
  throw Object.assign(new Error(page ? `${url.hostname} has no icon Totem can use (SVG-only icons are not supported)` : `couldn't reach ${url.hostname}`), { status: 422 })
}
