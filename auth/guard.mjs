// Cross-site request checks for anything a browser can be tricked into sending.
//
// A session cookie (or proxy mode, where the auth proxy's cookie plays the same
// role) rides along on any request the browser makes, including one started by
// another site. So every state-changing request authenticated that way must come
// from this origin. A bearer token cannot be attached by another site, so bearer
// callers (the phone shortcut, the MCP gateway, sibling apps) are not checked —
// they are usually not browsers and send no Origin at all.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Bodies that are not JSON on purpose: the voice journal posts raw audio.
const RAW_BODY_TYPES = /^(audio\/|video\/(mp4|webm)|application\/octet-stream)/i

function hostOf(value) {
  try { return new URL(value).host.toLowerCase() } catch { return null }
}

/** Hosts a same-origin request may name: the Host header, any forwarded host, PUBLIC_URL's. */
function ownHosts(req, publicUrl) {
  const hosts = new Set()
  const host = String(req.headers.host || '').toLowerCase()
  if (host) hosts.add(host)
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase()
  if (forwarded) hosts.add(forwarded)
  const pub = publicUrl ? hostOf(publicUrl) : null
  if (pub) hosts.add(pub)
  return hosts
}

/**
 * Is this request from another site? Uses Sec-Fetch-Site when the browser sends
 * it and checks Origin whenever present. `Origin: null` (sandboxed frames, some
 * redirects, file://) is treated as cross-site. With neither header the request
 * is not from a modern browser's cross-site context and is allowed.
 */
export function isCrossSite(req, { publicUrl = '' } = {}) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.origin
  if (origin === undefined) return false
  if (origin === 'null' || origin === '') return true
  const host = hostOf(origin)
  return !host || !ownHosts(req, publicUrl).has(host)
}

function hasBody(req) {
  const length = Number(req.headers['content-length'])
  return (Number.isFinite(length) && length > 0) || Boolean(req.headers['transfer-encoding'])
}

/**
 * The checks for one request. `via` is how it authenticated ('bearer', 'session',
 * 'proxy', or null for routes that need no sign-in yet, such as login).
 * Returns null when it may proceed, or { status, error } to send back.
 */
export function guardRequest(req, { via, publicUrl = '' } = {}) {
  if (SAFE_METHODS.has(req.method) || via === 'bearer') return null
  if (isCrossSite(req, { publicUrl })) {
    return { status: 403, error: { code: 'CROSS_SITE', message: 'Cross-site request refused.' } }
  }
  if (hasBody(req)) {
    const type = String(req.headers['content-type'] || '').toLowerCase()
    if (!type.startsWith('application/json') && !RAW_BODY_TYPES.test(type)) {
      return { status: 415, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send the body as application/json.' } }
    }
  }
  return null
}

/** For the terminal WebSocket upgrade authenticated by cookie: Origin must be this host. */
export function upgradeOriginAllowed(req, { publicUrl = '' } = {}) {
  const origin = req.headers.origin
  if (!origin || origin === 'null') return false
  const host = hostOf(origin)
  return Boolean(host && ownHosts(req, publicUrl).has(host))
}
