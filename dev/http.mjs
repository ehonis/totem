// dev/http.mjs — the `/api/dev` adapter, behind the normal /api/* auth gate.
//
//   GET /api/dev[?refresh=1]                      repo cards, health, recent alerts
//   PUT /api/dev/repos                             { repo: 'owner/name', watch: bool }
//   PUT /api/dev/repos/:owner/:repo/ai-review     { enabled: bool }
//   POST /api/dev/repos/:owner/:repo/pulls/:n/review   one-off review dispatch
import { ghErrorMessage } from './github.mjs'

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }
const MAX_BODY = 16 * 1024

const send = (res, status, body) => { res.writeHead(status, JSON_TYPE); res.end(JSON.stringify(body)) }

export async function readJson(req, maxBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) return { tooLarge: true }
    chunks.push(chunk)
  }
  if (!bytes) return { body: {} }
  try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) } } catch { return { invalid: true } }
}

export function createDevHttpHandler({ service }) {
  if (!service) throw new TypeError('createDevHttpHandler requires service')
  return async function devHttpHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (path !== '/api/dev' && !path.startsWith('/api/dev/')) return false

    if (req.method === 'GET' && path === '/api/dev') {
      send(res, 200, await service.status({ refresh: url.searchParams.has('refresh') }))
      return true
    }

    // A domain refusal keeps its status; a gh failure is a 502 in words.
    const attempt = async (fn) => {
      try { send(res, 200, await fn()) } catch (e) { send(res, e.status || 502, { error: e.status ? e.message : ghErrorMessage(e) }) }
      return true
    }
    const body = async (check, usage) => {
      const { body: parsed, tooLarge, invalid } = await readJson(req, MAX_BODY)
      if (tooLarge) { send(res, 413, { error: 'body too large' }); return null }
      if (invalid || !check(parsed)) { send(res, 400, { error: usage }); return null }
      return parsed
    }
    const repoOf = (m) => {
      try { return `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` } catch { send(res, 400, { error: 'malformed repo' }); return null }
    }

    if (req.method === 'PUT' && path === '/api/dev/repos') {
      const b = await body((x) => typeof x?.repo === 'string' && typeof x?.watch === 'boolean', 'body must be { "repo": "owner/name", "watch": true | false }')
      return b ? attempt(() => service.setWatch(b.repo, b.watch)) : true
    }

    const toggle = /^\/api\/dev\/repos\/([^/]+)\/([^/]+)\/ai-review$/.exec(path)
    if (toggle && req.method === 'PUT') {
      const b = await body((x) => typeof x?.enabled === 'boolean', 'body must be { "enabled": true | false }')
      const repo = b && repoOf(toggle)
      return repo ? attempt(() => service.setAiReview(repo, b.enabled)) : true
    }

    const review = /^\/api\/dev\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/review$/.exec(path)
    if (review && req.method === 'POST') {
      const repo = repoOf(review)
      return repo ? attempt(() => service.dispatchReview(repo, Number(review[3]))) : true
    }
    return false
  }
}
