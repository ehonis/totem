// cliproxy/client.mjs — the one way Totem talks to CLIProxyAPI's management API.
//
// CLIProxyAPI holds every Claude and Codex subscription login and serves them to
// the agent CLIs as one API. Its management API (`/v8/management/*`) lists those
// logins, changes them, and makes upstream calls with a login's own token
// (`/requests/api-call`, `$TOKEN$` in a header is replaced by the proxy). The
// management key is the proxy's root: it can read every refresh token. It never
// leaves this module: not in an error, not in a log line, not to the browser.
//
// URL and key are read on every call (CLIPROXY_URL, CLIPROXY_MANAGEMENT_KEY), so
// saving them in Settings → Providers applies without a restart.
import { createHash } from 'node:crypto'
import { redactTokens } from '../chat/redact.mjs'

export const MANAGEMENT_PREFIX = '/v8/management'
const DEFAULT_TIMEOUT_MS = 15_000
const REFUSED_RETRY_MS = 30 * 60_000

// The only upstream URLs a login's token may be sent to. Totem builds every one of
// them from constants; this is the second lock, so a URL from anywhere else is
// refused before the proxy ever sees it.
export const UPSTREAM_ALLOWED = Object.freeze([
  /^https:\/\/api\.anthropic\.com\/api\/oauth\/(usage|profile)(\?cedar_ember=1&skip_spend=1)?$/,
  /^https:\/\/api\.anthropic\.com\/api\/organizations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/reset_rate_limits$/,
  /^https:\/\/chatgpt\.com\/backend-api\/wham\/(usage|rate-limit-reset-credits|rate-limit-reset-credits\/consume)$/,
])
export const upstreamAllowed = (url) => UPSTREAM_ALLOWED.some((re) => re.test(String(url)))

export class CliproxyError extends Error {
  constructor(message, { status = 502, upstreamStatus = null, code = null } = {}) {
    super(message)
    this.name = 'CliproxyError'
    this.status = status
    this.upstreamStatus = upstreamStatus
    this.code = code
  }
}

const trimUrl = (value) => String(value || '').trim().replace(/\/+$/, '')

/** Upstream error text, short and scrubbed: never the key, never a token shape. */
function scrub(text, key) {
  let out = String(text ?? '')
  if (key) out = out.split(key).join('[redacted]')
  out = redactTokens(out).replace(/\s+/g, ' ').trim()
  return out.length > 300 ? `${out.slice(0, 300)}…` : out
}

function messageOf(body) {
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string') return body.error
    if (typeof body.error?.message === 'string') return body.error.message
    if (typeof body.message === 'string') return body.message
  }
  return typeof body === 'string' ? body : ''
}

export function createCliproxyClient({
  url = () => process.env.CLIPROXY_URL,
  key = () => process.env.CLIPROXY_MANAGEMENT_KEY,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const config = () => ({ base: trimUrl(url()), secret: String(key() || '').trim() })
  // A key the proxy refused (401: the only answer its ban counts) is not sent
  // again until it changes, the owner retries, or half an hour passes, when the
  // ban would have lifted: five refusals in a row ban this address, the right key
  // included. Every caller goes through here.
  let refused = null
  let refusalGeneration = 0

  function configured() {
    const { base, secret } = config()
    return Boolean(base && secret)
  }

  /** Where the proxy is, for display (no credentials in it). */
  function baseUrl() {
    const { base } = config()
    try {
      const u = new URL(base)
      u.username = ''
      u.password = ''
      return trimUrl(u.toString())
    } catch {
      return base || null
    }
  }

  /** Changes when the URL or key does, without holding either. */
  function fingerprint() {
    const { base, secret } = config()
    return createHash('sha256').update(`${base}\n${secret}`).digest('hex').slice(0, 16)
  }

  /** Send the refused key again on the next call (a save in Settings, or Retry). */
  function forgetRefusal() {
    refusalGeneration += 1
    refused = null
  }

  /** One management call; `json` is sent as a JSON body. */
  async function request(method, path, { query, json, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const { base, secret } = config()
    if (!base || !secret) throw new CliproxyError('CLIProxy is not set up', { status: 409, code: 'not_configured' })
    // Taken once, so a late answer for an old key is never booked against a new one.
    const fp = fingerprint()
    const generation = refusalGeneration
    if (refused && refused.fingerprint === fp && Date.now() - refused.at < REFUSED_RETRY_MS) {
      throw new CliproxyError(`${refused.message} Not sent again until the key changes; Retry sends it once.`, { status: 502, upstreamStatus: 401, code: 'bad_key' })
    }
    let target
    try {
      target = new URL(`${base}${MANAGEMENT_PREFIX}${path}`)
    } catch {
      throw new CliproxyError('CLIPROXY_URL is not a valid URL', { status: 409, code: 'bad_url' })
    }
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) v.forEach((item) => target.searchParams.append(k, String(item)))
      else target.searchParams.set(k, String(v))
    }
    const headers = { authorization: `Bearer ${secret}`, accept: 'application/json' }
    let body
    if (json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(json)
    }
    const signal = AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await fetchImpl(target, { method, headers, body, signal, redirect: 'error' })
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      throw new CliproxyError(timedOut ? 'CLIProxy did not answer in time' : `CLIProxy is unreachable (${scrub(err?.cause?.code || err?.message, secret)})`, {
        status: 502,
        code: timedOut ? 'timeout' : 'unreachable',
      })
    }
    const text = await response.text()
    let parsed = null
    if (text.trim()) {
      try { parsed = JSON.parse(text) } catch { parsed = text }
    }
    const current = generation === refusalGeneration && fp === fingerprint()
    if (!response.ok) {
      const detail = scrub(messageOf(parsed) || text, secret)
      // The fork's scoped keys refuse what they do not list with this prefix: the
      // key is fine, its scope is missing a route (docs/cliproxy.md lists them).
      if (response.status === 403 && /^scoped key:/i.test(detail)) {
        throw new CliproxyError(`CLIProxy's scoped key does not allow this (${detail.replace(/^scoped key:\s*/i, '')}). Add it to the key's scope.`, { status: 502, upstreamStatus: 403, code: 'scope_refused' })
      }
      const status = response.status === 401 || response.status === 403 ? 502 : response.status === 404 ? 404 : response.status >= 500 ? 502 : 400
      const what = response.status === 401 ? 'CLIProxy refused the management key' : `CLIProxy answered ${response.status}`
      if (current && response.status === 401) refused = { fingerprint: fp, at: Date.now(), message: detail ? `${what}: ${detail}.` : `${what}.` }
      throw new CliproxyError(detail ? `${what}: ${detail}` : what, { status, upstreamStatus: response.status, code: response.status === 401 ? 'bad_key' : response.status === 403 ? 'forbidden' : null })
    }
    return parsed
  }

  /**
   * An upstream call made with one login's token. `$TOKEN$` in a header value is
   * replaced by the proxy. Returns the upstream status and parsed body; a non-2xx
   * upstream answer is not thrown, the caller decides.
   */
  async function upstream(authIndex, { method = 'GET', url: upstreamUrl, header = {}, data, timeoutMs = 15_000 }) {
    if (!upstreamAllowed(upstreamUrl)) throw new CliproxyError('refused: not an allowed upstream URL', { status: 400, code: 'upstream_refused' })
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(authIndex))) throw new CliproxyError('refused: bad auth index', { status: 400, code: 'bad_auth_index' })
    const reply = await request('POST', '/requests/api-call', {
      json: { authIndex, method, url: upstreamUrl, header, ...(data === undefined ? {} : { data: typeof data === 'string' ? data : JSON.stringify(data) }) },
      timeoutMs,
    })
    const statusCode = Number(reply?.status_code ?? 0)
    let body = reply?.body ?? null
    if (typeof body === 'string' && body.trim()) {
      try { body = JSON.parse(body) } catch { /* plain text */ }
    }
    return { statusCode, body }
  }

  return { configured, baseUrl, fingerprint, forgetRefusal, request, upstream, scrub: (text) => scrub(text, config().secret) }
}
