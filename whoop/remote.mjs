// whoop/remote.mjs — the owner's WHOOP, read from Bushido.
//
// Bushido is the only holder of the owner's WHOOP grant. WHOOP rotates the
// refresh token on every refresh and voids the old one, so exactly one process
// may hold it; two holders refresh each other's tokens away. Bushido serves the
// owner's WHOOP over `POST /api/whoop/owner { method, args }`, which runs that
// method there and answers `{ result }`.
//
// Totem asks for two things: `sleepNights` (the nights the sleep habit is filled
// from, recovery already joined) and `status` (for the Connections row). Which
// date a night is filed under, and whether a habit entry is rewritten, stay
// Totem's (syncWhoopSleep in bridge.mjs).
//
// Connecting is not here: the owner connects WHOOP in Bushido (profile →
// Settings).
//
// Configuration: BUSHIDO_API_URL (default BUSHIDO_URL; point it at Bushido's
// loopback address when its public one is behind an auth proxy) and
// BUSHIDO_API_TOKEN (Bushido's own BUSHIDO_API_TOKEN).

import { isSourceFault, noteGrantStatus, tracker } from '../sources/track.mjs'

export class WhoopError extends Error {
  constructor(message, { status = null, needsReauth = false, missingScope = null, rateLimited = false } = {}) {
    super(message)
    this.name = 'WhoopError'
    this.status = status
    this.needsReauth = needsReauth
    this.missingScope = missingScope
    this.rateLimited = rateLimited
  }
}

// The nights come back as a list; a run counts them.
const countRows = (result) => (Array.isArray(result) ? result.length : null)

// A grant Bushido says needs reconnecting, or a rate limit, is the source failing
// whatever status carried it; a request Bushido turned down is not.
const isFault = (e) => Boolean(e?.needsReauth || e?.rateLimited) || isSourceFault(e)

export function createRemoteWhoopClient({ url, token, publicUrl = null, fetchImpl = globalThis.fetch, timeoutMs = 60000, runs = null } = {}) {
  const read = (v) => (typeof v === 'function' ? v() : v)
  const base = () => String(read(url) || '').trim().replace(/\/+$/, '')
  const secret = () => String(read(token) || '').trim()
  const configured = () => Boolean(base() && secret())
  // Every call that reaches WHOOP through Bushido is one run in the source-run log
  // (sources/), once configured: an unset BUSHIDO_URL is not the source failing.
  // `status` is noted separately (noteGrantStatus).
  const track = tracker(runs)
  // Where the owner goes to connect: the address he opens, not the loopback one.
  const link = () => String(read(publicUrl) || base() || '').replace(/\/+$/, '') || null

  async function call(method, ...args) {
    if (!configured()) {
      throw new WhoopError('WHOOP is read from Bushido: set BUSHIDO_URL (or BUSHIDO_API_URL) and BUSHIDO_API_TOKEN', { needsReauth: true })
    }
    if (method === 'status') return request(method, args)
    return track('whoop', () => request(method, args), { rows: countRows, isFault })
  }

  async function request(method, args) {
    let res
    try {
      res = await fetchImpl(`${base()}/api/whoop/owner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret()}` },
        body: JSON.stringify({ method, args }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new WhoopError(`could not reach Bushido for WHOOP: ${e.message || e}`)
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new WhoopError(body?.error || `Bushido answered HTTP ${res.status}`, {
        status: res.status,
        needsReauth: Boolean(body?.needsReauth),
        missingScope: body?.missingScope || null,
        rateLimited: Boolean(body?.rateLimited) || res.status === 429,
      })
    }
    return body?.result ?? null
  }

  async function status() {
    const where = 'Connect it in Bushido: profile → Settings → Connect WHOOP.'
    if (!configured()) {
      return { configured: false, connected: false, needsReauth: false, state: 'unconfigured', source: 'bushido', detail: 'WHOOP is read from Bushido. Set BUSHIDO_URL and BUSHIDO_API_TOKEN.', bushidoUrl: link() }
    }
    try {
      const s = await call('status')
      noteGrantStatus(runs, 'whoop', { status: s })
      return { ...s, source: 'bushido', bushidoUrl: link(), detail: s?.state === 'ready' ? 'Connected in Bushido.' : `${s?.detail || ''} ${where}`.trim() }
    } catch (e) {
      noteGrantStatus(runs, 'whoop', { error: e })
      return { configured: true, connected: false, needsReauth: false, state: 'unreachable', source: 'bushido', bushidoUrl: link(), detail: e.message }
    }
  }

  return {
    configured,
    status,
    // Nights shaped as Totem's habit wants them, recovery joined by cycle. A
    // non-array answer is a contract break, not "no nights".
    async sleepNights({ start, end, value } = {}) {
      const nights = await call('sleepNights', { start, end, value })
      if (!Array.isArray(nights)) throw new WhoopError('Bushido answered sleepNights without a list of nights')
      return nights.filter(Boolean)
    },
  }
}
