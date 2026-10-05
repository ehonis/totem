// Run with: node --test auth/
//
// The sign-in boundary. A failure here can mean a stranger who finds the port can
// create the owner account, a stolen cookie outlives a password change, or the
// bearer secret every machine caller relies on stops working.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnerAuth, readCookie, clientKey, SESSION_COOKIE, normalizeAuthMode } from './owner.mjs'
import { createAuthHttpHandler } from './http.mjs'

const SECRET = 'machine-secret-for-tests'
const PASSWORD = 'correct horse battery'

async function fresh(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-auth-'))
  const file = join(dir, 'auth.json')
  const auth = createOwnerAuth({ file, bridgeSecret: SECRET, ...opts })
  const token = await auth.init()
  return { auth, file, token, dir }
}

const req = (headers = {}, remoteAddress = '203.0.113.9') => ({ headers, socket: { remoteAddress } })
const cookieFrom = (setCookie) => setCookie.split(';')[0]

test('a fresh install has no owner and mints a one-time setup token', async () => {
  const { auth, token } = await fresh()
  assert.match(token, /^[A-Za-z0-9_-]{32}$/)
  assert.deepEqual(auth.status(req()), { mode: 'password', setupRequired: true, authenticated: false, via: null })
})

test('setup refuses a missing or wrong token', async () => {
  const { auth } = await fresh()
  await assert.rejects(() => auth.setup(req(), { token: '', password: PASSWORD }), { code: 'BAD_SETUP_TOKEN' })
  await assert.rejects(() => auth.setup(req(), { token: 'guess', password: PASSWORD }), { code: 'BAD_SETUP_TOKEN' })
  assert.equal(auth.hasOwner(), false)
})

test('setup with the token creates the owner, hashed, in a 0600 file', async () => {
  const { auth, token, file } = await fresh()
  const cookie = await auth.setup(req(), { token, password: PASSWORD })
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`))
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.doesNotMatch(cookie, /Secure/, 'plain http must not get a Secure cookie it cannot send back')

  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.ok(saved.owner.hash && saved.owner.salt)
  assert.ok(!JSON.stringify(saved).includes(PASSWORD), 'the password itself is never stored')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('the setup token is single-use', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  await assert.rejects(() => auth.setup(req(), { token, password: 'another password' }), { code: 'ALREADY_SET_UP' })
  assert.equal(auth.setupTokenValid(token), false)
})

test('setup rejects a short password', async () => {
  const { auth, token } = await fresh()
  await assert.rejects(() => auth.setup(req(), { token, password: 'short' }), { code: 'WEAK_PASSWORD' })
})

test('login checks the password and the cookie it returns authenticates', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  await assert.rejects(() => auth.login(req(), { password: 'wrong password' }), { code: 'BAD_PASSWORD' })
  const cookie = cookieFrom(await auth.login(req(), { password: PASSWORD }))
  assert.deepEqual(auth.authenticate(req({ cookie })), { ok: true, via: 'session' })
})

test('a tampered or foreign cookie does not authenticate', async () => {
  const { auth, token } = await fresh()
  const cookie = cookieFrom(await auth.setup(req(), { token, password: PASSWORD }))
  const value = readCookie(cookie, SESSION_COOKIE)
  const [payload] = value.split('.')
  const forged = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: Date.now() * 2 })).toString('base64url')
  assert.equal(auth.authenticate(req({ cookie: `${SESSION_COOKIE}=${forged}.${value.split('.')[1]}` })).ok, false)
  assert.equal(auth.authenticate(req({ cookie: `${SESSION_COOKIE}=${payload}.AAAA` })).ok, false)

  const other = await fresh()
  await other.auth.setup(req(), { token: other.token, password: PASSWORD })
  assert.equal(other.auth.authenticate(req({ cookie })).ok, false, 'a cookie from another install is not valid here')
})

test('a cookie expires', async () => {
  let clock = Date.now()
  const { auth, token } = await fresh({ now: () => clock })
  const cookie = cookieFrom(await auth.setup(req(), { token, password: PASSWORD }))
  clock += 31 * 24 * 60 * 60 * 1000
  assert.equal(auth.authenticate(req({ cookie })).ok, false)
})

test('changing the password signs out every older session', async () => {
  const { auth, token } = await fresh()
  const old = cookieFrom(await auth.setup(req(), { token, password: PASSWORD }))
  await assert.rejects(() => auth.changePassword(req({ cookie: old }), { current: 'nope nope', next: 'new password 1' }), { code: 'BAD_PASSWORD' })
  const fresher = cookieFrom(await auth.changePassword(req({ cookie: old }), { current: PASSWORD, next: 'new password 1' }))
  assert.equal(auth.authenticate(req({ cookie: old })).ok, false)
  assert.equal(auth.authenticate(req({ cookie: fresher })).ok, true)
  await assert.rejects(() => auth.login(req(), { password: PASSWORD }), { code: 'BAD_PASSWORD' })
  assert.ok(await auth.login(req(), { password: 'new password 1' }))
})

test('the owner survives a restart', async () => {
  const { auth, token, file } = await fresh()
  const cookie = cookieFrom(await auth.setup(req(), { token, password: PASSWORD }))
  const again = createOwnerAuth({ file, bridgeSecret: SECRET })
  assert.equal(await again.init(), null, 'no new setup token once an owner exists')
  assert.equal(again.authenticate(req({ cookie })).ok, true)
})

test('the bearer secret still works, before and after setup', async () => {
  const { auth, token } = await fresh()
  assert.deepEqual(auth.authenticate(req({ authorization: `Bearer ${SECRET}` })), { ok: true, via: 'bearer' })
  await auth.setup(req(), { token, password: PASSWORD })
  assert.deepEqual(auth.authenticate(req({ authorization: `Bearer ${SECRET}` })), { ok: true, via: 'bearer' })
  assert.equal(auth.authenticate(req({ authorization: 'Bearer wrong' })).ok, false)
})

test('an empty BRIDGE_SECRET never matches an empty bearer', async () => {
  const { auth } = await fresh({ bridgeSecret: '' })
  assert.equal(auth.authenticate(req({ authorization: 'Bearer ' })).ok, false)
})

test('proxy mode trusts every request and has nothing to set up', async () => {
  const { auth, token } = await fresh({ mode: 'proxy' })
  assert.equal(token, null)
  assert.deepEqual(auth.status(req()), { mode: 'proxy', setupRequired: false, authenticated: true, via: 'proxy' })
  await assert.rejects(() => auth.login(req(), { password: PASSWORD }), { code: 'PROXY_MODE' })
  assert.equal(normalizeAuthMode('PROXY'), 'proxy')
  assert.equal(normalizeAuthMode('anything else'), 'password')
})

test('repeated failures are throttled', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  for (let i = 0; i < 10; i++) await auth.login(req(), { password: 'wrong password' }).catch(() => {})
  await assert.rejects(() => auth.login(req(), { password: PASSWORD }), { code: 'RATE_LIMITED' })
})

test('the cookie is Secure behind an https proxy', async () => {
  const { auth, token } = await fresh()
  const cookie = await auth.setup(req({ 'x-forwarded-proto': 'https' }), { token, password: PASSWORD })
  assert.match(cookie, /; Secure/)
})

// ---- over HTTP --------------------------------------------------------------

async function serve(auth) {
  const handle = createAuthHttpHandler(auth)
  const server = http.createServer(async (rq, rs) => {
    if (await handle(rq, rs, new URL(rq.url, 'http://x'))) return
    rs.writeHead(auth.authenticate(rq).ok ? 200 : 401).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((r) => server.close(r)) }
}

test('HTTP: setup link, then the cookie opens the API, logout closes it', async () => {
  const { auth, token } = await fresh()
  const { base, close } = await serve(auth)
  try {
    const status = await (await fetch(`${base}/api/auth/status`)).json()
    assert.equal(status.setupRequired, true)
    assert.equal((await fetch(`${base}/api/anything`)).status, 401)

    const bad = await fetch(`${base}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ token: 'x', password: PASSWORD }) })
    assert.equal(bad.status, 403)

    const ok = await fetch(`${base}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ token, password: PASSWORD }) })
    assert.equal(ok.status, 200)
    const cookie = cookieFrom(ok.headers.get('set-cookie'))
    assert.equal((await fetch(`${base}/api/anything`, { headers: { cookie } })).status, 200)

    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } })
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/)

    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })
    assert.equal(login.status, 200)

    const bearer = await fetch(`${base}/api/anything`, { headers: { authorization: `Bearer ${SECRET}` } })
    assert.equal(bearer.status, 200)

    const pw = await fetch(`${base}/api/auth/password`, { method: 'POST', body: JSON.stringify({ current: PASSWORD, next: 'x'.repeat(12) }) })
    assert.equal(pw.status, 401, 'changing the password needs a signed-in caller')
  } finally {
    await close()
  }
})

// ---- hardening ---------------------------------------------------------------

test('a malformed % in another cookie does not break reading the session', async () => {
  const { auth, token } = await fresh()
  const cookie = cookieFrom(await auth.setup(req(), { token, password: PASSWORD }))
  assert.equal(auth.authenticate(req({ cookie: `other=%E0%A4%A; ${cookie}; third=%zz` })).ok, true)
  assert.equal(readCookie(`${SESSION_COOKIE}=%zz`, SESSION_COOKIE), undefined)
})

test('signing out ends the session, including copies of the cookie', async () => {
  const { auth, token } = await fresh()
  const cookie = cookieFrom(await auth.setup(req(), { token, password: PASSWORD }))
  const copy = cookie
  assert.equal(await auth.logout(req({ cookie })), true)
  assert.equal(auth.authenticate(req({ cookie: copy })).ok, false)
  assert.equal(await auth.logout(req()), false, 'an anonymous logout changes nothing')
})

test('the throttle is per client, so one guesser does not lock the owner out', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  const attacker = req({}, '198.51.100.7')
  for (let i = 0; i < 10; i++) await auth.login(attacker, { password: 'wrong password' }).catch(() => {})
  await assert.rejects(() => auth.login(attacker, { password: PASSWORD }), { code: 'RATE_LIMITED' })
  assert.ok(await auth.login(req({}, '192.0.2.44'), { password: PASSWORD }))
})

test('forwarded headers from a remote peer are ignored; spoofing them does not reset the count', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  for (let i = 0; i < 10; i++) {
    await auth.login(req({ 'x-forwarded-for': `10.0.0.${i}`, 'cf-connecting-ip': `10.1.0.${i}` }, '198.51.100.7'), { password: 'nope nope' }).catch(() => {})
  }
  await assert.rejects(() => auth.login(req({ 'x-forwarded-for': '10.9.9.9' }, '198.51.100.7'), { password: PASSWORD }), { code: 'RATE_LIMITED' })
})

test('clientKey trusts forwarded headers only from a local proxy or with TOTEM_TRUST_PROXY', () => {
  const via = (peer, headers) => ({ socket: { remoteAddress: peer }, headers })
  assert.equal(clientKey(via('198.51.100.7', { 'x-forwarded-for': '1.2.3.4' }), { trustProxy: undefined }), '198.51.100.7')
  assert.equal(clientKey(via('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' }), { trustProxy: undefined }), '1.2.3.4')
  assert.equal(clientKey(via('::1', { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' }), { trustProxy: undefined }), '5.6.7.8')
  assert.equal(clientKey(via('198.51.100.7', { 'x-forwarded-for': '1.2.3.4' }), { trustProxy: 'true' }), '1.2.3.4')
  assert.equal(clientKey(via('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), { trustProxy: 'false' }), '127.0.0.1')
})

test('a global cap stops guessing spread across many addresses', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  for (let i = 0; i < 50; i++) await auth.login(req({}, `198.51.100.${i}`), { password: 'wrong password' }).catch(() => {})
  await assert.rejects(() => auth.login(req({}, '192.0.2.200'), { password: PASSWORD }), { code: 'RATE_LIMITED' })
})

test('HTTP: a body that is valid JSON but not an object is a 400, not a crash', async () => {
  const { auth, token } = await fresh()
  const { base, close } = await serve(auth)
  try {
    for (const body of ['null', '[]', '"x"', '3']) {
      for (const path of ['/api/auth/login', '/api/auth/setup', '/api/auth/setup/check']) {
        const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        assert.equal(r.status, 400, `${path} ${body}`)
        assert.equal((await r.json()).error.code, 'BAD_BODY')
      }
    }
    // Still alive and still working.
    const ok = await fetch(`${base}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ token, password: PASSWORD }) })
    assert.equal(ok.status, 200)
  } finally {
    await close()
  }
})

test('30 concurrent wrong passwords: at most the in-flight limit are checked, the rest are 429', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  const results = await Promise.all(Array.from({ length: 30 }, () =>
    auth.login(req({}, '198.51.100.7'), { password: 'wrong password' }).then(() => 'ok', (e) => e.code)))
  const bad = results.filter((c) => c === 'BAD_PASSWORD').length
  assert.ok(bad <= 2, `${bad} were checked`)
  assert.equal(results.filter((c) => c === 'RATE_LIMITED').length, 30 - bad)
  assert.ok(!results.includes('ok'))
})

test('pairs of concurrent attempts still cannot exceed the per-client limit', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  let checked = 0
  for (let round = 0; round < 15; round++) {
    const pair = await Promise.all([1, 2].map(() =>
      auth.login(req({}, '198.51.100.7'), { password: 'wrong password' }).then(() => 'ok', (e) => e.code)))
    checked += pair.filter((c) => c === 'BAD_PASSWORD').length
  }
  assert.equal(checked, 10, 'exactly the per-client allowance, no more')
})

test('a correct password releases its reservation', async () => {
  const { auth, token } = await fresh()
  await auth.setup(req(), { token, password: PASSWORD })
  for (let i = 0; i < 9; i++) await auth.login(req(), { password: 'wrong password' }).catch(() => {})
  for (let i = 0; i < 3; i++) assert.ok(await auth.login(req(), { password: PASSWORD }))
})

test('a sign-out racing a password change never leaves a stale record', async () => {
  // Hold the sign-out's write open while the password change runs. Before the
  // mutation queue, the sign-out's stale copy (old hash) could land last. Now the
  // change sees that sessions moved while it checked the current password, and is
  // refused rather than applied on top of a record it did not verify against.
  let release
  let holding = false
  const dir = await mkdtemp(join(tmpdir(), 'totem-auth-race-'))
  const file = join(dir, 'auth.json')
  const auth = createOwnerAuth({
    file, bridgeSecret: SECRET,
    beforeWrite: async () => {
      if (!holding) return
      holding = false
      await new Promise((resolve) => { release = resolve })
    },
  })
  const token = await auth.init()
  const cookie = cookieFrom(await auth.setup(req(), { token, password: PASSWORD }))

  holding = true
  const leaving = auth.logout(req({ cookie }))
  await new Promise((r) => setTimeout(r, 20)) // the sign-out is now parked in its write
  const changing = auth.changePassword(req({ authorization: `Bearer ${SECRET}` }), { current: PASSWORD, next: 'brand new password' })
    .then(() => 'changed', (e) => e.code)
  await new Promise((r) => setTimeout(r, 300))
  release()
  const [, outcome] = await Promise.all([leaving, changing])
  assert.equal(outcome, 'BAD_PASSWORD')

  for (const view of [auth, createOwnerAuth({ file, bridgeSecret: SECRET })]) {
    await view.init()
    assert.ok(await view.login(req({}, '192.0.2.41'), { password: PASSWORD }), 'the password is still the one on disk')
  }
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessionVersion, 2, 'the sign-out landed')
  // Retried now, the change goes through.
  assert.ok(await auth.changePassword(req({ authorization: `Bearer ${SECRET}` }), { current: PASSWORD, next: 'brand new password' }))
  await assert.rejects(() => auth.login(req({}, '192.0.2.42'), { password: PASSWORD }), { code: 'BAD_PASSWORD' })
})

/** An auth whose next password check pauses until the test lets it go. */
async function pausable() {
  let release
  let pausing = false
  const dir = await mkdtemp(join(tmpdir(), 'totem-auth-verify-'))
  const file = join(dir, 'auth.json')
  const auth = createOwnerAuth({
    file, bridgeSecret: SECRET,
    afterVerify: async () => {
      if (!pausing) return
      pausing = false
      await new Promise((resolve) => { release = resolve })
    },
  })
  const token = await auth.init()
  await auth.setup(req(), { token, password: PASSWORD })
  return { auth, file, pauseNext: () => { pausing = true }, release: () => release() }
}

test('a login checked against the old password gets no cookie if the password changed meanwhile', async () => {
  const { auth, pauseNext, release } = await pausable()
  pauseNext()
  const stale = auth.login(req({}, '198.51.100.9'), { password: PASSWORD }).then((c) => c, (e) => e)
  await new Promise((r) => setTimeout(r, 150)) // scrypt done, parked after the check
  await auth.changePassword(req({ authorization: `Bearer ${SECRET}` }), { current: PASSWORD, next: 'brand new password' })
  release()
  const result = await stale
  assert.ok(result instanceof Error, 'no cookie')
  assert.equal(result.code, 'BAD_PASSWORD')
  assert.equal(result.status, 401)
  assert.ok(await auth.login(req({}, '198.51.100.10'), { password: 'brand new password' }))
})

test('a password change checked against an old hash is refused if another change landed first', async () => {
  const { auth, file, pauseNext, release } = await pausable()
  pauseNext()
  const first = auth.changePassword(req({ authorization: `Bearer ${SECRET}` }), { current: PASSWORD, next: 'first new password' })
    .then(() => 'changed', (e) => e.code)
  await new Promise((r) => setTimeout(r, 150))
  await auth.changePassword(req({ authorization: `Bearer ${SECRET}` }), { current: PASSWORD, next: 'second new password' })
  release()
  assert.equal(await first, 'BAD_PASSWORD')
  const fresh = createOwnerAuth({ file, bridgeSecret: SECRET })
  await fresh.init()
  assert.ok(await fresh.login(req({}, '198.51.100.11'), { password: 'second new password' }))
})
