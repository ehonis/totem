// cliproxy/http.mjs — the `/api/cliproxy` adapter, behind the /api/* auth gate.
//
//   GET  /api/cliproxy                       logins, quota, pools, pending sign-ins
//   GET  /api/cliproxy/status                { configured } (cheap: decides the rail tab)
//   GET  /api/cliproxy/accounts/models?name=  models one login can use
//   GET  /api/cliproxy/login?state=           a sign-in's progress
//   GET  /api/cliproxy/grants?name=           Claude reset grants
//   GET  /api/cliproxy/credits?name=          Codex reset credits
//
// Changes, all POST with a JSON body naming the login (`name`), never in the path.
// Every one is in APPROVAL_ROUTES (auth/approval-routes.mjs), so the bridge
// bearer alone (any agent) cannot make them:
//   accounts/status { name, disabled }      accounts/fields { name, note?, priority?, weight?, websockets? }
//   accounts/refresh { name } | { all }     accounts/cooldown { name }      accounts/delete { name }
//   login { provider }    login/callback { state, url }    login/cancel { state }
//   grants/claim { name, grantId? }  (high)    credits/consume { name }  (high)
import { readJson } from '../dev/http.mjs'

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const send = (res, status, body) => { res.writeHead(status, JSON_TYPE); res.end(JSON.stringify(body)) }

export function createCliproxyHttpHandler({ manager, configured }) {
  const POSTS = {
    '/api/cliproxy/accounts/status': manager.setDisabled,
    '/api/cliproxy/accounts/fields': manager.patchFields,
    '/api/cliproxy/accounts/refresh': manager.refreshLogin,
    '/api/cliproxy/accounts/cooldown': manager.resetCooldown,
    '/api/cliproxy/accounts/delete': manager.remove,
    '/api/cliproxy/login': manager.startLogin,
    '/api/cliproxy/login/callback': manager.submitCallback,
    '/api/cliproxy/login/cancel': manager.cancelLogin,
    '/api/cliproxy/grants/claim': manager.claimGrant,
    '/api/cliproxy/credits/consume': manager.consumeCredit,
  }
  const GETS = {
    '/api/cliproxy': (q) => manager.overview({ retry: q.get('retry') === '1' }),
    '/api/cliproxy/status': () => ({ configured: configured() }),
    '/api/cliproxy/history': () => manager.history(),
    '/api/cliproxy/accounts/models': (q) => manager.models({ name: q.get('name') }),
    '/api/cliproxy/login': (q) => manager.loginStatus({ state: q.get('state') }),
    '/api/cliproxy/grants': (q) => manager.grants({ name: q.get('name') }),
    '/api/cliproxy/credits': (q) => manager.credits({ name: q.get('name') }),
  }

  return async function cliproxyHttpHandler(req, res, url, path) {
    if (path !== '/api/cliproxy' && !path.startsWith('/api/cliproxy/')) return false
    const attempt = async (fn) => {
      try {
        send(res, 200, await fn())
      } catch (e) {
        const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500
        send(res, status, { error: e?.message || 'failed', ...(e?.code ? { code: e.code } : {}) })
      }
      return true
    }
    if (req.method === 'GET' && GETS[path]) return attempt(() => GETS[path](url.searchParams))
    if (req.method === 'POST' && POSTS[path]) {
      return attempt(async () => {
        const { body, invalid, tooLarge } = await readJson(req, 16 * 1024)
        if (invalid || tooLarge || !body || typeof body !== 'object' || Array.isArray(body)) {
          throw Object.assign(new Error('body must be a JSON object'), { status: 400 })
        }
        return POSTS[path](body)
      })
    }
    send(res, 404, { error: 'not found' })
    return true
  }
}
