// strava/remote.mjs — the owner's Strava, read from Bushido.
//
// Bushido is the only holder of the owner's Strava grant (since 2026-10-14). It
// serves the owner's client over `POST /api/strava/owner { method, args }`, which
// runs that method there and answers `{ result }`. This module gives the bridge an
// object with the same methods its own client had, so goals (goals/sources.mjs),
// the totem_strava_* MCP tools, the gateway's strava__* tools and strava/cli.mjs
// did not change when the grant moved.
//
// Connecting is not here: the owner connects Strava in Bushido (profile →
// Settings). Two holders of one Strava grant would refresh each other's tokens
// away.
//
// Configuration: BUSHIDO_API_URL (default BUSHIDO_URL; point it at Bushido's
// loopback address when its public one is behind an auth proxy) and
// BUSHIDO_API_TOKEN (Bushido's own BUSHIDO_API_TOKEN).

export class StravaError extends Error {
  constructor(message, { status = null, needsReauth = false, missingScope = null, rateLimited = false } = {}) {
    super(message)
    this.name = 'StravaError'
    this.status = status
    this.needsReauth = needsReauth
    this.missingScope = missingScope
    this.rateLimited = rateLimited
  }
}

// The mirror is the whole activity history (hundreds of kB), and a page of goals
// asks for it once per render. Memoised briefly; a sync through here clears it.
const CACHE_TTL_MS = 60 * 1000

export function createRemoteStravaClient({ url, token, publicUrl = null, fetchImpl = globalThis.fetch, timeoutMs = 60000, now = () => Date.now() } = {}) {
  const read = (v) => (typeof v === 'function' ? v() : v)
  const base = () => String(read(url) || '').trim().replace(/\/+$/, '')
  const secret = () => String(read(token) || '').trim()
  const configured = () => Boolean(base() && secret())
  // Where the owner goes to connect: the address he opens, not the loopback one.
  const link = () => String(read(publicUrl) || base() || '').replace(/\/+$/, '') || null
  let cacheMemo = null

  async function call(method, ...args) {
    if (!configured()) {
      throw new StravaError('Strava is read from Bushido: set BUSHIDO_URL (or BUSHIDO_API_URL) and BUSHIDO_API_TOKEN', { needsReauth: true })
    }
    let res
    try {
      res = await fetchImpl(`${base()}/api/strava/owner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret()}` },
        body: JSON.stringify({ method, args }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new StravaError(`could not reach Bushido for Strava: ${e.message || e}`)
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new StravaError(body?.error || `Bushido answered HTTP ${res.status}`, {
        status: body?.status ?? res.status,
        needsReauth: Boolean(body?.needsReauth),
        missingScope: body?.missingScope || null,
        rateLimited: Boolean(body?.rateLimited) || res.status === 429,
      })
    }
    return body?.result ?? null
  }

  const forward = (method) => (...args) => call(method, ...args)
  const changes = (method) => async (...args) => {
    const out = await call(method, ...args)
    cacheMemo = null
    return out
  }

  async function readCache() {
    if (cacheMemo && now() - cacheMemo.at < CACHE_TTL_MS) return cacheMemo.cache
    const cache = await call('readCache')
    cacheMemo = { at: now(), cache }
    return cache
  }

  async function status() {
    const where = 'Connect it in Bushido: profile → Settings → Connect Strava.'
    if (!configured()) {
      return { configured: false, connected: false, state: 'unconfigured', source: 'bushido', detail: 'Strava is read from Bushido. Set BUSHIDO_URL and BUSHIDO_API_TOKEN.', bushidoUrl: link() }
    }
    try {
      const s = await call('status')
      return { ...s, source: 'bushido', bushidoUrl: link(), detail: s?.state === 'ready' ? 'Connected in Bushido.' : `${s?.detail || ''} ${where}`.trim() }
    } catch (e) {
      return { configured: true, connected: false, state: 'unreachable', source: 'bushido', bushidoUrl: link(), detail: e.message }
    }
  }

  return {
    configured, status, readCache,
    athlete: forward('athlete'), stats: forward('stats'), zones: forward('zones'),
    activities: forward('activities'), activity: forward('activity'), gear: forward('gear'),
    routes: forward('routes'), routeStreams: forward('routeStreams'), segments: forward('segments'), clubs: forward('clubs'),
    cachedList: forward('cachedList'), cachedMileage: forward('cachedMileage'),
    updateActivity: changes('updateActivity'), createActivity: changes('createActivity'), updateAthlete: forward('updateAthlete'),
    sync: changes('sync'),
  }
}
