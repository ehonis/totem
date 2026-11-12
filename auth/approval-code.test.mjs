// Run with: node --test auth/approval-code.test.mjs
//
// The approval code is the credential a caller holding only the bearer secret does
// not have. A failure here can mean an agent with BRIDGE_SECRET approves its own
// email, that replacing or deleting a file turns the protection off quietly, that
// a flood of wrong codes locks the owner out, or that an install which predates
// the code stops working.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnerAuth } from './owner.mjs'
import { createAuthHttpHandler } from './http.mjs'
import { createApprovalCode, newApprovalCode, normalizeApprovalCode, approvalCodeHash, approvalRecordId, legacyScryptHash, APPROVAL_CODE_HEADER } from './approval-code.mjs'
import { runApprovalCodeCli } from './approval-code-cli.mjs'

const SECRET = 'machine-secret-for-tests'
const PASSWORD = 'correct horse battery'
const req = (headers = {}, remoteAddress = '203.0.113.9') => ({ headers, socket: { remoteAddress } })
const bearer = { authorization: `Bearer ${SECRET}` }

// A real owner (password + cookie) and an approval code wired the way bridge.mjs wires them.
async function owner({ existingInstall = false, mode } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-approval-code-'))
  const authFile = join(dir, 'auth.json')
  const codeFile = join(dir, 'approval-code.json')
  const auth = createOwnerAuth({ file: authFile, bridgeSecret: SECRET, mode })
  const token = await auth.init()
  let cookie = null
  if (token) cookie = (await auth.setup(req(), { token, password: PASSWORD })).split(';')[0]
  const reports = []
  const build = (opts = {}) => createApprovalCode({
    file: codeFile,
    existingInstall,
    authMode: auth.mode,
    policy: { read: () => auth.approvalPolicy(), write: (patch) => auth.updateApprovalPolicy(patch) },
    report: (event) => reports.push(event),
    ...opts,
  })
  const code = build()
  await code.init()
  // What the gate sees for a request: the session (never the bearer), and the header.
  const check = (headers, risk = 'high', remoteAddress) => code.check(req(headers, remoteAddress), { risk, hasSession: auth.hasSession(req(headers)) })
  return { dir, auth, authFile, codeFile, code, build, reports, cookie: { cookie }, check }
}

// A bridge restart: a new owner record and a new code instance over the same files.
async function restart({ authFile, codeFile }, { existingInstall = true } = {}) {
  const auth = createOwnerAuth({ file: authFile, bridgeSecret: SECRET })
  await auth.init()
  const reports = []
  const code = createApprovalCode({ file: codeFile, existingInstall, policy: { read: () => auth.approvalPolicy(), write: (p) => auth.updateApprovalPolicy(p) }, report: (e) => reports.push(e) })
  await code.init()
  return { auth, code, reports }
}

test('a new code is 100 random bits in four groups, and typing it loosely still matches', () => {
  const code = newApprovalCode()
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/)
  assert.notEqual(newApprovalCode(), code)
  assert.equal(normalizeApprovalCode(' abcde-fghjk ooiil '), 'ABCDEFGHJK00111')
})

test('a fresh install records "fresh" in both places: high-risk approvals wait for a code', async () => {
  const { code, auth, codeFile, check, cookie } = await owner()
  assert.equal(auth.approvalPolicy().install, 'fresh')
  assert.equal(JSON.parse(await readFile(codeFile, 'utf8')).install, 'fresh')
  assert.equal((await code.status()).state, 'unset')
  await assert.rejects(() => check(cookie), { code: 'APPROVAL_CODE_NOT_SET', status: 403 })
  // Changes that stay in his own stores still work from a signed-in session.
  assert.equal(await check(cookie, 'low'), 'session')
  assert.equal(await code.oneTimeCodesAllowed(), false)
})

test('the bearer secret alone approves nothing, in any state', async () => {
  for (const existingInstall of [false, true]) {
    const { check, code } = await owner({ existingInstall })
    await assert.rejects(() => check(bearer, 'low'), { code: 'APPROVAL_NEEDS_OWNER' })
    await assert.rejects(() => check(bearer, 'high'), { code: 'APPROVAL_NEEDS_OWNER' })
    await code.set()
    await assert.rejects(() => check(bearer, 'low'), { code: 'APPROVAL_NEEDS_OWNER' })
    await assert.rejects(() => check(bearer, 'high'), { code: 'APPROVAL_NEEDS_OWNER' })
  }
})

test('a session cookie next to the bearer still counts as the session', async () => {
  const { check, cookie } = await owner({ existingInstall: true })
  assert.equal(await check({ ...bearer, ...cookie }, 'high'), 'session')
})

test('an existing install keeps working on its sign-in until a code is set, and the owner is told once', async () => {
  const { code, auth, check, cookie, reports, authFile, codeFile } = await owner({ existingInstall: true })
  assert.equal(auth.approvalPolicy().install, 'existing')
  assert.equal((await code.status()).state, 'legacy')
  assert.deepEqual(reports.map((r) => r.kind), ['legacy'])
  assert.equal(await check(cookie, 'high'), 'session')
  assert.equal(await code.oneTimeCodesAllowed(), true)
  // Once: a restart does not tell him again.
  assert.deepEqual((await restart({ authFile, codeFile })).reports, [])

  const { code: value } = await code.set()
  assert.equal((await code.status()).state, 'armed')
  assert.equal(await code.oneTimeCodesAllowed(), false)
  await assert.rejects(() => check(cookie, 'high'), { code: 'APPROVAL_CODE_REQUIRED' })
  assert.equal(await check({ ...cookie, [APPROVAL_CODE_HEADER]: value }, 'high'), 'code')
})

test('the install decision is made once and never re-judged', async () => {
  const { auth, build } = await owner({ existingInstall: false })
  // A later boot sees data from the first one and would call this an existing install.
  await build({ existingInstall: true }).init()
  assert.equal(auth.approvalPolicy().install, 'fresh')
})

test('downgrade: editing one copy of the install decision to "existing" is caught, the stricter one wins', async () => {
  for (const which of ['auth', 'file']) {
    const { auth, authFile, codeFile, cookie } = await owner({ existingInstall: false })
    if (which === 'auth') await auth.updateApprovalPolicy({ install: 'existing' })
    else await writeFile(codeFile, JSON.stringify({ version: 2, install: 'existing', decidedAt: 'x' }))
    const next = await restart({ authFile, codeFile })
    assert.equal((await next.code.status()).state, 'tampered', which)
    assert.ok(next.reports.some((r) => r.kind === 'tampered'), which)
    await assert.rejects(() => next.code.check(req(cookie), { risk: 'high', hasSession: true }), { code: 'APPROVAL_CODE_TAMPERED' })
  }
})

test('cookie plus code, or bearer plus code (the iPhone app), is accepted', async () => {
  const { code, check, cookie } = await owner()
  const { code: value } = await code.set()
  assert.equal(await check({ ...cookie, [APPROVAL_CODE_HEADER]: value }), 'code')
  assert.equal(await check({ ...bearer, [APPROVAL_CODE_HEADER]: value.toLowerCase().replace(/-/g, ' ') }), 'code')
})

test('a wrong code is refused, counted per client, and rate limited; a correct one never is', async () => {
  const { code, check, cookie } = await owner()
  const { code: value } = await code.set()
  const wrong = { ...cookie, [APPROVAL_CODE_HEADER]: newApprovalCode() }
  // Even where none was needed: a stale code means this device needs updating.
  await assert.rejects(() => check(wrong, 'low', '198.51.100.1'), { code: 'APPROVAL_CODE_WRONG', status: 403 })
  for (let i = 0; i < 4; i++) await assert.rejects(() => check(wrong, 'high', '198.51.100.1'), { code: 'APPROVAL_CODE_WRONG', status: 403 })
  // Past the limit a wrong code is a 429; the right code from the same client still passes.
  await assert.rejects(() => check(wrong, 'high', '198.51.100.1'), { code: 'APPROVAL_RATE_LIMITED', status: 429 })
  assert.equal(await check({ ...cookie, [APPROVAL_CODE_HEADER]: value }, 'high', '198.51.100.1'), 'code')
  await assert.rejects(() => check(wrong, 'high', '198.51.100.1'), { code: 'APPROVAL_RATE_LIMITED' })
})

test('wrong codes across many clients turn into 429s, but never lock out a correct code', async () => {
  const { code, check, cookie } = await owner()
  const { code: value } = await code.set()
  for (let i = 0; i < 20; i++) await check({ ...cookie, [APPROVAL_CODE_HEADER]: newApprovalCode() }, 'high', `198.51.100.${i}`).catch(() => {})
  await assert.rejects(() => check({ ...cookie, [APPROVAL_CODE_HEADER]: newApprovalCode() }, 'high', '192.0.2.201'), { code: 'APPROVAL_RATE_LIMITED' })
  assert.equal(await check({ ...cookie, [APPROVAL_CODE_HEADER]: value }, 'high', '192.0.2.200'), 'code')
})

test('a spoofed X-Forwarded-For flood with the bearer cannot lock the owner out', async () => {
  const { code, cookie, auth } = await owner()
  const { code: value } = await code.set()
  const at = (headers) => code.check(req(headers, '127.0.0.1'), { risk: 'high', hasSession: auth.hasSession(req(headers)) })
  // An agent on this machine: loopback, a made-up client address per request.
  for (let i = 0; i < 40; i++) {
    await at({ ...bearer, 'x-forwarded-for': `10.0.${i}.1`, [APPROVAL_CODE_HEADER]: newApprovalCode() }).catch(() => {})
  }
  // The flood's wrong codes are 429s now, but the phone (bearer, same loopback
  // address, through a local tunnel) and the browser still get through.
  await assert.rejects(() => at({ ...bearer, [APPROVAL_CODE_HEADER]: newApprovalCode() }), { code: 'APPROVAL_RATE_LIMITED' })
  assert.equal(await at({ ...bearer, 'x-forwarded-for': '10.9.9.9', [APPROVAL_CODE_HEADER]: value }), 'code')
  assert.equal(await at({ ...cookie, [APPROVAL_CODE_HEADER]: value }), 'code')
})

test('a concurrent flood of wrong codes from spoofed clients never refuses the owner\'s code', async () => {
  const { auth, authFile, codeFile, cookie } = await owner()
  // A trusted-proxy install: every spoofed address is its own client.
  const prev = process.env.TOTEM_TRUST_PROXY
  process.env.TOTEM_TRUST_PROXY = '1'
  try {
    const next = await restart({ authFile, codeFile }, { existingInstall: false })
    const { code: value } = await next.code.set()
    const at = (headers) => next.code.check(req(headers, '127.0.0.1'), { risk: 'high', hasSession: auth.hasSession(req(headers)) })
    const flood = Array.from({ length: 30 }, (_, i) => at({ ...bearer, 'x-forwarded-for': `10.1.${i}.1`, [APPROVAL_CODE_HEADER]: newApprovalCode() }).catch((e) => e.code))
    // The phone's tries, sent in the middle of the flood.
    const phone = Array.from({ length: 5 }, () => at({ ...bearer, [APPROVAL_CODE_HEADER]: value }))
    assert.deepEqual(await Promise.all(phone), ['code', 'code', 'code', 'code', 'code'])
    const outcomes = await Promise.all(flood)
    assert.ok(outcomes.every((c) => c === 'APPROVAL_CODE_WRONG' || c === 'APPROVAL_RATE_LIMITED'), outcomes.join(','))
    assert.equal(await at({ ...cookie, [APPROVAL_CODE_HEADER]: value }), 'code')
  } finally {
    if (prev === undefined) delete process.env.TOTEM_TRUST_PROXY
    else process.env.TOTEM_TRUST_PROXY = prev
  }
})

test('300 concurrent wrong codes held open, then the owner\'s code passes at once (nothing queues)', async () => {
  const { auth, authFile, codeFile, cookie } = await owner()
  // A fresh start: nothing has been verified in this process yet.
  const next = await restart({ authFile, codeFile }, { existingInstall: false })
  const { code: value } = await next.code.set()
  const fresh = await restart({ authFile, codeFile }, { existingInstall: false })
  const at = (headers, peer) => fresh.code.check(req(headers, peer), { risk: 'high', hasSession: auth.hasSession(req(headers)) })
  const flood = Array.from({ length: 300 }, (_, i) => at({ ...bearer, [APPROVAL_CODE_HEADER]: newApprovalCode() }, `198.18.${i >> 8}.${i & 255}`).catch((e) => e.code))
  const started = performance.now()
  const phone = at({ ...bearer, [APPROVAL_CODE_HEADER]: value }, '203.0.113.50')
  const web = at({ ...cookie, [APPROVAL_CODE_HEADER]: value }, '203.0.113.51')
  assert.deepEqual(await Promise.all([phone, web]), ['code', 'code'])
  assert.ok(performance.now() - started < 250, `took ${Math.round(performance.now() - started)} ms`)
  const outcomes = await Promise.all(flood)
  assert.ok(outcomes.every((c) => c === 'APPROVAL_CODE_WRONG' || c === 'APPROVAL_RATE_LIMITED'), [...new Set(outcomes)].join(','))
  // And straight after the flood, from loopback like a tunnelled phone.
  assert.equal(await at({ ...bearer, [APPROVAL_CODE_HEADER]: value }, '127.0.0.1'), 'code')
})

test('an scrypt record from before the HMAC switch is accepted once and rewritten, still armed after a restart', async () => {
  const { auth, authFile, codeFile } = await owner()
  const value = newApprovalCode()
  const record = { version: 2, install: 'fresh', decidedAt: 'x', armedAt: '2026-10-30T00:00:00.000Z', setAt: '2026-10-30T00:00:00.000Z', ...(await legacyScryptHash(value)) }
  await writeFile(codeFile, JSON.stringify(record))
  await auth.updateApprovalPolicy({ install: 'fresh', armedAt: record.armedAt, recordId: approvalRecordId(record) })
  const next = await restart({ authFile, codeFile }, { existingInstall: false })
  assert.equal((await next.code.status()).state, 'armed')
  await assert.rejects(() => next.code.check(req({ [APPROVAL_CODE_HEADER]: newApprovalCode() }), { risk: 'high' }), { code: 'APPROVAL_CODE_WRONG' })
  assert.equal(JSON.parse(await readFile(codeFile, 'utf8')).algo, undefined)
  assert.equal(await next.code.check(req({ [APPROVAL_CODE_HEADER]: value }), { risk: 'high' }), 'code')
  const upgraded = JSON.parse(await readFile(codeFile, 'utf8'))
  assert.equal(upgraded.algo, 'hmac-sha256')
  assert.equal(upgraded.params, undefined)
  assert.equal(upgraded.setAt, record.setAt)
  // Not mistaken for tampering, now or after a restart; the same code still works.
  assert.equal((await next.code.status()).state, 'armed')
  assert.deepEqual(next.reports.filter((r) => r.kind === 'tampered'), [])
  const again = await restart({ authFile, codeFile }, { existingInstall: false })
  assert.equal((await again.code.status()).state, 'armed')
  assert.equal(await again.code.check(req({ [APPROVAL_CODE_HEADER]: value }), { risk: 'high' }), 'code')
})

test('the window passes and the client may try again', async () => {
  let clock = Date.parse('2026-10-30T12:00:00Z')
  const { build, cookie, auth } = await owner()
  const code = build({ now: () => clock })
  await code.init()
  const { code: value } = await code.set()
  const at = (headers) => code.check(req(headers, '198.51.100.9'), { risk: 'high', hasSession: auth.hasSession(req(headers)) })
  for (let i = 0; i < 5; i++) await at({ ...cookie, [APPROVAL_CODE_HEADER]: 'nope' }).catch(() => {})
  await assert.rejects(() => at({ ...cookie, [APPROVAL_CODE_HEADER]: 'nope' }), { code: 'APPROVAL_RATE_LIMITED' })
  clock += 16 * 60 * 1000
  await assert.rejects(() => at({ ...cookie, [APPROVAL_CODE_HEADER]: 'nope' }), { code: 'APPROVAL_CODE_WRONG', status: 403 })
  assert.equal(await at({ ...cookie, [APPROVAL_CODE_HEADER]: value }), 'code')
})

test('only a salted HMAC-SHA256 is stored, mode 0600; rotating retires the old code', async () => {
  const { code, codeFile, check, cookie } = await owner()
  const { code: first } = await code.set()
  const raw = await readFile(codeFile, 'utf8')
  assert.ok(!raw.includes(first) && !raw.includes(normalizeApprovalCode(first)))
  assert.equal(JSON.parse(raw).algo, 'hmac-sha256')
  assert.equal(Buffer.from(JSON.parse(raw).salt, 'base64').length, 32)
  assert.equal((await stat(codeFile)).mode & 0o777, 0o600)
  const { code: second } = await code.set()
  await assert.rejects(() => check({ ...cookie, [APPROVAL_CODE_HEADER]: first }), { code: 'APPROVAL_CODE_WRONG' })
  assert.equal(await check({ ...cookie, [APPROVAL_CODE_HEADER]: second }), 'code')
})

test('tamper: replacing the hash file with an agent\'s own code refuses everything at once, and says so', async () => {
  const { code, codeFile, check, cookie, reports } = await owner()
  const { code: owners } = await code.set()
  const agents = newApprovalCode()
  const onDisk = JSON.parse(await readFile(codeFile, 'utf8'))
  await writeFile(codeFile, JSON.stringify({ ...onDisk, ...(await approvalCodeHash(agents)) }))
  await assert.rejects(() => check({ ...bearer, [APPROVAL_CODE_HEADER]: agents }), { code: 'APPROVAL_CODE_TAMPERED' })
  await assert.rejects(() => check({ ...cookie, [APPROVAL_CODE_HEADER]: owners }), { code: 'APPROVAL_CODE_TAMPERED' })
  assert.equal((await code.status()).state, 'tampered')
  assert.equal(reports.filter((r) => r.kind === 'tampered').length, 1)
  // Putting the old file back does not clear it: only setting a new code does.
  await writeFile(codeFile, JSON.stringify(onDisk))
  assert.equal((await code.status()).state, 'tampered')
  const { code: fresh } = await code.set()
  assert.equal(await check({ ...cookie, [APPROVAL_CODE_HEADER]: fresh }), 'code')
})

test('tamper: a hash file that appears without Totem setting it is refused, live and after a restart', async () => {
  const { code, codeFile, cookie, authFile } = await owner()
  const agents = newApprovalCode()
  const planted = { version: 2, install: 'fresh', decidedAt: 'x', armedAt: 'x', setAt: 'x', ...(await approvalCodeHash(agents)) }
  await writeFile(codeFile, JSON.stringify(planted))
  await assert.rejects(() => code.check(req({ ...bearer, [APPROVAL_CODE_HEADER]: agents }), { risk: 'high' }), { code: 'APPROVAL_CODE_TAMPERED' })
  // auth.json has no record id for it, so a restart does not adopt it either.
  const next = await restart({ authFile, codeFile }, { existingInstall: false })
  assert.equal((await next.code.status()).state, 'tampered')
  await assert.rejects(() => next.code.check(req({ ...cookie, [APPROVAL_CODE_HEADER]: agents }), { risk: 'high', hasSession: true }), { code: 'APPROVAL_CODE_TAMPERED' })
})

test('tamper: an edited latch in auth.json is put back and reported, without disarming', async () => {
  const { code, auth, check, cookie, reports } = await owner()
  const { code: value } = await code.set()
  await auth.updateApprovalPolicy({ armedAt: null, recordId: null, install: 'existing' })
  assert.equal(await check({ ...cookie, [APPROVAL_CODE_HEADER]: value }), 'code')
  await assert.rejects(() => check(cookie, 'high'), { code: 'APPROVAL_CODE_REQUIRED' })
  assert.ok(reports.some((r) => r.kind === 'drift'))
  assert.ok(auth.approvalPolicy().recordId && auth.approvalPolicy().armedAt)
  assert.equal(auth.approvalPolicy().install, 'fresh')
})

test('latch: deleting or emptying the code file refuses approvals instead of disarming', async () => {
  const { code, codeFile, check, cookie, build, auth, authFile } = await owner({ existingInstall: true })
  const { code: value } = await code.set()
  await rm(codeFile)
  assert.equal((await code.status()).state, 'missing')
  await assert.rejects(() => check(cookie, 'high'), { code: 'APPROVAL_CODE_MISSING' })
  await assert.rejects(() => check({ ...cookie, [APPROVAL_CODE_HEADER]: value }, 'high'), { code: 'APPROVAL_CODE_MISSING' })
  // Low-risk approvals never needed the code, so they carry on.
  assert.equal(await check(cookie, 'low'), 'session')
  // A legacy install does not fall back to its old sign-in-only behaviour.
  assert.equal(await code.oneTimeCodesAllowed(), false)

  // After a restart, from auth.json alone: the latch is not just in memory.
  await writeFile(codeFile, '')
  const next = await restart({ authFile, codeFile })
  assert.equal((await next.code.status()).state, 'missing')

  // Setting a new code is the way back.
  const fresh = build()
  await fresh.init()
  const { code: newCode } = await fresh.set()
  assert.equal(await fresh.check(req({ ...cookie, [APPROVAL_CODE_HEADER]: newCode }), { risk: 'high', hasSession: true }), 'code')
  assert.ok(auth.approvalPolicy().armedAt)
})

test('latch: the armed fact is in the code file too, so clearing it from auth.json does not downgrade', async () => {
  const { code, codeFile, auth, authFile } = await owner({ existingInstall: true })
  await code.set()
  await rm(codeFile)
  await code.status()
  // The running bridge rewrote nothing, so put the decision-only file back as a restart would find it.
  await writeFile(codeFile, JSON.stringify({ version: 2, install: 'existing', decidedAt: 'x', armedAt: 'x' }))
  await auth.updateApprovalPolicy({ armedAt: null, recordId: null })
  const next = await restart({ authFile, codeFile })
  assert.equal((await next.code.status()).state, 'missing')
})

test('latch: the process remembers it was armed even if auth.json loses the latch', async () => {
  const { code, codeFile, check, cookie, auth } = await owner()
  await code.set()
  await auth.updateApprovalPolicy({ armedAt: null })
  await rm(codeFile)
  assert.equal((await code.status()).state, 'missing')
  await assert.rejects(() => check(cookie, 'high'), { code: 'APPROVAL_CODE_MISSING' })
})

test('creating the owner keeps the approval policy recorded before it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-approval-code-'))
  const auth = createOwnerAuth({ file: join(dir, 'auth.json'), bridgeSecret: SECRET })
  const token = await auth.init()
  const code = createApprovalCode({ file: join(dir, 'approval-code.json'), policy: { read: () => auth.approvalPolicy(), write: (p) => auth.updateApprovalPolicy(p) } })
  await code.init()
  await auth.setup(req(), { token, password: PASSWORD })
  assert.equal(auth.approvalPolicy().install, 'fresh')
})

async function serve(auth, approvalCode) {
  const handle = createAuthHttpHandler(auth, { approvalCode })
  const server = http.createServer(async (rq, rs) => {
    if (await handle(rq, rs, new URL(rq.url, 'http://x'))) return
    rs.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

test('HTTP: setting the code needs the password, from the cookie or the bearer, and returns it once', async () => {
  const { auth, code, cookie, codeFile } = await owner()
  const { base, close } = await serve(auth, code)
  const post = (headers, body) => fetch(`${base}/api/auth/approval-code`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({}, { password: PASSWORD })).status, 401)
    const wrong = await post(cookie, { password: 'not the password' })
    assert.equal(wrong.status, 401)
    assert.equal((await wrong.json()).error.code, 'BAD_PASSWORD')
    // The bearer alone cannot set one: it still needs the password, which agents do not hold.
    assert.equal((await post(bearer, {})).status, 401)

    const set = await post(cookie, { password: PASSWORD })
    assert.equal(set.status, 200)
    const { code: value } = await set.json()
    assert.match(value, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/)
    assert.ok(!(await readFile(codeFile, 'utf8')).includes(value))

    const status = await (await fetch(`${base}/api/auth/approval-code`, { headers: cookie })).json()
    assert.equal(status.state, 'armed')
    assert.equal(status.header, APPROVAL_CODE_HEADER)
    assert.equal(JSON.stringify(status).includes(value), false)

    const fromApp = await post(bearer, { password: PASSWORD })
    assert.equal(fromApp.status, 200)
    assert.notEqual((await fromApp.json()).code, value)
  } finally {
    await close()
  }
})

test('HTTP: behind an auth proxy the dashboard cannot set a code; the CLI does', async () => {
  const { auth, code } = await owner({ mode: 'proxy' })
  const { base, close } = await serve(auth, code)
  try {
    const r = await fetch(`${base}/api/auth/approval-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    assert.equal(r.status, 409)
    assert.equal((await r.json()).error.code, 'PROXY_MODE')
  } finally {
    await close()
  }
})

const tty = () => ({ isTTY: true, text: '', write(s) { this.text += s } })

// The CLI reads its paths from the checkout's .env; a test gives it its own.
function envFileFor(dir, { AUTH_FILE, APPROVAL_CODE_FILE }) {
  const file = join(dir, 'test.env')
  writeFileSync(file, `AUTH_FILE=${AUTH_FILE}\nAPPROVAL_CODE_FILE=${APPROVAL_CODE_FILE}\n`)
  return file
}

// Run with the caller's own environment set, to prove the CLI ignores it.
async function withCallerEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try { return await fn() } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

test('CLI: refuses without a terminal, and always asks for the owner password, whatever the caller\'s environment says', async () => {
  const { authFile, codeFile, dir } = await owner()
  const envFile = envFileFor(dir, { AUTH_FILE: authFile, APPROVAL_CODE_FILE: codeFile })
  const out = tty()
  let asked = 0
  const ask = async () => { asked++; return PASSWORD }
  await assert.rejects(() => runApprovalCodeCli({ envFile, stdin: { isTTY: false }, stdout: out, ask }), /interactive terminal/)
  await assert.rejects(() => runApprovalCodeCli({ envFile, stdin: { isTTY: true }, stdout: { isTTY: false, write() {} }, ask }), /interactive terminal/)
  await assert.rejects(() => runApprovalCodeCli({ envFile, stdin: { isTTY: true }, stdout: out, ask: async () => 'wrong password' }), { code: 'BAD_PASSWORD' })
  // An auth proxy claimed, and AUTH_FILE pointed at an owner-less file the caller
  // wrote: the CLI reads neither, so the password is still asked.
  const fake = join(dir, 'fake-auth.json')
  await writeFile(fake, JSON.stringify({ approvalCode: { authMode: 'proxy' } }))
  await withCallerEnv({ TOTEM_AUTH: 'proxy', AUTH_FILE: fake }, () =>
    assert.rejects(() => runApprovalCodeCli({ envFile, stdin: { isTTY: true }, stdout: out, ask: async () => '' }), { code: 'BAD_PASSWORD' }))
  assert.equal(JSON.parse(await readFile(codeFile, 'utf8')).hash, undefined)

  const value = await withCallerEnv({ TOTEM_AUTH: 'proxy' }, () => runApprovalCodeCli({ envFile, stdin: { isTTY: true }, stdout: out, ask }))
  assert.equal(asked, 1)
  assert.ok(out.text.includes(value))
  assert.match(out.text, /Restart Totem/)
})

test('CLI: a code it sets is loaded at the next start; the running bridge treats it as tampering until then', async () => {
  const { authFile, codeFile, code, reports, dir } = await owner()
  const envFile = envFileFor(dir, { AUTH_FILE: authFile, APPROVAL_CODE_FILE: codeFile })
  const value = await runApprovalCodeCli({ envFile, stdin: { isTTY: true }, stdout: tty(), ask: async () => PASSWORD })
  await assert.rejects(() => code.check(req({ [APPROVAL_CODE_HEADER]: value }), { risk: 'high' }), { code: 'APPROVAL_CODE_TAMPERED' })
  assert.ok(reports.some((r) => r.kind === 'tampered'))
  const next = await restart({ authFile, codeFile }, { existingInstall: false })
  assert.equal((await next.code.status()).state, 'armed')
  assert.equal(await next.code.check(req({ [APPROVAL_CODE_HEADER]: value }), { risk: 'high' }), 'code')
})

test('CLI: with no owner, only an install the bridge recorded as proxy-mode skips the password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-approval-code-'))
  const env = { AUTH_FILE: join(dir, 'auth.json'), APPROVAL_CODE_FILE: join(dir, 'approval-code.json') }
  const envFile = envFileFor(dir, env)
  // No owner, no recorded mode: the caller saying "proxy" is not enough.
  await withCallerEnv({ TOTEM_AUTH: 'proxy' }, () =>
    assert.rejects(() => runApprovalCodeCli({ envFile, stdin: { isTTY: true }, stdout: tty(), ask: async () => '' }), /no owner account/))
  // The bridge, running behind an auth proxy, records that itself.
  const auth = createOwnerAuth({ file: env.AUTH_FILE, mode: 'proxy' })
  await auth.init()
  await createApprovalCode({ file: env.APPROVAL_CODE_FILE, authMode: auth.mode, policy: { read: () => auth.approvalPolicy(), write: (p) => auth.updateApprovalPolicy(p) } }).init()
  const value = await runApprovalCodeCli({ envFile, stdin: { isTTY: true }, stdout: tty(), ask: async () => { throw new Error('should not ask') } })
  assert.match(value, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/)
})
