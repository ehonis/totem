// /api/auth/* — the routes that have to work before anyone is signed in.
//
// Matched ahead of the dashboard's auth gate in bridge.mjs. Every route either
// needs no session by nature (status, setup, login, logout) or checks one itself
// (password).

import { AuthError } from './owner.mjs'

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > limit) req.destroy() })
    req.on('end', () => {
      let parsed
      try { parsed = body ? JSON.parse(body) : {} } catch { return reject(new AuthError('BAD_JSON', 'bad json')) }
      // `null`, `[]`, `"x"` and `3` are valid JSON but not a request body; destructuring
      // them used to throw outside the handler and take the process down.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new AuthError('BAD_BODY', 'The request body must be a JSON object.'))
      }
      resolve(parsed)
    })
    req.on('error', reject)
  })
}

function json(res, code, obj, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(obj))
}

/**
 * @param {ReturnType<import('./owner.mjs').createOwnerAuth>} auth
 * @returns {(req, res, url: URL) => Promise<boolean>} true when it handled the request
 */
export function createAuthHttpHandler(auth) {
  return async function handleAuth(req, res, url) {
    const path = url.pathname
    if (!path.startsWith('/api/auth/')) return false
    try {
      if (req.method === 'GET' && path === '/api/auth/status') {
        json(res, 200, auth.status(req))
        return true
      }
      // Lets the setup screen say "this link is stale" before asking for a password.
      if (req.method === 'POST' && path === '/api/auth/setup/check') {
        const { token } = await readBody(req)
        json(res, 200, { valid: auth.setupTokenValid(String(token || '')), setupRequired: auth.status(req).setupRequired })
        return true
      }
      if (req.method === 'POST' && path === '/api/auth/setup') {
        const { token, password } = await readBody(req)
        const cookie = await auth.setup(req, { token: String(token || ''), password })
        json(res, 200, { ok: true }, { 'set-cookie': cookie })
        return true
      }
      if (req.method === 'POST' && path === '/api/auth/login') {
        const { password } = await readBody(req)
        const cookie = await auth.login(req, { password })
        json(res, 200, { ok: true }, { 'set-cookie': cookie })
        return true
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        await auth.logout(req)
        json(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie(req) })
        return true
      }
      if (req.method === 'POST' && path === '/api/auth/password') {
        if (!auth.authenticate(req).ok) {
          json(res, 401, { error: 'unauthorized' })
          return true
        }
        const { current, next } = await readBody(req)
        const cookie = await auth.changePassword(req, { current, next })
        json(res, 200, { ok: true }, { 'set-cookie': cookie })
        return true
      }
      json(res, 404, { error: 'not found' })
      return true
    } catch (e) {
      if (e instanceof AuthError) {
        json(res, e.status, { error: { code: e.code, message: e.message } })
        return true
      }
      throw e
    }
  }
}
