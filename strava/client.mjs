// strava/client.mjs — OAuth 2 and the Strava v3 API, as the bridge uses it.
//
// The shape mirrors the WHOOP code in bridge.mjs on purpose (same token file
// convention, same "the fix is in the error message" rule, same status vocabulary)
// so the two connectors are learned once. It lives in its own module because
// bridge.mjs is already eleven thousand lines and this surface is large: Strava
// exposes activities, streams, laps, zones, gear, routes, segments, clubs and
// the athlete, and the brief was to expose all of it rather than the three
// fields a ride card needs.
//
// Docs: https://developers.strava.com/docs/reference/ — see docs/strava.md.
//
// Token handling, the part that bites:
//   * Access tokens live six hours. Strava's refresh endpoint hands back the
//     SAME access token if it still has more than an hour left, and a new pair
//     otherwise — so refreshing early is free and this refreshes at T-5min.
//   * The refresh token "may or may not" rotate. When it does, the old one dies
//     immediately, so whatever comes back is persisted before anything else runs.
//     Refreshes are serialised through one in-flight promise for the same reason.
//   * The granted scope arrives on the CALLBACK URL (`?scope=read,activity:read_all`),
//     not in the token response. It is stored from there, and a refresh never
//     widens it — reconnecting is the only way to add a scope.
//   * Rate limits: 100 reads / 15 min and 1,000 / day on a fresh app (double for
//     the overall bucket). Every response's X-RateLimit-* headers are captured
//     so the status can say how much budget is left.

import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import {
  summarizeActivity, detailActivity, shapeGear, shapeAthlete, shapeStats, shapeZones, shapeActivityZones,
  shapeStreams, shapeLap, shapeRoute, shapeSegment, shapeSegmentEffort, shapeClub, matchesSport, mileage,
  daysAgoLocal, num,
} from './shape.mjs'
import { syncCache, normalizeCache, cachedActivities, cacheAgeMinutes } from './cache.mjs'

export const STRAVA_ORIGIN = process.env.STRAVA_API_ORIGIN || 'https://www.strava.com'
export const STRAVA_AUTH_URL = `${STRAVA_ORIGIN}/oauth/authorize`
export const STRAVA_TOKEN_URL = `${STRAVA_ORIGIN}/oauth/token`
export const STRAVA_REVOKE_URL = `${STRAVA_ORIGIN}/oauth/revoke`
export const STRAVA_DEAUTH_URL = `${STRAVA_ORIGIN}/oauth/deauthorize`
export const STRAVA_API = `${STRAVA_ORIGIN}/api/v3`

/*
 * Everything Strava will grant. The brief was "don't scope the API, make it
 * full", so writes are included: `activity:write` lets a ride be renamed or a
 * manual one logged, `profile:write` sets weight/FTP. Every read tool works
 * without them, and `stravaStatus` reports which of these a grant is missing.
 * Reconnect (approval_prompt=force) is how a grant picks up a new scope.
 */
export const DEFAULT_SCOPES = ['read', 'read_all', 'profile:read_all', 'profile:write', 'activity:read_all', 'activity:write']

// A granted scope satisfies the scopes it contains: `activity:read_all` is
// `activity:read` plus private activities, and so on.
const IMPLIES = {
  read_all: ['read'],
  'activity:read_all': ['activity:read'],
  'profile:read_all': ['profile:read'],
}

export const parseScopes = (s) => new Set(String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))

export function grantedScopeSet(scopeString) {
  const granted = parseScopes(scopeString)
  for (const s of [...granted]) for (const implied of IMPLIES[s] || []) granted.add(implied)
  return granted
}

export class StravaError extends Error {
  constructor(message, { status = null, code = null, needsReauth = false, missingScope = null, rateLimited = false } = {}) {
    super(message)
    this.name = 'StravaError'
    this.status = status
    this.code = code
    this.needsReauth = needsReauth
    this.missingScope = missingScope
    this.rateLimited = rateLimited
  }
}

export function createStravaClient({
  clientId: clientIdOption,
  clientSecret: clientSecretOption,
  redirectUri: redirectUriOption,
  tokensFile,
  cacheFile,
  scopes = DEFAULT_SCOPES,
  timeZone = 'UTC',
  log = () => {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const requestedScopes = Array.isArray(scopes) ? scopes : String(scopes).split(/[\s,]+/).filter(Boolean)
  // Each may be a value or a function returning one, so credentials entered in
  // the dashboard take effect without a restart.
  const read = (v) => (typeof v === 'function' ? v() : v)
  const clientId = () => read(clientIdOption)
  const clientSecret = () => read(clientSecretOption)
  const redirectUri = () => read(redirectUriOption)
  const configured = () => Boolean(clientId() && clientSecret())

  // ---- token file -----------------------------------------------------------

  async function writeJsonAtomic(path, obj) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(obj, null, 2))
    await rename(tmp, path)
  }
  async function readTokens() {
    try { return JSON.parse(await readFile(tokensFile, 'utf8')) } catch { return null }
  }
  async function writeTokens(tokens) { await writeJsonAtomic(tokensFile, tokens) }

  async function markNeedsReauth(reason) {
    const tokens = (await readTokens()) || {}
    await writeTokens({ ...tokens, needsReauth: true, lastError: String(reason || 'the saved Strava grant is no longer valid').slice(0, 300), lastErrorAt: new Date().toISOString() })
  }

  // ---- rate limit bookkeeping ----------------------------------------------

  let rateLimit = null
  function captureRateLimit(res) {
    const pair = (h) => {
      const v = res.headers.get(h)
      if (!v) return null
      const [a, b] = v.split(',').map((x) => Number(x.trim()))
      return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null
    }
    const limit = pair('x-ratelimit-limit')
    const usage = pair('x-ratelimit-usage')
    const readLimit = pair('x-readratelimit-limit')
    const readUsage = pair('x-readratelimit-usage')
    if (!limit && !usage && !readLimit && !readUsage) return
    rateLimit = {
      at: new Date().toISOString(),
      overall: limit && usage ? { limit15: limit[0], usage15: usage[0], limitDay: limit[1], usageDay: usage[1] } : null,
      read: readLimit && readUsage ? { limit15: readLimit[0], usage15: readUsage[0], limitDay: readLimit[1], usageDay: readUsage[1] } : null,
    }
  }

  // ---- OAuth -------------------------------------------------------------------

  const sessions = new Map() // state -> { createdAt }

  function startAuth() {
    if (!configured()) throw new StravaError('add the Strava client ID and secret in Settings → Integrations first (strava.com/settings/api)')
    const state = randomBytes(16).toString('hex')
    for (const [k, v] of sessions) if (Date.now() - v.createdAt > 15 * 60 * 1000) sessions.delete(k)
    sessions.set(state, { createdAt: Date.now() })
    const url = new URL(STRAVA_AUTH_URL)
    url.searchParams.set('client_id', clientId())
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('response_type', 'code')
    // `force` always shows the consent screen, which is the only way an existing
    // grant picks up a scope added since. `auto` would silently keep the old set.
    url.searchParams.set('approval_prompt', 'force')
    url.searchParams.set('scope', requestedScopes.join(','))
    url.searchParams.set('state', state)
    return { ok: true, authUrl: url.toString(), redirectUri: redirectUri(), scopes: requestedScopes }
  }

  async function tokenExchange(params, { grantedScope = null, keep = {} } = {}) {
    const body = new URLSearchParams({ client_id: clientId() || '', client_secret: clientSecret() || '', ...params })
    let res
    try {
      res = await fetchImpl(STRAVA_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() })
    } catch (e) {
      throw new StravaError(`could not reach Strava's token endpoint: ${e.message || e}`)
    }
    captureRateLimit(res)
    const text = await res.text()
    let json = {}
    try { json = JSON.parse(text) } catch { /* Strava's 5xx pages are HTML */ }
    if (!res.ok) {
      const errs = Array.isArray(json.errors) ? json.errors : []
      const detail = errs.map((e) => `${e.resource || ''}.${e.field || ''} ${e.code || ''}`.trim()).join('; ') || json.message || text.slice(0, 120)
      // Only a rejected refresh token means the grant is dead. A 5xx or a bare
      // 400 during an outage does not — see the WHOOP notes for why that matters.
      const dead = res.status === 400 && errs.some((e) => e.resource === 'RefreshToken' || e.field === 'refresh_token' || e.code === 'invalid')
      const message = `Strava token exchange failed (HTTP ${res.status})${detail ? ` — ${detail}` : ''}${dead ? ' — the saved refresh token is no longer valid, reconnect Strava' : ''}`
      if (dead) await markNeedsReauth(message)
      throw new StravaError(message, { status: res.status, needsReauth: dead })
    }
    if (!json.access_token) throw new StravaError('Strava returned no access token')
    const saved = {
      ...keep,
      access_token: json.access_token,
      refresh_token: json.refresh_token || keep.refresh_token || null,
      expires_at: num(json.expires_at) ? num(json.expires_at) * 1000 : Date.now() + (num(json.expires_in) || 21600) * 1000,
      token_type: json.token_type || 'Bearer',
      // The callback's scope wins; the token response rarely carries one, and a
      // refresh never widens a grant.
      scope: grantedScope || keep.scope || json.scope || null,
      athlete: json.athlete ? shapeAthlete(json.athlete) : keep.athlete || null,
      needsReauth: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: new Date().toISOString(),
    }
    await writeTokens(saved)
    return saved
  }

  /** Called by the unauthenticated callback route; the unguessable `state` is the guard. */
  async function completeAuth(query) {
    const state = query.get('state')
    const code = query.get('code')
    const error = query.get('error')
    if (!state || !sessions.has(state)) return { ok: false, message: 'Unknown or expired sign-in attempt — start again from the dashboard.' }
    sessions.delete(state)
    if (error) return { ok: false, message: `Strava did not authorize: ${error}` }
    if (!code) return { ok: false, message: 'Strava did not return an authorization code.' }
    const granted = query.get('scope') || null
    const tokens = await tokenExchange({ code, grant_type: 'authorization_code' }, { grantedScope: granted })
    if (!tokens.refresh_token) return { ok: false, message: 'Strava returned no refresh token — the connection would die in six hours. Try again.' }
    const missing = requestedScopes.filter((s) => !grantedScopeSet(tokens.scope).has(s))
    const who = tokens.athlete?.name ? ` as ${tokens.athlete.name}` : ''
    return {
      ok: true,
      message: `Strava connected${who}.${missing.length ? ` Note: ${missing.join(', ')} were not granted — untick nothing next time if you want them.` : ''} You can close this tab and return to the dashboard.`,
    }
  }

  let refreshing = null
  async function accessToken() {
    const tokens = await readTokens()
    if (!tokens?.refresh_token) throw new StravaError('Strava is not connected yet — connect it from Settings → Connections', { needsReauth: true })
    if (tokens.access_token && Number(tokens.expires_at) > Date.now() + 5 * 60 * 1000) return tokens.access_token
    if (refreshing) return (await refreshing).access_token
    refreshing = tokenExchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, { keep: tokens })
    try { return (await refreshing).access_token } finally { refreshing = null }
  }

  async function grantedScopes() {
    const tokens = await readTokens()
    return grantedScopeSet(tokens?.scope)
  }

  async function requireScopes(needed) {
    // Not connected at all is a different sentence from connected-without-a-scope,
    // and the first has to win: "authorized without activity:read" is nonsense when
    // nothing was ever authorized.
    if (!configured()) throw new StravaError('Strava is not configured — add its client ID and secret in Settings → Integrations')
    const tokens = await readTokens()
    if (!tokens?.refresh_token) throw new StravaError('Strava is not connected yet — connect it from Settings → Connections', { needsReauth: true })
    const have = await grantedScopes()
    const missing = needed.filter((s) => !have.has(s))
    if (missing.length) {
      throw new StravaError(`this Strava connection was authorized without ${missing.join(', ')} — click Reconnect Strava to grant it`, { missingScope: missing.join(',') })
    }
  }

  async function disconnect() {
    const tokens = await readTokens()
    let revoked = false
    if (tokens?.access_token && configured()) {
      try {
        const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')
        const r = await fetchImpl(STRAVA_REVOKE_URL, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh_token || tokens.access_token, token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token' }).toString() })
        revoked = r.ok
        if (!r.ok) {
          const r2 = await fetchImpl(STRAVA_DEAUTH_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ access_token: tokens.access_token }).toString() })
          revoked = r2.ok
        }
      } catch (e) {
        log(`strava revoke failed: ${e.message || e}`)
      }
    }
    // The grant is forgotten locally whatever Strava said: the file is the connection.
    await writeTokens({ disconnectedAt: new Date().toISOString(), revoked })
    return { ok: true, revoked }
  }

  // ---- API -------------------------------------------------------------------

  async function api(pathname, { query = {}, method = 'GET', body = null, retry = true } = {}) {
    const token = await accessToken()
    const url = new URL(`${STRAVA_API}${pathname}`)
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
    let payload
    if (body && method !== 'GET') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      payload = new URLSearchParams(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null))).toString()
    }
    let res
    try {
      res = await fetchImpl(url, { method, headers, body: payload })
    } catch (e) {
      throw new StravaError(`could not reach Strava: ${e.message || e}`)
    }
    captureRateLimit(res)
    if (res.status === 204) return null
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* HTML error page */ }
    if (res.ok) return json
    const errs = Array.isArray(json?.errors) ? json.errors : []
    const detail = errs.map((e) => `${e.resource || ''}.${e.field || ''} ${e.code || ''}`.trim()).join('; ') || json?.message || ''
    if (res.status === 429) {
      const q = 15 - (new Date().getMinutes() % 15)
      throw new StravaError(`Strava rate limit hit (${detail || '100 reads per 15 minutes'}) — the 15-minute window resets in about ${q} min; the daily one at midnight UTC`, { status: 429, rateLimited: true })
    }
    if (res.status === 401) {
      // A missing scope comes back as 401 with `AccessToken.<scope>_permission missing`.
      const scopeErr = errs.find((e) => /permission/.test(e.field || ''))
      if (scopeErr) {
        const scope = String(scopeErr.field).replace(/_permission$/, '')
        throw new StravaError(`Strava refused ${pathname}: the grant lacks ${scope} — click Reconnect Strava to add it`, { status: 401, missingScope: scope })
      }
      // Otherwise the access token is bad. Force one refresh and retry once —
      // a token revoked on Strava's side looks the same and will fail again,
      // at which point the reason surfaces.
      if (retry) {
        const tokens = await readTokens()
        if (tokens?.refresh_token) {
          await tokenExchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, { keep: tokens })
          return api(pathname, { query, method, body, retry: false })
        }
      }
      throw new StravaError(`Strava rejected the token (${detail || 'unauthorized'}) — reconnect Strava from Settings → Connections`, { status: 401, needsReauth: true })
    }
    if (res.status === 404) throw new StravaError(`Strava has nothing at ${pathname}${detail ? ` (${detail})` : ''} — wrong id, or not visible to this athlete`, { status: 404 })
    if (res.status === 402) throw new StravaError(`Strava says ${pathname} needs a subscription${detail ? ` (${detail})` : ''}`, { status: 402 })
    throw new StravaError(`Strava ${method} ${pathname} failed (HTTP ${res.status})${detail ? ` — ${detail}` : ''}`, { status: res.status })
  }

  // ---- reads ---------------------------------------------------------------------

  async function athlete() {
    return shapeAthlete(await api('/athlete'))
  }

  async function athleteId() {
    const tokens = await readTokens()
    if (tokens?.athlete?.id) return tokens.athlete.id
    const me = await athlete()
    if (me?.id) {
      const t = (await readTokens()) || {}
      await writeTokens({ ...t, athlete: me })
    }
    return me?.id
  }

  async function stats() {
    await requireScopes(['profile:read_all'])
    const id = await athleteId()
    return shapeStats(await api(`/athletes/${id}/stats`))
  }

  async function zones() {
    await requireScopes(['profile:read_all'])
    return shapeZones(await api('/athlete/zones'))
  }

  const toEpoch = (v) => {
    if (v === undefined || v === null || v === '') return undefined
    if (/^\d{9,10}$/.test(String(v))) return Number(v)
    const t = Date.parse(String(v))
    return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
  }

  /**
   * Activities in a window, live. `days` back from now by default; `after` and
   * `before` take ISO dates or epoch seconds. Walks pages until the window is
   * exhausted (bounded), newest first, and filters by sport after the fact
   * because the API has no sport filter.
   */
  async function activities({ days = 30, after, before, sport = null, limit = 200, perPage = 200, pages = 5, page } = {}) {
    await requireScopes(['activity:read'])
    const span = Math.min(Math.max(Math.round(Number(days)) || 30, 1), 3660)
    const a = toEpoch(after) ?? (before === undefined ? Math.floor(Date.now() / 1000) - span * 86_400 : undefined)
    const b = toEpoch(before)
    const cap = Math.min(Math.max(Math.round(Number(limit)) || 200, 1), 2000)
    const size = Math.min(Math.max(Math.round(Number(perPage)) || 200, 1), 200)
    const out = []
    if (page) {
      const list = await api('/athlete/activities', { query: { after: a, before: b, page, per_page: size } })
      for (const raw of list || []) out.push(raw)
    } else {
      for (let p = 1; p <= pages && out.length < cap; p++) {
        const list = await api('/athlete/activities', { query: { after: a, before: b, page: p, per_page: size } })
        if (!Array.isArray(list) || !list.length) break
        out.push(...list)
        if (list.length < size) break
      }
    }
    const shaped = out.map(summarizeActivity).filter(Boolean).filter((x) => matchesSport(x, sport))
    shaped.sort((x, y) => String(y.start).localeCompare(String(x.start)))
    return { activities: shaped.slice(0, cap), count: Math.min(shaped.length, cap), window: { after: a ? new Date(a * 1000).toISOString() : null, before: b ? new Date(b * 1000).toISOString() : null, days: after || before ? null : span }, sport: sport || null }
  }

  async function activity(id, { efforts = false, laps = false, zones: wantZones = false, streams = null, comments = false, kudos = false } = {}) {
    await requireScopes(['activity:read'])
    if (!id) throw new StravaError('an activity id is required')
    const raw = await api(`/activities/${id}`, { query: { include_all_efforts: efforts ? 'true' : undefined } })
    const out = detailActivity(raw, { segmentEfforts: efforts })
    const extras = []
    if (laps) extras.push(api(`/activities/${id}/laps`).then((l) => { out.laps = (l || []).map(shapeLap) }))
    if (wantZones) extras.push(api(`/activities/${id}/zones`).then((z) => { out.zones = shapeActivityZones(z) }).catch((e) => { out.zones = { error: e.message } }))
    if (streams) {
      const keys = Array.isArray(streams) ? streams : String(streams).split(',').map((s) => s.trim()).filter(Boolean)
      if (keys.length) extras.push(api(`/activities/${id}/streams`, { query: { keys: keys.join(','), key_by_type: 'true' } }).then((s) => { out.streams = shapeStreams(s) }).catch((e) => { out.streams = { error: e.message } }))
    }
    if (comments) extras.push(api(`/activities/${id}/comments`, { query: { per_page: 50 } }).then((c) => { out.comments = (c || []).map((x) => ({ id: x.id, text: x.text, athlete: [x.athlete?.firstname, x.athlete?.lastname].filter(Boolean).join(' '), createdAt: x.created_at })) }).catch((e) => { out.comments = { error: e.message } }))
    if (kudos) extras.push(api(`/activities/${id}/kudos`, { query: { per_page: 100 } }).then((k) => { out.kudos = (k || []).map((x) => [x.firstname, x.lastname].filter(Boolean).join(' ')) }).catch((e) => { out.kudos = { error: e.message } }))
    await Promise.all(extras)
    return out
  }

  async function gear(id) {
    if (id) return shapeGear(await api(`/gear/${id}`))
    // No id: everything the athlete owns, with each item's full detail (the
    // odometer on the summary row is present, but brand/model/description are not).
    const me = await athlete()
    const all = [...(me?.bikes || []), ...(me?.shoes || [])]
    const detailed = await Promise.all(all.map((g) => api(`/gear/${g.id}`).then(shapeGear).catch(() => g)))
    return { bikes: detailed.filter((g) => g.kind === 'bike' || String(g.id).startsWith('b')), shoes: detailed.filter((g) => g.kind === 'shoes' || String(g.id).startsWith('g')), athleteId: me?.id ?? null }
  }

  async function routes({ id = null, page = 1, perPage = 50 } = {}) {
    if (id) return shapeRoute(await api(`/routes/${id}`))
    const me = await athleteId()
    const list = await api(`/athletes/${me}/routes`, { query: { page, per_page: Math.min(Math.max(Number(perPage) || 50, 1), 200) } })
    return { routes: (list || []).map(shapeRoute), count: (list || []).length }
  }

  async function routeStreams(id) {
    return shapeStreams(await api(`/routes/${id}/streams`))
  }

  async function segments({ mode = 'starred', id = null, bounds = null, activityType = null, minCat, maxCat, page = 1, perPage = 50, startDateLocal, endDateLocal } = {}) {
    const size = Math.min(Math.max(Number(perPage) || 50, 1), 200)
    switch (mode) {
      case 'starred': {
        const list = await api('/segments/starred', { query: { page, per_page: size } })
        return { mode, segments: (list || []).map(shapeSegment), count: (list || []).length }
      }
      case 'detail':
        if (!id) throw new StravaError('segment id is required for mode=detail')
        return { mode, segment: shapeSegment(await api(`/segments/${id}`)) }
      case 'efforts': {
        if (!id) throw new StravaError('segment id is required for mode=efforts')
        await requireScopes(['activity:read'])
        const list = await api(`/segments/${id}/all_efforts`, { query: { page, per_page: size, start_date_local: startDateLocal, end_date_local: endDateLocal } })
        return { mode, segmentId: id, efforts: (list || []).map(shapeSegmentEffort), count: (list || []).length }
      }
      case 'effort': {
        if (!id) throw new StravaError('segment effort id is required for mode=effort')
        await requireScopes(['activity:read'])
        return { mode, effort: shapeSegmentEffort(await api(`/segment_efforts/${id}`)) }
      }
      case 'explore': {
        if (!bounds) throw new StravaError('bounds "swLat,swLng,neLat,neLng" are required for mode=explore')
        const res = await api('/segments/explore', { query: { bounds: Array.isArray(bounds) ? bounds.join(',') : bounds, activity_type: activityType, min_cat: minCat, max_cat: maxCat } })
        return { mode, segments: (res?.segments || []).map((s) => ({ id: s.id, name: s.name, climbCategory: num(s.climb_category), climbCategoryDesc: s.climb_category_desc || null, avgGrade: num(s.avg_grade, 1), distanceMi: num(s.distance) === null ? null : num(s.distance / 1609.344, 2), elevDifferenceFt: num(s.elev_difference) === null ? null : Math.round(s.elev_difference / 0.3048), startLatLng: s.start_latlng, endLatLng: s.end_latlng, starred: Boolean(s.starred), url: `https://www.strava.com/segments/${s.id}` })) }
      }
      default:
        throw new StravaError(`unknown segments mode "${mode}" — use starred, detail, efforts, effort or explore`)
    }
  }

  async function clubs(id = null) {
    if (id) return shapeClub(await api(`/clubs/${id}`))
    const list = await api('/athlete/clubs')
    return { clubs: (list || []).map(shapeClub), count: (list || []).length }
  }

  // ---- writes -----------------------------------------------------------------------

  async function updateActivity(id, fields = {}) {
    await requireScopes(['activity:write'])
    if (!id) throw new StravaError('an activity id is required')
    const body = {}
    if (fields.name !== undefined) body.name = String(fields.name)
    if (fields.description !== undefined) body.description = String(fields.description)
    if (fields.sportType !== undefined) body.sport_type = String(fields.sportType)
    if (fields.gearId !== undefined) body.gear_id = fields.gearId === null ? 'none' : String(fields.gearId)
    if (fields.commute !== undefined) body.commute = fields.commute ? 'true' : 'false'
    if (fields.trainer !== undefined) body.trainer = fields.trainer ? 'true' : 'false'
    if (fields.hideFromHome !== undefined) body.hide_from_home = fields.hideFromHome ? 'true' : 'false'
    if (!Object.keys(body).length) throw new StravaError('nothing to update — pass at least one of name, description, sportType, gearId, commute, trainer, hideFromHome')
    const raw = await api(`/activities/${id}`, { method: 'PUT', body })
    return { ok: true, updated: Object.keys(body), activity: detailActivity(raw, { segmentEfforts: false }) }
  }

  async function createActivity({ name, sportType, startDateLocal, elapsedSec, description, distanceMeter, trainer, commute } = {}) {
    await requireScopes(['activity:write'])
    if (!name || !sportType || !startDateLocal || !num(elapsedSec)) throw new StravaError('name, sportType, startDateLocal (ISO) and elapsedSec are required')
    const raw = await api('/activities', { method: 'POST', body: {
      name: String(name), sport_type: String(sportType), start_date_local: String(startDateLocal), elapsed_time: String(Math.round(num(elapsedSec))),
      description: description !== undefined ? String(description) : undefined,
      distance: num(distanceMeter) !== null ? String(num(distanceMeter)) : undefined,
      trainer: trainer === undefined ? undefined : (trainer ? '1' : '0'),
      commute: commute === undefined ? undefined : (commute ? '1' : '0'),
    } })
    return { ok: true, activity: detailActivity(raw, { segmentEfforts: false }) }
  }

  async function updateAthlete({ weightKg } = {}) {
    await requireScopes(['profile:write'])
    if (num(weightKg) === null) throw new StravaError('weightKg is required')
    return { ok: true, athlete: shapeAthlete(await api('/athlete', { method: 'PUT', body: { weight: String(num(weightKg)) } })) }
  }

  // ---- the activity cache --------------------------------------------------------------

  async function readCache() {
    try { return normalizeCache(JSON.parse(await readFile(cacheFile, 'utf8'))) } catch { return normalizeCache(null) }
  }

  let syncing = null
  async function sync({ full = false, pages } = {}) {
    if (syncing) return syncing
    syncing = (async () => {
      await requireScopes(['activity:read'])
      const id = await athleteId()
      const result = await syncCache({
        read: readCache,
        write: (c) => writeJsonAtomic(cacheFile, c),
        fetchPage: ({ after, before, page, perPage }) => api('/athlete/activities', { query: { after, before, page, per_page: perPage } }),
        full,
        pages: pages ?? (full ? 25 : 5),
        athleteId: id,
      })
      const { cache, ...summary } = result
      log(`strava sync: ${summary.mode}, +${summary.added} new, ${summary.updated} refreshed, ${summary.count} cached${summary.complete ? '' : ' (history incomplete — run a full sync to continue)'}`)
      return { ...summary, updatedAt: cache.updatedAt, oldestStart: cache.oldestStart, newestStart: cache.newestStart }
    })()
    try { return await syncing } finally { syncing = null }
  }

  /** Mileage from the cache. Refreshes first when the cache is older than `maxAgeMin`. */
  async function cachedMileage({ group = 'week', days = null, sport = null, gearId = null, from = null, to = null, maxAgeMin = 30, sync: doSync = true } = {}) {
    let cache = await readCache()
    let syncNote = null
    const age = cacheAgeMinutes(cache)
    if (doSync && (age === null || age > maxAgeMin)) {
      try { await sync(); cache = await readCache() } catch (e) { syncNote = `cache not refreshed: ${e.message}` }
    }
    const shaped = cachedActivities(cache).map(summarizeActivity).filter(Boolean)
    const fromDate = from || (num(days) ? daysAgoLocal(num(days), { timeZone }) : null)
    const report = mileage(shaped, { group, sport, gearId, from: fromDate, to })
    return {
      ...report,
      cache: { count: shaped.length, updatedAt: cache.updatedAt, oldestStart: cache.oldestStart, newestStart: cache.newestStart, complete: cache.complete, ageMinutes: cacheAgeMinutes(cache), note: syncNote },
    }
  }

  async function cachedList({ days = null, sport = null, gearId = null, limit = 200, from = null, to = null } = {}) {
    const cache = await readCache()
    const fromDate = from || (num(days) ? daysAgoLocal(num(days), { timeZone }) : null)
    const list = cachedActivities(cache).map(summarizeActivity).filter(Boolean)
      .filter((a) => (!fromDate || a.date >= fromDate) && (!to || a.date <= to) && matchesSport(a, sport) && (!gearId || a.gearId === gearId))
    return { activities: list.slice(0, Math.min(Math.max(Number(limit) || 200, 1), 5000)), count: list.length, cache: { count: Object.keys(cache.activities).length, updatedAt: cache.updatedAt, complete: cache.complete } }
  }

  // ---- status ---------------------------------------------------------------------------

  async function status() {
    const tokens = await readTokens()
    const granted = grantedScopeSet(tokens?.scope)
    const missingScopes = requestedScopes.filter((s) => !granted.has(s))
    const connected = Boolean(tokens?.refresh_token)
    const needsReauth = Boolean(tokens?.needsReauth)
    const state = !configured() ? 'unconfigured'
      : !connected ? 'disconnected'
      : needsReauth ? 'needs-reauth'
      : missingScopes.length ? 'missing-scopes'
      : 'ready'
    const DETAIL = {
      unconfigured: 'Add the Strava client ID and secret in Settings → Integrations, then connect.',
      disconnected: 'Not connected yet.',
      'needs-reauth': 'Strava rejected the saved grant. Reconnecting is the only fix.',
      'missing-scopes': `Authorized without ${missingScopes.join(', ')}. Reconnect to grant it.`,
      ready: 'Connected.',
    }
    const cache = await readCache()
    return {
      configured: configured(),
      connected,
      needsReauth,
      state,
      detail: DETAIL[state],
      athlete: tokens?.athlete ? { id: tokens.athlete.id, name: tokens.athlete.name, username: tokens.athlete.username, profile: tokens.athlete.profileMedium || tokens.athlete.profile || null, url: tokens.athlete.url } : null,
      scopes: [...parseScopes(tokens?.scope)],
      requestedScopes,
      missingScopes,
      accessTokenExpiresAt: tokens?.expires_at ? new Date(Number(tokens.expires_at)).toISOString() : null,
      connectedAt: tokens?.updatedAt || null,
      lastError: tokens?.lastError || null,
      lastErrorAt: tokens?.lastErrorAt || null,
      redirectUri: redirectUri(),
      rateLimit,
      cache: { count: Object.keys(cache.activities).length, updatedAt: cache.updatedAt, oldestStart: cache.oldestStart, newestStart: cache.newestStart, complete: cache.complete, ageMinutes: cacheAgeMinutes(cache) },
    }
  }

  /**
   * The payload Bushido pulls: a window of activities plus the gear map and the
   * athlete's few physiological constants. Live, not from the cache — a ride
   * finished ten minutes ago has to be attachable now.
   */
  async function training({ days = 21 } = {}) {
    const span = Math.min(Math.max(Math.round(Number(days)) || 21, 1), 120)
    const [acts, me] = await Promise.all([activities({ days: span, limit: 500 }), athlete().catch(() => null)])
    const gearIds = [...new Set(acts.activities.map((a) => a.gearId).filter(Boolean))]
    const gearMap = {}
    for (const g of [...(me?.bikes || []), ...(me?.shoes || [])]) gearMap[g.id] = g
    // Gear on an activity that the profile list did not include (retired, say).
    await Promise.all(gearIds.filter((id) => !gearMap[id]).map((id) => gear(id).then((g) => { gearMap[id] = g }).catch(() => {})))
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      days: span,
      athlete: me ? { id: me.id, name: me.name, weightKg: me.weightKg, weightLb: me.weightLb, ftp: me.ftp, measurementPreference: me.measurementPreference } : null,
      gear: gearMap,
      activities: acts.activities,
    }
  }

  return {
    configured, startAuth, completeAuth, disconnect, accessToken, requireScopes, grantedScopes,
    api, athlete, athleteId, stats, zones, activities, activity, gear, routes, routeStreams, segments, clubs,
    updateActivity, createActivity, updateAthlete,
    readCache, sync, cachedMileage, cachedList, status, training,
    get rateLimit() { return rateLimit },
  }
}
