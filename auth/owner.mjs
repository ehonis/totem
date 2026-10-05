// Single-owner sign-in for the dashboard.
//
// Totem is a one-person app, so there is exactly one account: the owner. A fresh
// install has none. On first run the bridge prints a one-time setup link with a
// random token to stdout (the way Jupyter and Grafana do) and only a request
// carrying that token can create the owner. After that the dashboard signs in with
// a password, and the browser holds a signed, httpOnly session cookie.
//
// Three ways in, checked in this order by authenticate():
//   1. `Authorization: Bearer <BRIDGE_SECRET>` — machine-to-machine (the iOS
//      Shortcut, the MCP gateway, sibling apps). Unchanged from before sign-in
//      existed, so nothing that already calls the bridge breaks.
//   2. The session cookie, set by /api/auth/setup or /api/auth/login.
//   3. Proxy mode (TOTEM_AUTH=proxy): every request is trusted, because an auth
//      proxy in front (Cloudflare Access, oauth2-proxy, …) already decided. Only
//      safe when nothing can reach the port without passing that proxy.
//
// Stored at data/auth.json, mode 0600: the scrypt hash and salt, the HMAC key the
// session cookies are signed with, and a session version that a password change
// bumps so every older cookie stops working.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

export const SESSION_COOKIE = 'totem_session'
export const MIN_PASSWORD_LENGTH = 8
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 })
// Failed sign-ins tolerated per window: per client, and in total across clients so
// rotating addresses cannot guess forever. The per-client table is bounded.
const MAX_FAILURES = 10
const MAX_GLOBAL_FAILURES = 50
const MAX_TRACKED_CLIENTS = 1000
// scrypt is deliberately slow; more than this many password checks at once are
// refused (429) rather than queued, so a burst cannot pile up CPU or slip past the
// counts while earlier checks are still running.
const MAX_CONCURRENT_VERIFIES = 2
const FAILURE_WINDOW_MS = 15 * 60 * 1000

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/

/**
 * Who is trying to sign in, for throttling. The socket address, unless the request
 * came through a proxy we trust to name the client: with TOTEM_TRUST_PROXY set, or
 * (when it is unset) a proxy on this machine, such as cloudflared or a local nginx.
 * A forwarded header from anyone else is ignored — it is just text they chose.
 */
export function clientKey(req, { trustProxy = process.env.TOTEM_TRUST_PROXY } = {}) {
  const peer = String(req?.socket?.remoteAddress || 'unknown')
  const trusted = trustProxy !== undefined && trustProxy !== ''
    ? /^(1|true|yes|on)$/i.test(String(trustProxy))
    : LOOPBACK.test(peer)
  if (!trusted) return peer
  const forwarded = req.headers?.['cf-connecting-ip'] ||
    String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || peer
}

export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function normalizeAuthMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  return mode === 'proxy' ? 'proxy' : 'password'
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * The value of one cookie, or undefined. Only that cookie is decoded, inside a
 * try: a malformed `%` in some unrelated cookie set by another app on the same
 * domain must not matter.
 */
export function readCookie(header, wanted) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 1 || part.slice(0, i).trim() !== wanted) continue
    try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return undefined }
  }
  return undefined
}

/** Is this request reaching us over https (directly, or via a TLS-terminating proxy)? */
export function requestIsHttps(req) {
  if (req?.socket?.encrypted) return true
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  return proto === 'https'
}

async function hashPassword(password, salt = randomBytes(16)) {
  const key = await scrypt(String(password).normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return { salt: salt.toString('base64'), hash: key.toString('base64'), params: { ...SCRYPT } }
}

async function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false
  const params = { ...SCRYPT, ...(record.params || {}) }
  const key = await scrypt(String(password).normalize('NFKC'), Buffer.from(record.salt, 'base64'), params.keylen, { N: params.N, r: params.r, p: params.p })
  return safeEqual(key.toString('base64'), record.hash)
}

/**
 * @param {object}   options
 * @param {string}   options.file          Where the owner record lives (data/auth.json).
 * @param {string}  [options.mode]         'password' (default) or 'proxy'.
 * @param {string}  [options.bridgeSecret] BRIDGE_SECRET; empty disables bearer auth.
 * @param {Function}[options.now]          Clock, for tests.
 * @param {Function}[options.log]
 * @param {Function}[options.beforeWrite] Awaited before each write; tests use it to interleave requests.
 * @param {Function}[options.afterVerify] Awaited after each password check; same purpose.
 */
export function createOwnerAuth({ file, mode = 'password', bridgeSecret = '', now = () => Date.now(), log = () => {}, beforeWrite = null, afterVerify = null }) {
  const authMode = normalizeAuthMode(mode)
  let record = null         // the parsed auth.json, or null before setup
  let loaded = false
  let setupToken = null     // only while no owner exists; never persisted
  let failures = []         // timestamps of recent failed sign-ins, all clients
  const clientFailures = new Map() // clientKey -> timestamps

  async function load() {
    if (loaded) return record
    try {
      record = JSON.parse(await readFile(file, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') log(`auth: could not read ${file}: ${e.message}`)
      record = null
    }
    loaded = true
    return record
  }

  async function save(next) {
    await mkdir(dirname(file), { recursive: true })
    // Test seam: lets a test hold one write open while another request runs.
    if (beforeWrite) await beforeWrite(next)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
    await chmod(file, 0o600).catch(() => {})
    record = next
  }

  // Every change to auth.json goes through this chain, one at a time, and is
  // applied to the record as it is on disk at that moment — never to a copy taken
  // before an await. Otherwise a sign-out that read the record while a password
  // change was hashing could write the old password hash back.
  let mutations = Promise.resolve()
  function mutate(change) {
    const run = mutations.then(async () => {
      loaded = false
      const current = await load()
      const next = await change(current)
      if (next && next !== current) await save(next)
      return next
    })
    mutations = run.then(() => undefined, () => undefined)
    return run
  }

  const hasOwner = () => Boolean(record?.owner?.hash)

  /**
   * Load state and, if there is no owner yet, mint the one-time setup token.
   * Returns the token so the caller can print the link; null once set up, or in
   * proxy mode (where there is nothing to set up).
   */
  async function init() {
    await load()
    if (authMode === 'password' && !hasOwner()) {
      setupToken = setupToken || randomBytes(24).toString('base64url')
      return setupToken
    }
    return null
  }

  function bearerOk(req) {
    if (!bridgeSecret) return false
    return safeEqual(req?.headers?.authorization || '', `Bearer ${bridgeSecret}`)
  }

  function sign(payload) {
    return createHmac('sha256', Buffer.from(record.sessionSecret, 'base64')).update(payload).digest('base64url')
  }

  function sessionOk(req) {
    if (!hasOwner() || !record.sessionSecret) return false
    const raw = readCookie(req?.headers?.cookie, SESSION_COOKIE)
    if (!raw) return false
    const dot = raw.lastIndexOf('.')
    if (dot < 1) return false
    const payload = raw.slice(0, dot)
    if (!safeEqual(raw.slice(dot + 1), sign(payload))) return false
    let claims
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return false }
    return claims?.v === record.sessionVersion && Number(claims.exp) > now()
  }

  /** @returns {{ ok: boolean, via: 'bearer'|'session'|'proxy'|null }} */
  function authenticate(req) {
    if (bearerOk(req)) return { ok: true, via: 'bearer' }
    if (authMode === 'proxy') return { ok: true, via: 'proxy' }
    if (sessionOk(req)) return { ok: true, via: 'session' }
    return { ok: false, via: null }
  }

  function sessionCookie(req) {
    const iat = now()
    const payload = Buffer.from(JSON.stringify({ v: record.sessionVersion, iat, exp: iat + SESSION_TTL_MS })).toString('base64url')
    const parts = [
      `${SESSION_COOKIE}=${payload}.${sign(payload)}`,
      'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ]
    if (requestIsHttps(req)) parts.push('Secure')
    return parts.join('; ')
  }

  function clearCookie(req) {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
    if (requestIsHttps(req)) parts.push('Secure')
    return parts.join('; ')
  }

  function checkPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError('WEAK_PASSWORD', `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    }
    if (password.length > 1024) throw new AuthError('WEAK_PASSWORD', 'That password is too long.')
  }

  function throttle(req) {
    const cutoff = now() - FAILURE_WINDOW_MS
    failures = failures.filter((m) => m.at > cutoff)
    const key = clientKey(req)
    const mine = (clientFailures.get(key) || []).filter((m) => m.at > cutoff)
    if (mine.length) clientFailures.set(key, mine)
    else clientFailures.delete(key)
    if (mine.length >= MAX_FAILURES || failures.length >= MAX_GLOBAL_FAILURES) {
      throw new AuthError('RATE_LIMITED', 'Too many failed attempts. Wait a few minutes and try again.', 429)
    }
  }

  function recordFailure(req) {
    const at = now()
    const mark = { at } // an object, so exactly this entry can be taken back out
    failures.push(mark)
    const key = clientKey(req)
    const previous = clientFailures.get(key) || []
    clientFailures.delete(key) // re-insert so the map stays in recency order
    clientFailures.set(key, [...previous, mark])
    while (clientFailures.size > MAX_TRACKED_CLIENTS) clientFailures.delete(clientFailures.keys().next().value)
    return { key, mark }
  }

  function releaseFailure({ key, mark }) {
    failures = failures.filter((m) => m !== mark)
    const mine = (clientFailures.get(key) || []).filter((m) => m !== mark)
    if (mine.length) clientFailures.set(key, mine)
    else clientFailures.delete(key)
  }

  let verifying = 0

  /**
   * One password check, counted as a failure BEFORE it runs. Concurrent attempts
   * each see the earlier reservations, so firing many at once cannot get more
   * guesses than the throttle allows. A correct password releases its reservation.
   */
  /**
   * Returns the record it checked against ({ hash, version }) when the password
   * matched, or null. Callers must confirm that record is still current before
   * acting: a password change or sign-out can land while scrypt runs.
   */
  async function checkedPassword(req, password) {
    if (verifying >= MAX_CONCURRENT_VERIFIES) {
      throw new AuthError('RATE_LIMITED', 'Too many sign-in attempts at once. Try again in a moment.', 429)
    }
    throttle(req)
    const reservation = recordFailure(req)
    const owner = record.owner
    const seen = { hash: owner.hash, version: record.sessionVersion }
    verifying++
    let ok = false
    try {
      ok = await verifyPassword(password, owner)
      if (afterVerify) await afterVerify()
    } finally {
      verifying--
    }
    if (!ok) return null
    releaseFailure(reservation)
    return seen
  }

  const unchangedSince = (seen, current) =>
    Boolean(current?.owner?.hash) && current.owner.hash === seen.hash && current.sessionVersion === seen.version

  const changedWhileChecking = () =>
    new AuthError('BAD_PASSWORD', 'The password or sessions changed while signing in. Sign in again.', 401)

  function setupTokenValid(token) {
    return Boolean(setupToken && token && safeEqual(token, setupToken))
  }

  /** Create the owner. Needs the one-time token. Returns a Set-Cookie value. */
  async function setup(req, { token, password } = {}) {
    await load()
    if (authMode === 'proxy') throw new AuthError('PROXY_MODE', 'Sign-in is handled by your auth proxy (TOTEM_AUTH=proxy).', 409)
    if (hasOwner()) throw new AuthError('ALREADY_SET_UP', 'The owner account already exists. Sign in instead.', 409)
    throttle(req)
    if (!setupTokenValid(token)) {
      recordFailure(req)
      throw new AuthError('BAD_SETUP_TOKEN', 'This setup link is not valid. Use the link printed in the server log.', 403)
    }
    checkPassword(password)
    const at = new Date(now()).toISOString()
    const hashed = await hashPassword(password)
    await mutate((current) => {
      if (current?.owner?.hash) throw new AuthError('ALREADY_SET_UP', 'The owner account already exists. Sign in instead.', 409)
      return {
        version: 1,
        owner: { ...hashed, createdAt: at, passwordChangedAt: at },
        sessionSecret: randomBytes(32).toString('base64'),
        sessionVersion: 1,
      }
    })
    setupToken = null
    log('auth: owner account created')
    return sessionCookie(req)
  }

  async function login(req, { password } = {}) {
    await load()
    if (authMode === 'proxy') throw new AuthError('PROXY_MODE', 'Sign-in is handled by your auth proxy (TOTEM_AUTH=proxy).', 409)
    if (!hasOwner()) throw new AuthError('SETUP_REQUIRED', 'No owner account yet. Open the setup link printed in the server log.', 409)
    const seen = await checkedPassword(req, password)
    if (!seen) throw new AuthError('BAD_PASSWORD', 'Wrong password.', 401)
    // Through the queue, so any change already in flight lands first; then the
    // cookie is issued only against the very record the password was checked with.
    await mutate((current) => {
      if (!unchangedSince(seen, current)) throw changedWhileChecking()
      return current
    })
    clientFailures.delete(clientKey(req))
    return sessionCookie(req)
  }

  /** Change the password; every other session is signed out. Returns a fresh cookie. */
  async function changePassword(req, { current, next } = {}) {
    await load()
    if (!hasOwner()) throw new AuthError('SETUP_REQUIRED', 'No owner account yet.', 409)
    checkPassword(next)
    const seen = await checkedPassword(req, current)
    if (!seen) throw new AuthError('BAD_PASSWORD', 'Current password is wrong.', 401)
    const hashed = await hashPassword(next)
    await mutate((latest) => {
      // The current password was checked against a record that is no longer the
      // one on disk: someone else changed the password (or signed out) meanwhile.
      if (!unchangedSince(seen, latest)) throw changedWhileChecking()
      return {
        ...latest,
        owner: { ...latest.owner, ...hashed, passwordChangedAt: new Date(now()).toISOString() },
        sessionVersion: (Number(latest.sessionVersion) || 0) + 1,
      }
    })
    log('auth: owner password changed; other sessions signed out')
    return sessionCookie(req)
  }

  /**
   * Sign out. A signed-in session ends every session (the session version moves),
   * so a copied cookie stops working too; there is one owner, so "sign out
   * everywhere" is the only honest meaning. A request that was never signed in
   * changes nothing.
   */
  async function logout(req) {
    await load()
    if (!hasOwner() || !sessionOk(req)) return false
    await mutate((current) => ({ ...current, sessionVersion: (Number(current.sessionVersion) || 0) + 1 }))
    log('auth: signed out; existing sessions ended')
    return true
  }

  function status(req) {
    const result = authenticate(req)
    return {
      mode: authMode,
      setupRequired: authMode === 'password' && !hasOwner(),
      authenticated: result.ok,
      via: result.via,
    }
  }

  return {
    mode: authMode,
    init,
    authenticate,
    bearerOk,
    status,
    setup,
    setupTokenValid,
    login,
    changePassword,
    logout,
    clearCookie,
    hasOwner,
  }
}
