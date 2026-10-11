// dev/ingest.mjs — `POST /api/alerts/:source`: alerts from outside become owner
// notifications.
//
// Mounted before the /api/* auth gate, because a sender (a PostHog webhook, a
// cron on another box) cannot hold the owner's sign-in. It authorises itself
// with ALERT_INGEST_TOKEN, as `Authorization: Bearer <token>` or `X-Alert-Token`.
// No token configured means the route does not exist (404). The token is never
// logged.
import { createHash, timingSafeEqual } from 'node:crypto'
import { readJson } from './http.mjs'

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }
const MAX_BODY = 64 * 1024
const SOURCE_RE = /^[a-z0-9-]{1,32}$/
const PATH_RE = /^\/api\/alerts\/[^/]+$/

const send = (res, status, body) => { res.writeHead(status, JSON_TYPE); res.end(JSON.stringify(body)) }
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** Matched in bridge.mjs ahead of the auth gate, like PUSH_PUBLIC_PATHS. */
export const isAlertIngestPath = (path) => PATH_RE.test(path)

function sameToken(given, expected) {
  const a = createHash('sha256').update(String(given)).digest()
  const b = createHash('sha256').update(String(expected)).digest()
  return timingSafeEqual(a, b)
}

function presentedToken(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))
  return bearer ? bearer[1].trim() : String(req.headers['x-alert-token'] || '')
}

const summary = (value, max = 300) => {
  const text = JSON.stringify(value) || ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// PostHog's webhook destination sends `{ event: { event, properties, url }, person,
// project, source }`; its older REST hooks put the event under `data`, and its
// Slack-style action webhooks send only `text`. Anything else returns null.
export function mapPosthog(body) {
  const ev = isObj(body.event) ? body.event : isObj(body.data) ? body.data : null
  if (ev && str(ev.event)) {
    const props = isObj(ev.properties) ? ev.properties : {}
    const project = str(body.project?.name)
    let title = ev.event
    let text
    let key = ev.event
    if (ev.event === '$exception') {
      const first = Array.isArray(props.$exception_list) && isObj(props.$exception_list[0]) ? props.$exception_list[0] : {}
      const type = str(props.$exception_type) || str(first.type) || 'Error'
      text = str(props.$exception_message) || str(first.value)
      title = `Exception: ${type}`
      key = str(props.$exception_fingerprint) || str(props.$exception_issue_id) || `${type}:${text}`
    } else {
      const shown = Object.entries(props).filter(([k]) => !k.startsWith('$')).slice(0, 8)
      text = shown.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ').slice(0, 300)
    }
    return {
      title: project ? `${project}: ${title}` : title,
      body: text || '',
      url: str(ev.url) || str(body.source?.url) || str(body.project?.url) || null,
      key,
    }
  }
  if (str(body.text)) {
    const [first, ...rest] = str(body.text).split('\n')
    return { title: first, body: rest.join(' ').trim(), url: null, key: first }
  }
  return null
}

/** The sender's JSON as `{ title, body, url, key }`, whatever shape it came in. */
export function mapAlert(source, body) {
  if (str(body.title)) {
    return { title: str(body.title), body: str(body.body) || str(body.message), url: str(body.url) || null, key: str(body.key) || null }
  }
  const mapped = mapPosthog(body)
  if (mapped) return mapped
  const text = summary(body)
  return { title: `Alert from ${source}`, body: text, url: null, key: text }
}

export function createAlertIngestHandler({ alerts, token = () => process.env.ALERT_INGEST_TOKEN }) {
  if (!alerts) throw new TypeError('createAlertIngestHandler requires alerts')
  return async function alertIngestHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost')
    if (!isAlertIngestPath(url.pathname)) return false
    const expected = token()
    if (!expected) { send(res, 404, { error: 'not found' }); return true }
    if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true }
    if (!sameToken(presentedToken(req), expected)) { send(res, 401, { error: 'unauthorized' }); return true }

    let source
    try { source = decodeURIComponent(url.pathname.slice('/api/alerts/'.length)) } catch { source = '' }
    if (!SOURCE_RE.test(source)) { send(res, 400, { error: 'source must be 1-32 of a-z, 0-9 and -' }); return true }

    const { body, tooLarge, invalid } = await readJson(req, MAX_BODY)
    if (tooLarge) { send(res, 413, { error: 'body over 64 KB' }); return true }
    if (invalid || !isObj(body)) { send(res, 400, { error: 'body must be a JSON object' }); return true }

    const { alert, notified } = await alerts.record({ source, ...mapAlert(source, body) })
    send(res, 200, { ok: true, id: alert.id, notified })
    return true
  }
}
