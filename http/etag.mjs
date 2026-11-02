// Weak ETags for the dashboard's read routes, so a client that already holds a
// response is answered 304 with no body (#159). The iPhone app keeps these
// responses on disk to open instantly and offline; a browser revalidates them
// from its own HTTP cache with no code of its own.
//
// It sits in front of every handler at the /api/ gate rather than in each
// module's send(): it holds back writeHead, and when the handler ends with a
// whole JSON body it hashes that body and answers from the result. Anything
// streamed with write() passes straight through.
import { createHash } from 'node:crypto'

// The read routes a client may keep. Every one answers a single JSON body, and
// none streams, changes on every poll (usage meters, /api/jobs' generatedAt),
// reports a run, or carries a secret, a token or an account's settings. A
// route joins this list only if all of that stays true: the phone writes these
// bodies to disk. The inbox (staged emails and messages) and the journal
// (transcripts) stay off it for that reason, as does anything a search typed.
const ETAG_PATHS = new Set([
  '/api/todos', '/api/todos/board', '/api/todos/projects', '/api/todos/completed',
  '/api/todos/venture-tags', '/api/todos/preferences',
  '/api/goals', '/api/goals/options', '/api/goals/review',
  '/api/lists',
  '/api/habits',
  '/api/calendar',
  '/api/inbox/count',
  '/api/notifications',
  '/api/productivity',
  '/api/threads',
])
// One record by id: /api/todos/<id>, /api/goals/<id>, /api/lists/<id>. Not
// /api/goals/search, whose query would land on disk.
const ETAG_RECORD = /^\/api\/(todos|goals|lists)\/(?!search$)[^/]+$/

// Keep it, but ask the bridge before every use; never in a shared cache.
const CACHE_CONTROL = 'private, no-cache'

export function etagEligible(method, path) {
  return method === 'GET' && (ETAG_PATHS.has(path) || ETAG_RECORD.test(path))
}

export function weakEtag(body) {
  return `W/"${createHash('sha1').update(body).digest('base64url')}"`
}

// If-None-Match uses the weak comparison (RFC 9110 §13.1.2): W/"x" matches "x".
export function etagMatches(header, etag) {
  if (!header) return false
  if (header.trim() === '*') return true
  const opaque = etag.replace(/^W\//, '')
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === opaque)
}

function headerIn(headers, name) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key === undefined ? undefined : headers[key]
}

/**
 * Tag the response to `req` if its route is on the list. Call before the
 * handler runs; it changes nothing for any other route.
 */
export function etagResponse(req, res, path) {
  if (!etagEligible(req.method, path)) return
  const { writeHead, write, end } = res
  let head = null
  const release = () => { res.writeHead = writeHead; res.write = write; res.end = end }

  res.writeHead = function (...args) { head = args; return this }
  res.write = function (...args) {
    release()
    if (head) writeHead.apply(this, head)
    return write.apply(this, args)
  }
  res.end = function (chunk, ...rest) {
    release()
    const status = head ? head[0] : this.statusCode
    const headers = head ? (typeof head[1] === 'string' ? head[2] : head[1]) : undefined
    const type = String(headerIn(headers, 'content-type') ?? this.getHeader('content-type') ?? '')
    const cacheControl = String(headerIn(headers, 'cache-control') ?? this.getHeader('cache-control') ?? '')
    const taggable = status === 200 && /^application\/json\b/i.test(type) && !/no-store/i.test(cacheControl)
      && (typeof chunk === 'string' || Buffer.isBuffer(chunk))
    if (!taggable) {
      if (head) writeHead.apply(this, head)
      return end.call(this, chunk, ...rest)
    }
    const etag = weakEtag(chunk)
    if (etagMatches(req.headers['if-none-match'], etag)) {
      writeHead.call(this, 304, { etag, 'cache-control': CACHE_CONTROL })
      return end.call(this)
    }
    writeHead.call(this, status, { ...headers, etag, 'cache-control': CACHE_CONTROL })
    return end.call(this, chunk, ...rest)
  }
}
