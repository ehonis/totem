import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliproxyClient } from './client.mjs'
import { checkCallback, createCliproxyManager } from './manage.mjs'
import { grantBlocker, parseGrantStatus, pickGrant } from './grants.mjs'

const ORG = '0f0e0d0c-0b0a-4908-8706-050403020100'
const CREDS = [
  { name: 'claude-a.json', provider: 'claude', auth_index: 'idxA', email: 'a@example.com', cooldowns: [{ scope: 'credential', remaining_seconds: 60 }] },
  { name: 'codex-b.json', provider: 'codex', auth_index: 'idxB', email: 'b@example.com', id_token: { chatgpt_account_id: 'acct-1' } },
  { name: 'gemini.json', provider: 'gemini', auth_index: 'idxG' },
]

function harness(upstream = () => ({ status_code: 200, body: {} }), { files = CREDS } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const u = new URL(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body })
    const reply = (json, status = 200) => new Response(JSON.stringify(json), { status })
    if (u.pathname.endsWith('/credentials') && init.method === 'GET') return reply({ files })
    if (u.pathname.endsWith('/requests/api-call')) return reply(await upstream(body))
    if (u.pathname.endsWith('/oauth/auth-url')) return reply({ url: 'https://claude.ai/oauth/authorize?x=1', state: 'st-1' })
    if (u.pathname.endsWith('/oauth/status')) return reply({ status: 'ok' })
    return reply({ status: 'ok' })
  }
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => 'k', fetch })
  return { calls, client }
}

test('a login is resolved from the proxy list; the request cannot pick the auth index', async () => {
  const { calls, client } = harness()
  const manager = createCliproxyManager({ client })
  await manager.setDisabled({ name: 'claude-a.json', disabled: true, auth_index: 'someone-else', url: 'https://example.com' })
  const patch = calls.find((c) => c.method === 'PATCH')
  assert.deepEqual(patch.body, { name: 'claude-a.json', disabled: true, auth_index: 'idxA' })
  await assert.rejects(manager.setDisabled({ name: 'nope.json', disabled: true }), /No such login/)
  await assert.rejects(manager.setDisabled({ name: 'gemini.json', disabled: true }), /Claude and Codex/)
  await assert.rejects(manager.patchFields({ name: 'claude-a.json', proxy_url: 'socks5://x' }), /nothing to change/)
  await assert.rejects(manager.patchFields({ name: 'claude-a.json', websockets: true }), /Codex setting/)
})

test('upstream calls are built from constants, whatever the body says', async () => {
  const urls = []
  const { client } = harness((body) => { urls.push(body.url); return { status_code: 200, body: { credits: [], available_count: 0 } } })
  const manager = createCliproxyManager({ client })
  await manager.credits({ name: 'codex-b.json', url: 'https://evil.example.com/', header: { X: 1 } })
  assert.deepEqual(urls, ['https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'])
})

test('the sign-in address must be the one Totem started', () => {
  const ok = checkCallback('http://localhost:54545/callback?code=abc&state=st-1', { provider: 'claude', state: 'st-1' })
  assert.equal(ok, 'http://localhost:54545/callback?code=abc&state=st-1')
  assert.equal(checkCallback('code=abc&state=st-1', { provider: 'claude', state: 'st-1' }), ok, 'a bare query works too')
  assert.throws(() => checkCallback('http://localhost:54545/callback?code=abc&state=other', { provider: 'claude', state: 'st-1' }), /different sign-in/)
  assert.throws(() => checkCallback('http://localhost:1455/auth/callback?code=abc&state=st-1', { provider: 'claude', state: 'st-1' }), /another sign-in/)
  assert.throws(() => checkCallback('https://evil.example.com/callback?code=abc&state=st-1', { provider: 'claude', state: 'st-1' }), /return address/)
  assert.throws(() => checkCallback('http://localhost:54545/callback?state=st-1', { provider: 'claude', state: 'st-1' }), /no sign-in code/)
})

test('sign-in: one at a time, one submit, and the address never reaches an error', async () => {
  const { calls, client } = harness()
  const manager = createCliproxyManager({ client })
  const started = await manager.startLogin({ provider: 'claude' })
  assert.equal(started.state, 'st-1')
  await assert.rejects(manager.submitCallback({ state: 'st-1', url: 'http://localhost:54545/callback?code=SECRETCODE&state=nope' }), (e) => !/SECRETCODE/.test(e.message))
  await manager.submitCallback({ state: 'st-1', url: 'http://localhost:54545/callback?code=SECRETCODE&state=st-1' })
  await assert.rejects(manager.submitCallback({ state: 'st-1', url: 'http://localhost:54545/callback?code=x&state=st-1' }), /already/)
  const posted = calls.find((c) => c.path.endsWith('/oauth/callback'))
  assert.deepEqual(posted.body, { provider: 'claude', redirect_url: 'http://localhost:54545/callback?code=SECRETCODE&state=st-1' })
  const done = await manager.loginStatus({ state: 'st-1' })
  assert.equal(done.status, 'ok')
  await assert.rejects(manager.loginStatus({ state: 'st-1' }), /ended/)
})

test('reset grants parse strictly and pick a usable one', () => {
  const block = { eligible: true, at_limit: true, next_grant_id: 'g2', grants: [{ id: 'g1', resets_total: 1, resets_left: 1, usable_now: true }, { id: 'g2', resets_total: 1, resets_left: 0, usable_now: true }] }
  const status = parseGrantStatus(block)
  assert.equal(pickGrant(status), 'g1', 'the vendor pick is spent, so the next usable')
  assert.equal(grantBlocker(status, 'g2'), 'exhausted')
  assert.equal(parseGrantStatus({ ...block, grants: [...block.grants, block.grants[0]] }), null, 'a duplicate id rejects the block')
  assert.equal(parseGrantStatus({ ...block, grants: [{ id: 'BAD ID', resets_total: 1, resets_left: 1 }] }), null)
  assert.equal(grantBlocker(parseGrantStatus({ ...block, at_limit: false }), 'g1'), 'not_limited')
})

test('a claim with no answer is retried with the same request id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cliproxy-claim-'))
  const claims = []
  let answer = null
  const { client } = harness((body) => {
    if (body.url.includes('cedar_ember')) return { status_code: 200, body: { cedar_ember: { eligible: true, at_limit: true, grants: [{ id: 'g1', resets_total: 1, resets_left: 1, usable_now: true }] } } }
    if (body.url.endsWith('/profile')) return { status_code: 200, body: { organization: { uuid: ORG } } }
    if (body.url.endsWith('/reset_rate_limits')) {
      claims.push(JSON.parse(body.data))
      assert.equal(body.url, `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`)
      return answer ? { status_code: 200, body: { result: answer } } : { status_code: 504, body: {} }
    }
    return { status_code: 404, body: {} }
  })
  const manager = createCliproxyManager({ client, stateFile: join(dir, 'cliproxy.json') })
  assert.deepEqual(await manager.claimGrant({ name: 'claude-a.json' }), { result: 'unknown', retryable: true })
  answer = 'reset'
  assert.deepEqual(await manager.claimGrant({ name: 'claude-a.json' }), { result: 'reset' })
  assert.equal(claims.length, 2)
  assert.equal(claims[0].request_id, claims[1].request_id)
  assert.equal(claims[0].grant_id, 'g1')
  // Settled: a new claim gets a new id.
  await manager.claimGrant({ name: 'claude-a.json' })
  assert.notEqual(claims[2].request_id, claims[0].request_id)
})

test('a credit spend with no answer is retried with the same redeem id, never two at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cliproxy-credit-'))
  const redeems = []
  let answer = 504
  let release
  let gate = Promise.resolve()
  const { client } = harness(async (body) => {
    if (body.url.endsWith('/rate-limit-reset-credits')) return { status_code: 200, body: { credits: [{ reset_type: 'codex_rate_limits', status: 'available', expires_at: '2099-01-01T00:00:00Z' }] } }
    if (body.url.endsWith('/consume')) {
      redeems.push(JSON.parse(body.data).redeem_request_id)
      await gate
      return { status_code: answer, body: {} }
    }
    return { status_code: 404, body: {} }
  })
  const manager = createCliproxyManager({ client, stateFile: join(dir, 'cliproxy.json') })
  assert.deepEqual(await manager.consumeCredit({ name: 'codex-b.json' }), { result: 'unknown', retryable: true })
  gate = new Promise((r) => { release = r })
  answer = 200
  const first = manager.consumeCredit({ name: 'codex-b.json' })
  await assert.rejects(manager.consumeCredit({ name: 'codex-b.json' }), /Already working/)
  release()
  assert.deepEqual(await first, { result: 'reset' })
  assert.equal(redeems.length, 2)
  assert.equal(redeems[0], redeems[1])
})

test('the tab gets full rows when the proxy stops answering', async () => {
  const fetch = async () => new Response('down', { status: 502 })
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => 'k', fetch })
  const manager = createCliproxyManager({ client, snapshot: () => ({ accounts: [{ id: 'claude:proxy:a.json', label: 'a.json', backend: 'claude', source: 'cliproxy', meters: [] }] }) })
  const out = await manager.overview()
  assert.equal(out.reachable, false)
  assert.deepEqual([out.accounts[0].name, out.accounts[0].cooldowns, out.accounts[0].recent, out.accounts[0].successCount], ['a.json', [], [], 0])
})

test('spends on two logins at once never save over each other\'s pending id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cliproxy-race-'))
  const files = [
    { name: 'codex-a.json', provider: 'codex', auth_index: 'ia', email: 'a@example.com' },
    { name: 'codex-b.json', provider: 'codex', auth_index: 'ib', email: 'b@example.com' },
  ]
  const redeems = { ia: [], ib: [] }
  let aAnswer = 504
  const { client } = harness(async (body) => {
    if (body.url.endsWith('/rate-limit-reset-credits')) return { status_code: 200, body: { credits: [{ reset_type: 'codex_rate_limits', status: 'available', expires_at: '2099-01-01T00:00:00Z' }] } }
    if (body.url.endsWith('/consume')) {
      redeems[body.authIndex].push(JSON.parse(body.data).redeem_request_id)
      return { status_code: body.authIndex === 'ia' ? aAnswer : 200, body: {} }
    }
    return { status_code: 404, body: {} }
  }, { files })
  const manager = createCliproxyManager({ client, stateFile: join(dir, 'cliproxy.json') })
  const [a, b] = await Promise.all([manager.consumeCredit({ name: 'codex-a.json' }), manager.consumeCredit({ name: 'codex-b.json' })])
  assert.equal(a.result, 'unknown')
  assert.equal(b.result, 'reset')
  aAnswer = 200
  await manager.consumeCredit({ name: 'codex-a.json' })
  assert.equal(redeems.ia[0], redeems.ia[1], 'the retry kept its id')
})

test('a refused retry keeps its pending id and says the first try may have landed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cliproxy-refused-'))
  let answer = 504
  const ids = []
  const { client } = harness(async (body) => {
    if (body.url.endsWith('/rate-limit-reset-credits')) return { status_code: 200, body: { credits: [{ reset_type: 'codex_rate_limits', status: 'available', expires_at: '2099-01-01T00:00:00Z' }] } }
    if (body.url.endsWith('/consume')) { ids.push(JSON.parse(body.data).redeem_request_id); return { status_code: answer, body: {} } }
    return { status_code: 404, body: {} }
  })
  const manager = createCliproxyManager({ client, stateFile: join(dir, 'cliproxy.json') })
  await manager.consumeCredit({ name: 'codex-b.json' })
  answer = 409
  await assert.rejects(manager.consumeCredit({ name: 'codex-b.json' }), /may have gone through/)
  answer = 200
  await manager.consumeCredit({ name: 'codex-b.json' })
  assert.equal(new Set(ids).size, 1)
})

test('signing in again names the login whose token was rewritten, not the one serving', async () => {
  let files = [
    { name: 'claude-a.json', provider: 'claude', auth_index: 'ia', email: 'a@example.com', last_refresh: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T10:00:00Z' },
    { name: 'claude-b.json', provider: 'claude', auth_index: 'ib', email: 'b@example.com', last_refresh: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T09:00:00Z' },
  ]
  const fetch = async (url, init) => {
    const u = new URL(url)
    const reply = (json) => new Response(JSON.stringify(json))
    if (u.pathname.endsWith('/credentials')) return reply({ files })
    if (u.pathname.endsWith('/oauth/auth-url')) return reply({ url: 'https://claude.ai/oauth/authorize', state: 'st-9' })
    if (u.pathname.endsWith('/oauth/status')) return reply({ status: 'ok' })
    return reply({ status: 'ok' })
  }
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => 'k', fetch })
  const manager = createCliproxyManager({ client })
  await manager.startLogin({ provider: 'claude' })
  // b is signed in again; a keeps serving, so its updated_at is the newest.
  files = [{ ...files[0], updated_at: '2026-11-06T11:00:00Z' }, { ...files[1], last_refresh: '2026-11-06T10:30:00Z' }]
  const done = await manager.loginStatus({ state: 'st-9' })
  assert.equal(done.updated, 'b@example.com')
  assert.equal(done.added, null)
})
