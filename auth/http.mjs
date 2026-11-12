// /api/auth/* — the routes that have to work before anyone is signed in.
//
// Matched ahead of the dashboard's auth gate in bridge.mjs. Every route either
// needs no session by nature (status, setup, login, logout) or checks one itself
// (password, approval-code).

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
 * @param {{ approvalCode?: ReturnType<import('./approval-code.mjs').createApprovalCode> }} [options]
 * @returns {(req, res, url: URL) => Promise<boolean>} true when it handled the request
 */
export function createAuthHttpHandler(auth, { approvalCode = null } = {}) {
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
      if (approvalCode && path === '/api/auth/approval-code') {
        if (!auth.authenticate(req).ok) {
          json(res, 401, { error: 'unauthorized' })
          return true
        }
        if (req.method === 'GET') {
          json(res, 200, { ...(await approvalCode.status()), mode: auth.mode })
          return true
        }
        // Set or rotate. The password is the proof here, so the iPhone app (which
        // holds only the bearer) can set one too, and an agent holding the bearer
        // cannot. The new code is in this response and nowhere else.
        if (req.method === 'POST') {
          if (auth.mode === 'proxy') {
            throw new AuthError('PROXY_MODE', 'There is no Totem password behind an auth proxy. Set the code on the server with `npm run approval-code`.', 409)
          }
          const { password } = await readBody(req)
          await auth.confirmPassword(req, String(password || ''))
          json(res, 200, { ok: true, ...(await approvalCode.set()) })
          return true
        }
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
