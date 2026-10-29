// fleet/http.mjs — the `/api/fleet` adapter.
//
// Behind the /api/* auth gate:
//   GET    /api/fleet                    every machine: health, uptime, watts, cost
//   GET    /api/fleet/devices/:id        one machine in full, processes included
//   PUT    /api/fleet/settings           { enabled?, zip?, rateCents? }
//   PUT    /api/fleet/devices/:id        { name?, hidden?, baseWatts?, efficiency? }
//   DELETE /api/fleet/devices/:id        forget a machine and its history
//   GET    /api/fleet/agent              the ingest token and install command
//   POST   /api/fleet/agent/token        a new ingest token (the old one stops working)
//
// Before the gate (an agent cannot hold the owner's sign-in):
//   POST   /api/fleet/report             a reading, `Authorization: Bearer <fleet token>`
import { createHash, timingSafeEqual } from 'node:crypto'
import { readJson } from '../dev/http.mjs'

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }
const send = (res, status, body) => { res.writeHead(status, JSON_TYPE); res.end(JSON.stringify(body)) }
const REPORT_MAX = 512 * 1024
export const FLEET_REPORT_PATH = '/api/fleet/report'

function sameToken(given, expected) {
  const a = createHash('sha256').update(String(given)).digest()
  const b = createHash('sha256').update(String(expected)).digest()
  return timingSafeEqual(a, b)
}

export function createFleetReportHandler({ store }) {
  return async function fleetReportHandler(req, res) {
    if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true }
    await store.load()
    if (!store.enabled) { send(res, 404, { error: 'fleet is off' }); return true }
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]?.trim() || ''
    if (!bearer || !sameToken(bearer, await store.token())) { send(res, 401, { error: 'unauthorized' }); return true }
    const { body, tooLarge, invalid } = await readJson(req, REPORT_MAX)
    if (tooLarge) { send(res, 413, { error: 'reading over 512 KB' }); return true }
    if (invalid) { send(res, 400, { error: 'body must be JSON' }); return true }
    try { send(res, 200, await store.report(body)) } catch (e) { send(res, e.status || 500, { error: e.message }) }
    return true
  }
}

export function createFleetHttpHandler({ store, publicUrl = () => '' }) {
  return async function fleetHttpHandler(req, res, url) {
    const path = url.pathname
    if (path !== '/api/fleet' && !path.startsWith('/api/fleet/')) return false
    const attempt = async (fn) => {
      try { send(res, 200, await fn()) } catch (e) { send(res, e.status || 500, { error: e.message }) }
      return true
    }
    const body = async () => {
      const { body: b, invalid, tooLarge } = await readJson(req, 16 * 1024)
      if (invalid || tooLarge) throw Object.assign(new Error('bad JSON body'), { status: 400 })
      return b
    }

    if (req.method === 'GET' && path === '/api/fleet') return attempt(() => store.status())
    if (req.method === 'PUT' && path === '/api/fleet/settings') return attempt(async () => store.updateSettings(await body()))
    if (req.method === 'GET' && path === '/api/fleet/agent') {
      return attempt(async () => ({ token: await store.token(), url: publicUrl() || null }))
    }
    if (req.method === 'POST' && path === '/api/fleet/agent/token') return attempt(async () => ({ token: await store.rotateToken(), url: publicUrl() || null }))

    const m = /^\/api\/fleet\/devices\/([^/]+)$/.exec(path)
    if (m) {
      let id
      try { id = decodeURIComponent(m[1]) } catch { id = '' }
      if (req.method === 'GET') {
        const d = await store.device(id)
        return d ? (send(res, 200, d), true) : (send(res, 404, { error: 'no such machine' }), true)
      }
      if (req.method === 'PUT') return attempt(async () => store.updateDevice(id, await body()))
      if (req.method === 'DELETE') return attempt(async () => { await store.forget(id); return { ok: true } })
    }
    send(res, 404, { error: 'not found' })
    return true
  }
}
