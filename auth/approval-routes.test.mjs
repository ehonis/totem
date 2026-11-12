// Run with: node --test auth/approval-routes.test.mjs
//
// Every route that confers the owner's approval, over HTTP. A failure can mean an
// agent holding BRIDGE_SECRET accepts its own proposal, approves its own MCP
// session or sends a message, or that a new approval route went in ungated.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnerAuth } from './owner.mjs'
import { createApprovalCode, ApprovalRefused, APPROVAL_CODE_HEADER } from './approval-code.mjs'
import { APPROVAL_ROUTES, approvalRouteFor, inboxApprovalRisk, normalizeApiPath } from './approval-routes.mjs'

const SECRET = 'machine-secret-for-tests'
const PASSWORD = 'correct horse battery'
const bridge = readFileSync(join(import.meta.dirname, '..', 'bridge.mjs'), 'utf8')

// The proposal each inbox request decides; the real bridge reads it from inbox.md.
const ITEMS = {
  P1: { id: 'P1', kind: 'email', meta: {} },
  P2: { id: 'P2', kind: 'imessage', meta: {} },
  P3: { id: 'P3', kind: 'prompt', meta: {} },
  P4: { id: 'P4', kind: 'command', meta: {} },
  P5: { id: 'P5', kind: 'todo', meta: {} },
  P6: { id: 'P6', kind: 'away', meta: {} },
}

// The same order of checks as bridge.mjs: the API gate, then the approval table
// (a per-proposal route at low risk), then /api/inbox/resolve again at the
// proposal's own risk once it has read it. auth/approval-bridge.test.mjs runs the
// real bridge; this one is the fast matrix.
async function serve({ existingInstall = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-approval-routes-'))
  const auth = createOwnerAuth({ file: join(dir, 'auth.json'), bridgeSecret: SECRET })
  const token = await auth.init()
  const cookie = (await auth.setup({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { token, password: PASSWORD })).split(';')[0]
  const code = createApprovalCode({
    file: join(dir, 'approval-code.json'),
    existingInstall,
    policy: { read: () => auth.approvalPolicy(), write: (p) => auth.updateApprovalPolicy(p) },
  })
  await code.init()
  const approveRequest = (rq, risk) => code.check(rq, { risk, hasSession: auth.hasSession(rq) })
  const done = []
  const server = http.createServer(async (rq, rs) => {
    const reply = (status, body) => rs.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (!auth.authenticate(rq).ok) return reply(401, { error: 'unauthorized' })
    let body = ''
    for await (const chunk of rq) body += chunk
    const parsed = body ? JSON.parse(body) : {}
    const route = approvalRouteFor(rq.method, rq.url)
    try {
      const approvedBy = route ? await approveRequest(rq, route.risk === 'per-item' ? 'low' : route.risk) : null
      if (route?.risk === 'per-item' && approvedBy !== 'code' && inboxApprovalRisk(ITEMS[parsed.id], parsed.action) !== 'low') await approveRequest(rq, 'high')
    } catch (e) {
      if (e instanceof ApprovalRefused) return reply(e.status, { error: { code: e.code, message: e.message } })
      throw e
    }
    done.push(`${rq.url} ${parsed.id || ''} ${parsed.action || ''}`.trim())
    return reply(200, { ok: true })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  // A case may name its method first ("PATCH /api/away/a1"); POST otherwise.
  const post = (target, headers, body = {}) => {
    const [, method = 'POST', path] = /^(?:(PATCH|DELETE) )?(.*)$/.exec(target)
    return fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  }
  return { post, code, done, cookie: { cookie }, close: () => new Promise((r) => server.close(r)) }
}

// One request per route that, on the real bridge, ends in an owner-approved side effect.
const CASES = [
  ['/api/inbox/resolve', { id: 'P1', action: 'accept' }],
  ['/api/inbox/resolve', { id: 'P1', action: 'draft' }],
  ['/api/inbox/resolve', { id: 'P2', action: 'accept' }],
  ['/api/inbox/resolve', { id: 'P3', action: 'accept' }],
  ['/api/inbox/resolve', { id: 'P4', action: 'accept' }],
  ['/api/inbox/resolve', { id: 'P5', action: 'accept' }],
  ['/api/inbox/resolve', { id: 'P1', action: 'deny' }],
  ['/api/approvals/approve', { approvalSessionId: 'x' }],
  ['/api/apple/send', { to: '+15555550100', text: 'hi' }],
  ['/api/totems/proposal', { action: 'accept' }],
  ['/api/inbox/release', { id: 'P9' }],
  ['/api/chat/approvals', { threadId: 't', partId: 'p', decision: 'approve' }],
  ['/api/chat/browser/input', { threadId: 't', kind: 'mouse', type: 'down', x: 10, y: 10 }],
  ['/api/recs/r1/decision', { decision: 'accepted' }],
  ['/api/recs/r1/outcome', { outcome: 'worked' }],
  ['/api/inbox/resolve', { id: 'P6', action: 'accept' }],
  ['/api/away', { start: '2026-12-20', end: '2026-12-27', label: 'Trip' }],
  ['PATCH /api/away/a1', { label: 'Trip home' }],
  ['DELETE /api/away/a1', {}],
  ['/api/cliproxy/accounts/delete', { name: 'a.json' }],
  ['/api/cliproxy/login', { provider: 'claude' }],
  ['/api/cliproxy/grants/claim', { name: 'a.json' }],
  ['/api/cliproxy/credits/consume', { name: 'b.json' }],
]

test('every approval route is covered by these cases', () => {
  const routeOf = (target) => { const [, method = 'POST', path] = /^(?:(PATCH|DELETE) )?(.*)$/.exec(target); return approvalRouteFor(method, path) }
  for (const route of APPROVAL_ROUTES) assert.ok(CASES.some(([target]) => routeOf(target) === route), `${route.method} ${route.path}`)
})

test('every approval route refuses the bearer secret alone', async () => {
  for (const existingInstall of [false, true]) {
    const s = await serve({ existingInstall })
    try {
      for (const [path, body] of CASES) {
        const r = await s.post(path, { authorization: `Bearer ${SECRET}` }, body)
        assert.equal(r.status, 403, `${path} ${JSON.stringify(body)}`)
        assert.equal((await r.json()).error.code, 'APPROVAL_NEEDS_OWNER')
      }
      // Armed, the bearer alone is still refused everywhere.
      await s.code.set()
      for (const [path, body] of CASES) assert.equal((await s.post(path, { authorization: `Bearer ${SECRET}` }, body)).status, 403, path)
      assert.deepEqual(s.done, [])
    } finally {
      await s.close()
    }
  }
})

test('every approval route accepts the cookie plus the code, and the app\'s bearer plus the code', async () => {
  const s = await serve()
  try {
    const { code: value } = await s.code.set()
    for (const [path, body] of CASES) {
      assert.equal((await s.post(path, { ...s.cookie, [APPROVAL_CODE_HEADER]: value }, body)).status, 200, path)
      assert.equal((await s.post(path, { authorization: `Bearer ${SECRET}`, [APPROVAL_CODE_HEADER]: value }, body)).status, 200, path)
    }
    assert.equal(s.done.length, CASES.length * 2)
  } finally {
    await s.close()
  }
})

test('every approval route refuses a wrong code, and then rate limits it', async () => {
  const s = await serve()
  try {
    await s.code.set()
    let statuses = []
    for (const [path, body] of CASES) statuses.push((await s.post(path, { ...s.cookie, [APPROVAL_CODE_HEADER]: 'AAAAA-BBBBB-CCCCC-DDDDD' }, body)).status)
    // Five wrong codes per client in the window, then 429 on every route.
    assert.deepEqual(statuses.slice(0, 5), [403, 403, 403, 403, 403])
    assert.ok(statuses.slice(5).every((st) => st === 429), statuses.join(','))
    assert.deepEqual(s.done, [])
  } finally {
    await s.close()
  }
})

test('armed: the cookie alone approves low-risk decisions only', async () => {
  const s = await serve()
  try {
    await s.code.set()
    const results = {}
    for (const [path, body] of CASES) {
      const r = await s.post(path, s.cookie, body)
      results[[path, body.id, body.action].filter(Boolean).join(' ')] = r.status === 200 ? 'ok' : (await r.json()).error.code
    }
    assert.deepEqual(results, {
      '/api/inbox/resolve P1 accept': 'APPROVAL_CODE_REQUIRED',
      '/api/inbox/resolve P1 draft': 'APPROVAL_CODE_REQUIRED',
      '/api/inbox/resolve P2 accept': 'APPROVAL_CODE_REQUIRED',
      '/api/inbox/resolve P3 accept': 'APPROVAL_CODE_REQUIRED',
      '/api/inbox/resolve P4 accept': 'APPROVAL_CODE_REQUIRED',
      '/api/inbox/resolve P5 accept': 'ok',
      '/api/inbox/resolve P1 deny': 'ok',
      '/api/approvals/approve': 'APPROVAL_CODE_REQUIRED',
      '/api/apple/send': 'APPROVAL_CODE_REQUIRED',
      '/api/totems/proposal accept': 'ok',
      '/api/inbox/release P9': 'ok',
      '/api/chat/approvals': 'ok',
      '/api/chat/browser/input': 'ok',
      '/api/cliproxy/accounts/delete': 'ok',
      '/api/cliproxy/credits/consume': 'APPROVAL_CODE_REQUIRED',
      '/api/cliproxy/grants/claim': 'APPROVAL_CODE_REQUIRED',
      '/api/cliproxy/login': 'ok',
      '/api/recs/r1/decision': 'ok',
      '/api/recs/r1/outcome': 'ok',
      // An agent's away proposal is high risk: an away day holds back nudges.
      '/api/inbox/resolve P6 accept': 'APPROVAL_CODE_REQUIRED',
      '/api/away': 'ok',
      'PATCH /api/away/a1': 'ok',
      'DELETE /api/away/a1': 'ok',
    })
  } finally {
    await s.close()
  }
})

test('existing install: the cookie alone keeps approving everything until a code is set', async () => {
  const s = await serve({ existingInstall: true })
  try {
    for (const [path, body] of CASES) assert.equal((await s.post(path, s.cookie, body)).status, 200, path)
    await s.code.set()
    assert.equal((await s.post('/api/inbox/resolve', s.cookie, { id: 'P1', action: 'accept' })).status, 403)
  } finally {
    await s.close()
  }
})

test('fresh install: high-risk approvals wait for a code, with a reason the banner can show', async () => {
  const s = await serve()
  try {
    const r = await s.post('/api/inbox/resolve', s.cookie, { id: 'P2', action: 'accept' })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).error.code, 'APPROVAL_CODE_NOT_SET')
    assert.equal((await s.post('/api/inbox/resolve', s.cookie, { id: 'P5', action: 'accept' })).status, 200)
  } finally {
    await s.close()
  }
})

test('every spelling of a gated path is the gated route; other paths are not', () => {
  for (const path of ['/api/apple/send/', '/api/apple//send', '/api/apple/send?x=1', '/api//apple/send///', '/api/apple/./send', '/api/x/../apple/send', '/api/apple\\send']) {
    assert.equal(normalizeApiPath(path), '/api/apple/send', path)
    assert.equal(approvalRouteFor('POST', path)?.path, '/api/apple/send', path)
  }
  assert.equal(approvalRouteFor('GET', '/api/apple/send'), null)
  assert.equal(approvalRouteFor('POST', '/api/apple/sendx'), null)
  assert.equal(approvalRouteFor('POST', '/api/recs//r1/decision/')?.path, '/api/recs/:id/decision')
  assert.equal(approvalRouteFor('POST', '/api/recs/r1/outcome')?.path, '/api/recs/:id/decision')
  assert.equal(approvalRouteFor('POST', '/api/recs'), null)
  assert.equal(normalizeApiPath('/'), '/')
})

test('inbox risk: what leaves his own data or runs code is high; unknown kinds are high', () => {
  for (const kind of ['email', 'imessage', 'prompt', 'command', 'github', 'agent', 'sheet', 'something-new']) {
    assert.equal(inboxApprovalRisk({ kind, meta: {} }, 'accept'), 'high', kind)
  }
  // A LinkedIn card's accept sends nothing: it records that the owner did it himself.
  for (const kind of ['todo', 'calendar', 'goal', 'linkedin']) assert.equal(inboxApprovalRisk({ kind, meta: {} }, 'accept'), 'low', kind)
  assert.equal(inboxApprovalRisk({ kind: 'todo', meta: { sync: 'github' } }, 'accept'), 'high')
  assert.equal(inboxApprovalRisk({ kind: 'todo', meta: { sync: 'local' } }, 'accept'), 'low')
  assert.equal(inboxApprovalRisk({ kind: 'email', meta: {} }, 'draft'), 'high')
  assert.equal(inboxApprovalRisk({ kind: 'email', meta: {} }, 'deny'), 'low')
  assert.equal(inboxApprovalRisk(null, 'accept'), 'high')
})

test('bridge applies the approval table right after the API gate, with the session never the bearer', () => {
  const gate = bridge.indexOf('// ---- Web dashboard API')
  assert.notEqual(gate, -1)
  const head = bridge.slice(gate, gate + 1400)
  assert.match(head, /const path = normalizeApiPath\(req\.url\)/)
  assert.match(head, /const approvalRoute = approvalRouteFor\(req\.method, path\)/)
  assert.match(head, /req\.approvedBy = await approveRequest\(req, approvalRoute\.risk === 'per-item' \? 'low' : approvalRoute\.risk\)/)
  assert.ok(head.indexOf('approvalRouteFor') < head.indexOf('todoHttpHandler'), 'checked before any handler runs')
  assert.match(bridge, /function approveRequest\(req, risk\) \{\n {2}return approvalCode\.check\(req, \{ risk, hasSession: ownerAuth\.hasSession\(req\) \}\)/)
})

test('bridge: inbox resolve gates each proposal, and every route in the table exists', () => {
  const start = bridge.indexOf("path === '/api/inbox/resolve'")
  assert.match(bridge.slice(start, start + 900), /authorize: \(item\) => \(req\.approvedBy === 'code' \|\| inboxApprovalRisk\(item, action\) === 'low'\s*\? req\.approvedBy\s*: approveRequest\(req, 'high'\)\)/)
  const resolve = bridge.slice(bridge.indexOf('async function doResolveInboxItem('), bridge.indexOf('function redactArg('))
  assert.ok(resolve.indexOf('await authorize(item)') < resolve.indexOf('actionInboxItem(item'), 'the gate runs before the side effect')
  const recs = readFileSync(join(import.meta.dirname, '..', 'recs', 'http.mjs'), 'utf8')
  const away = readFileSync(join(import.meta.dirname, '..', 'away', 'http.mjs'), 'utf8')
  for (const route of APPROVAL_ROUTES) {
    if (route.path.startsWith('/api/away')) {
      assert.match(away, route.pattern ? new RegExp(`req\\.method === '${route.method}'`) : /path === '\/api\/away'/, `${route.method} ${route.path}`)
      continue
    }
    if (route.pattern) { assert.match(recs, /\(decision\|outcome\)\$\/\.exec\(path\)/, route.path); continue }
    const sub = route.path.replace('/api/apple/', '')
    assert.ok(bridge.includes(`'${route.path}'`) || bridge.includes(`sub === '${sub}'`), route.path)
  }
})

test('bridge: only the gated inbox route claims the dashboard as its approver', () => {
  // A new route passing approvedVia 'dashboard' would skip the gate: add it to the table.
  assert.equal(bridge.match(/approvedVia: 'dashboard'/g).length, 1)
  assert.equal(bridge.match(/approvalController\.approveSession\(/g).length, 1)
  assert.equal(bridge.match(/await apple\.send\(\{ chat: body/g).length, 1)
})
