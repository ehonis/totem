import assert from 'node:assert/strict'
import test from 'node:test'
import { createCliproxyClient, upstreamAllowed } from './client.mjs'
import { classifyStatus, claudePlanFromProfile, createCliproxySource, proxyAccountId } from './source.mjs'
import { metersFromSignals, metersFromWham } from './quota.mjs'
import { annotateAccount, buildPools } from '../ai-usage/pools.mjs'
import { Poller } from '../ai-usage/poller.mjs'

const T0 = Date.UTC(2026, 10, 6, 3, 0, 0)
const sec = (ms) => String(Math.floor(ms / 1000))

function claudeCred(name, { util5 = 0.4, util7 = 0.1, status5 = 'allowed', reset5 = T0 + 2 * 3600e3, observed = T0 - 60e3, ...extra } = {}) {
  return {
    name, id: name, provider: 'claude', auth_index: `a${name.length}${name.charCodeAt(0)}`, email: `${name}@example.com`,
    status: 'active', disabled: false,
    quota: {
      observed_at: new Date(observed).toISOString(),
      signals: {
        'Anthropic-Ratelimit-Unified-5h-Utilization': String(util5),
        'Anthropic-Ratelimit-Unified-5h-Status': status5,
        'Anthropic-Ratelimit-Unified-5h-Reset': sec(reset5),
        'Anthropic-Ratelimit-Unified-7d-Utilization': String(util7),
        'Anthropic-Ratelimit-Unified-7d-Status': 'allowed',
        'Anthropic-Ratelimit-Unified-7d-Reset': sec(T0 + 4 * 86400e3),
      },
    },
    recent_requests: [{ success: 0 }, { success: 3 }],
    ...extra,
  }
}

function fakeFetch(handlers) {
  const calls = []
  const fn = async (url, init) => {
    const u = new URL(url)
    calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization })
    const handler = handlers[`${init.method} ${u.pathname}`]
    if (!handler) return new Response(JSON.stringify({ error: 'nope' }), { status: 404 })
    const { __status = 200, ...out } = await handler(init.body ? JSON.parse(init.body) : null, u)
    return new Response(JSON.stringify(out), { status: __status })
  }
  return { fn, calls }
}

function setup(handlers, { now = () => T0 } = {}) {
  const fetch = fakeFetch(handlers)
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net:8317/', key: () => 'mgmt-key-123', fetch: fetch.fn })
  const source = createCliproxySource({ client, now })
  return { client, source, calls: fetch.calls }
}

test('upstream calls only go to the vendor usage and reset URLs', async () => {
  assert.equal(upstreamAllowed('https://api.anthropic.com/api/oauth/usage'), true)
  assert.equal(upstreamAllowed('https://chatgpt.com/backend-api/wham/usage'), true)
  assert.equal(upstreamAllowed('https://api.anthropic.com.example.com/api/oauth/usage'), false)
  assert.equal(upstreamAllowed('https://api.anthropic.com/api/oauth/usage/../../x'), false)
  assert.equal(upstreamAllowed('http://api.anthropic.com/api/oauth/usage'), false)
  const { client, calls } = setup({})
  await assert.rejects(client.upstream('abc', { url: 'https://example.com/steal' }), /not an allowed upstream URL/)
  assert.equal(calls.length, 0, 'refused before the proxy is asked')
})

test('the management key never appears in an error', async () => {
  const fetch = async () => new Response(JSON.stringify({ error: 'bad key mgmt-key-123 rejected' }), { status: 401 })
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => 'mgmt-key-123', fetch })
  const err = await client.request('GET', '/credentials').catch((e) => e)
  assert.equal(err.code, 'bad_key')
  assert.doesNotMatch(err.message, /mgmt-key-123/)
})

test('passive signals become meters; a rejected window is spent; a past reset has refilled', () => {
  const meters = metersFromSignals('claude', claudeCred('x', { util5: 0.97, status5: 'rejected' }).quota.signals)
  assert.equal(meters[0].usedPct, 100)
  assert.equal(meters[0].windowMinutes, 300)
  assert.equal(meters[1].label, '7-day limit')
  const codex = metersFromSignals('codex', { 'X-Codex-Primary-Used-Percent': '100', 'X-Codex-Primary-Window-Minutes': '300', 'X-Codex-Primary-Reset-At': sec(T0 + 3600e3), 'X-Codex-Secondary-Used-Percent': '39', 'X-Codex-Secondary-Window-Minutes': '10080' })
  assert.deepEqual(codex.map((m) => [m.key, m.usedPct, m.label]), [['primary', 100, '5-hour limit'], ['secondary', 39, '7-day limit']])
  const wham = metersFromWham({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1793937737 }, secondary_window: { used_percent: 39, limit_window_seconds: 604800 } } })
  assert.deepEqual(wham.map((m) => [m.windowMinutes, m.remainingPct]), [[300, 80], [10080, 61]])
})

test('status messages are classified, not echoed', () => {
  assert.equal(classifyStatus({ status: 'error', status_message: '{"status":429,"error":{"type":"usage_limit_reached"}}', next_retry_after: new Date(Date.now() + 60e3).toISOString() }).kind, 'limited')
  assert.equal(classifyStatus({ status: 'error', status_message: '{"status":401,"error":{"message":"token expired sk-ant-abc"}}' }).kind, 'auth')
  assert.equal(classifyStatus({ status: 'error', status_message: 'invalid_grant' }).kind, 'auth')
  assert.equal(classifyStatus({ status: 'active', status_message: '' }).kind, 'ok')
  assert.doesNotMatch(JSON.stringify(classifyStatus({ status: 'error', status_message: '{"status":500,"error":{"message":"secret"}}' })), /secret/)
})

test('plan labels from the Claude profile', () => {
  assert.equal(claudePlanFromProfile({ account: { has_claude_max: true }, organization: { rate_limit_tier: 'default_claude_max_20x' } }), 'Max 20x')
  assert.equal(claudePlanFromProfile({ account: { has_claude_pro: true, has_claude_max: false } }), 'Pro')
  assert.equal(claudePlanFromProfile({ organization: { organization_type: 'claude_team', subscription_status: 'active' } }), 'Team')
})

test('the source reads passive first and asks the vendor only when the passive reading is old', async () => {
  let t = T0
  const fresh = claudeCred('fresh', { observed: T0 - 30e3 })
  const old = claudeCred('old', { observed: T0 - 10 * 60e3 })
  const usageCalls = []
  const { source } = setup({
    'GET /v8/management/credentials': () => ({ files: [fresh, old, { name: 'g.json', provider: 'gemini', auth_index: 'g1' }] }),
    'POST /v8/management/requests/api-call': (body) => {
      if (body.url.endsWith('/profile')) return { status_code: 200, body: { account: { has_claude_pro: true } } }
      usageCalls.push(body.authIndex)
      assert.equal(body.header.Authorization, 'Bearer $TOKEN$')
      return { status_code: 200, body: { limits: [{ kind: 'session', percent: 50, resets_at: new Date(T0 + 3600e3).toISOString() }, { kind: 'weekly_all', percent: 5 }] } }
    },
  }, { now: () => t })

  const first = await source.read({ watched: true })
  assert.equal(first.accounts.length, 2, 'only Claude and Codex logins')
  assert.deepEqual(first.accounts.map((a) => a.id), [proxyAccountId('claude', 'fresh'), proxyAccountId('claude', 'old')])
  // First sight of each login reads it once.
  assert.equal(usageCalls.length, 2)
  const freshAccount = first.accounts[0]
  assert.equal(freshAccount.passive, false, 'the first-sight vendor reading is newer than the headers')
  assert.equal(freshAccount.plan, 'Pro')
  assert.equal(freshAccount.servingRecently, true)

  usageCalls.length = 0
  t += 30e3
  await source.read({ watched: true })
  assert.equal(usageCalls.length, 0, 'inside the 60 s floor, no vendor call')

  t += 60e3
  await source.read({ watched: true })
  assert.deepEqual(usageCalls, [old.auth_index], 'only the login whose passive reading is old')

  usageCalls.length = 0
  await source.read({ watched: true, force: true })
  assert.deepEqual(usageCalls, [fresh.auth_index], 'a forced read still waits 20 s after the last one')
  usageCalls.length = 0
  t += 20e3
  await source.read({ watched: true, force: true })
  assert.equal(usageCalls.length, 2, 'then an explicit refresh reads every login')
})

test('a proxy that stops answering keeps its last readings, stale from the second miss', async () => {
  let up = true
  const { source } = setup({
    'GET /v8/management/credentials': () => (up ? { files: [claudeCred('a')] } : { __status: 502, error: 'down' }),
    'POST /v8/management/requests/api-call': () => ({ status_code: 429, body: { error: 'slow down' } }),
  })
  assert.equal((await source.read()).accounts.length, 1)
  up = false
  let r = await source.read()
  assert.equal(r.status.reachable, false)
  assert.equal(r.accounts[0].stale, undefined)
  r = await source.read()
  assert.equal(r.accounts[0].stale, true)
  assert.equal(r.accounts.length, 1)
})

test('state and pools: a weekly-spent account is limited even with a fresh 5-hour window', () => {
  const now = T0
  const ok = annotateAccount({ id: 'claude:proxy:a', backend: 'claude', status: 'ok', meters: [{ key: 'session:', remainingPct: 64, resetsAt: now + 3600e3 }, { key: 'weekly_all:', remainingPct: 95 }] }, now)
  const weekly = annotateAccount({ id: 'claude:proxy:b', backend: 'claude', status: 'ok', meters: [{ key: 'session:', remainingPct: 60 }, { key: 'weekly_all:', remainingPct: 0.5, resetsAt: now + 3 * 86400e3 }, { key: 'weekly_scoped:Fable', remainingPct: 100 }] }, now)
  const off = annotateAccount({ id: 'claude:proxy:c', backend: 'claude', status: 'ok', disabled: true, meters: [] }, now)
  assert.equal(ok.state, 'ok')
  assert.equal(ok.headroomPct, 64)
  assert.equal(weekly.state, 'limited')
  assert.equal(weekly.limitedUntil, now + 3 * 86400e3)
  assert.equal(off.state, 'disabled')
  const [pool] = buildPools([ok, weekly, off])
  assert.equal(pool.total, 3)
  assert.equal(pool.usable, 1)
  assert.equal(pool.headroomPct, 64, 'the best usable account, not a mean')
  assert.equal(pool.nextBackAt, now + 3 * 86400e3)
  const cooled = annotateAccount({ id: 'x', backend: 'codex', status: 'ok', cooldownUntil: now + 600e3, meters: [{ key: 'primary', remainingPct: 50 }] }, now)
  assert.equal(cooled.state, 'limited')
})

test('the poller shows the proxy logins instead of the local ones, and never token-refreshes them', async () => {
  const local = []
  const proxy = {
    configured: () => true,
    reads: [],
    async read(opts) {
      this.reads.push(opts)
      return {
        accounts: [{ id: 'claude:proxy:a.json', backend: 'claude', label: 'a.json', source: 'cliproxy', displayName: 'a@example.com', status: 'ok', meters: [{ key: 'session:', remainingPct: 40 }] }],
        status: { configured: true, reachable: true },
        backends: new Set(['claude']),
      }
    },
  }
  const poller = new Poller({
    proxy,
    fetchAccount: async (a) => { local.push(a.id); return { id: a.id, backend: a.backend, label: a.label, status: 'ok', meters: [] } },
  })
  poller.config = { pollIntervalSeconds: 90, accountNames: { 'claude:proxy:a.json': 'Work' } }
  poller.accounts = [
    { id: 'claude:claude-default', backend: 'claude', label: 'claude-default' },
    { id: 'cursor:cursor-default', backend: 'cursor', label: 'cursor-default' },
  ]
  await poller.poll()
  assert.deepEqual(local, ['cursor:cursor-default'], 'the local Claude login is not read')
  assert.deepEqual(poller.snapshot.accounts.map((a) => a.id), ['claude:proxy:a.json', 'cursor:cursor-default'])
  assert.equal(poller.snapshot.accounts[0].displayName, 'Work')
  assert.equal(poller.snapshot.pools.find((p) => p.backend === 'claude').headroomPct, 40)
  assert.equal(poller.snapshot.proxy.reachable, true)

  await poller.refreshCredentials()
  assert.equal(proxy.reads.at(-2).force, true, 'Refresh asks for a fresh reading, not a token refresh')

  // A use of Claude re-reads the proxy list only.
  local.length = 0
  await poller.pollBackend('claude')
  assert.deepEqual(local, [])
})

test('a login the proxy is cooling down is limited, not failing', () => {
  assert.equal(classifyStatus({ status: 'error', status_message: '', cooldowns: [{ scope: 'credential', remaining_seconds: 600 }] }).kind, 'limited')
  assert.equal(classifyStatus({ status: 'error', status_message: '', next_retry_after: new Date(Date.now() + 60e3).toISOString() }).kind, 'limited')
})

test('a failed vendor read keeps its meters at their own time, so newer passive headers win', async () => {
  let t = T0
  let fail = false
  let signals = claudeCred('a', { util5: 0.1, observed: T0 - 30 * 60e3 })
  const { source } = setup({
    'GET /v8/management/credentials': () => ({ files: [signals] }),
    'POST /v8/management/requests/api-call': (body) => {
      if (body.url.endsWith('/profile')) return { status_code: 200, body: {} }
      if (fail) return { status_code: 429, body: { error: 'slow down' } }
      return { status_code: 200, body: { limits: [{ kind: 'session', percent: 10 }] } }
    },
  }, { now: () => t })
  await source.read({ watched: true })
  t += 9 * 60e3
  signals = claudeCred('a', { util5: 0.7, observed: t })
  t += 60e3
  fail = true
  const { accounts: [a] } = await source.read({ watched: true, force: true })
  assert.equal(a.meters.find((m) => m.key === 'session:').usedPct, 70, 'the newer passive reading')
  assert.equal(a.passive, true)
})

test('an old 429 left on a recovered login is history, not a limit', () => {
  const now = Date.now()
  const msg = '{"status":429,"error":{"type":"usage_limit_reached"}}'
  assert.equal(classifyStatus({ status: 'error', status_message: msg }, now).kind, 'ok')
  assert.equal(classifyStatus({ status: 'error', status_message: msg, cooldowns: [{ scope: 'credential', remaining_seconds: 60 }] }, now).kind, 'limited')
  assert.equal(classifyStatus({ status: 'error', status_message: msg, cooldowns: [{ scope: 'model', model_key: 'x', remaining_seconds: 60 }] }, now).kind, 'ok', 'one model cooling is not the login')
  assert.equal(classifyStatus({ status: 'error', status_message: 'invalid grant (retrying)' }, now).kind, 'auth')
  assert.equal(classifyStatus({ status: 'error', status_message: 'boom', unavailable: true }, now).kind, 'error')
})

test('a refused key is not retried until it changes', async () => {
  let key = 'old-key'
  let calls = 0
  const fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: 'invalid management key' }), { status: 401 }) }
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => key, fetch })
  const source = createCliproxySource({ client })
  await source.read()
  await source.read()
  await source.read()
  assert.equal(calls, 1)
  key = 'new-key'
  await source.read()
  assert.equal(calls, 2)
})

test('a Codex usage read names the login\'s ChatGPT workspace', async () => {
  const headers = []
  const { source } = setup({
    'GET /v8/management/credentials': () => ({ files: [{ name: 'c.json', provider: 'codex', auth_index: 'c1', id_token: { chatgpt_account_id: 'acct-42' } }] }),
    'POST /v8/management/requests/api-call': (body) => { headers.push(body.header); return { status_code: 200, body: { plan_type: 'team', rate_limit: {} } } },
  })
  await source.read()
  assert.equal(headers[0]['Chatgpt-Account-Id'], 'acct-42')
})

test('hidden proxy logins leave the accounts but still count in their pool', async () => {
  const proxy = {
    configured: () => true,
    async read() {
      return {
        accounts: [
          { id: 'claude:proxy:a', backend: 'claude', label: 'a', source: 'cliproxy', status: 'ok', meters: [{ key: 'session:', remainingPct: 40 }] },
          { id: 'claude:proxy:b', backend: 'claude', label: 'b', source: 'cliproxy', status: 'ok', meters: [{ key: 'session:', remainingPct: 90 }] },
        ],
        status: { configured: true, reachable: true },
        backends: new Set(['claude']),
      }
    },
  }
  const poller = new Poller({ proxy, fetchAccount: async (a) => ({ id: a.id, backend: a.backend, label: a.label, status: 'ok', meters: [] }) })
  poller.config = { pollIntervalSeconds: 90, hidden: ['claude:proxy:b'] }
  poller.accounts = []
  await poller.poll()
  assert.deepEqual(poller.snapshot.accounts.map((a) => a.id), ['claude:proxy:a'])
  assert.equal(poller.snapshot.pools[0].total, 2)
  assert.equal(poller.snapshot.pools[0].headroomPct, 90)
  poller.config = { pollIntervalSeconds: 90, providers: { claude: { hidden: true } } }
  await poller.poll()
  assert.deepEqual(poller.snapshot.accounts, [])
  assert.deepEqual(poller.snapshot.pools, [])
})

test('a refused key is not resent by any caller until it changes', async () => {
  let key = 'old-key'
  let calls = 0
  const fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: 'invalid management key' }), { status: 401 }) }
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => key, fetch })
  await assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
  await assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
  await assert.rejects(client.request('PATCH', '/credentials/status', { json: {} }), (e) => e.code === 'bad_key')
  assert.equal(calls, 1)
  key = 'new-key'
  await assert.rejects(client.request('GET', '/credentials'))
  assert.equal(calls, 2)
})

test('the last readings go stale at once when the key is refused', async () => {
  let ok = true
  const fetch = async () => (ok
    ? new Response(JSON.stringify({ files: [claudeCred('a')] }))
    : new Response(JSON.stringify({ error: 'invalid management key' }), { status: 401 }))
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => 'k', fetch })
  const source = createCliproxySource({ client })
  await source.read()
  ok = false
  const { accounts } = await source.read()
  assert.equal(accounts[0].stale, true)
})

test('only a 401 stops the key being resent; a remote-disabled 403 does not', async () => {
  let status = 403
  let calls = 0
  const fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: 'remote management disabled' }), { status }) }
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => 'k', fetch })
  await assert.rejects(client.request('GET', '/credentials'), (e) =>
    e.code !== 'bad_key' && e.upstreamStatus === 403 && /remote management disabled/.test(e.message))
  await assert.rejects(client.request('GET', '/credentials'))
  assert.equal(calls, 2)
  status = 401
  await assert.rejects(client.request('GET', '/credentials'))
  await assert.rejects(client.request('GET', '/credentials'), /Retry sends it once/)
  assert.equal(calls, 3)
  client.forgetRefusal()
  await assert.rejects(client.request('GET', '/credentials'))
  assert.equal(calls, 4)
})

test('a late refusal cannot block requests after a successful explicit retry', async () => {
  const pending = Promise.withResolvers()
  let calls = 0
  const client = createCliproxyClient({
    url: () => 'http://proxy.example.net', key: () => 'k',
    fetch: () => ++calls === 1 ? pending.promise : new Response('{"files":[]}'),
  })
  const earlier = assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
  client.forgetRefusal()
  assert.deepEqual(await client.request('GET', '/credentials'), { files: [] })
  pending.resolve(new Response('{"error":"invalid management key"}', { status: 401 }))
  await earlier
  assert.deepEqual(await client.request('GET', '/credentials'), { files: [] })
})

for (const changed of ['key', 'url']) {
  test(`a late refusal for an old ${changed} cannot replace the current refusal`, async () => {
    const pending = Promise.withResolvers()
    let key = 'old-key'
    let url = 'http://old.example.net'
    let calls = 0
    const client = createCliproxyClient({
      url: () => url, key: () => key,
      fetch: () => ++calls === 1 ? pending.promise : new Response('{"error":"invalid management key"}', { status: 401 }),
    })
    const earlier = assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
    if (changed === 'key') key = 'new-key'
    else url = 'http://new.example.net'
    await assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
    pending.resolve(new Response('{"error":"invalid management key"}', { status: 401 }))
    await earlier
    await assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
    assert.equal(calls, 2, 'the current refused configuration stays blocked')
  })
}

test('a success from before Retry cannot clear a later refusal', async () => {
  const pending = Promise.withResolvers()
  let calls = 0
  const client = createCliproxyClient({
    url: () => 'http://proxy.example.net', key: () => 'k',
    fetch: () => ++calls === 1 ? pending.promise : new Response('{"error":"invalid management key"}', { status: 401 }),
  })
  const earlier = client.request('GET', '/credentials')
  client.forgetRefusal()
  await assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
  pending.resolve(new Response('{"files":[]}'))
  await earlier
  await assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
  assert.equal(calls, 2, 'the obsolete success does not allow another refused call')
})

test('a delayed successful body cannot clear a newer refusal without Retry', async () => {
  const reading = Promise.withResolvers()
  let body
  const stream = new ReadableStream({
    start(controller) { body = controller },
    pull() { reading.resolve() },
  }, { highWaterMark: 0 })
  let calls = 0
  const client = createCliproxyClient({
    url: () => 'http://proxy.example.net', key: () => 'k',
    fetch: () => ++calls === 1 ? new Response(stream) : new Response('{"error":"invalid management key"}', { status: 401 }),
  })
  const earlier = client.request('GET', '/credentials')
  await reading.promise
  await assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
  body.enqueue(new TextEncoder().encode('{"files":[]}'))
  body.close()
  assert.deepEqual(await earlier, { files: [] })
  await assert.rejects(client.request('GET', '/credentials'), (e) => e.code === 'bad_key')
  assert.equal(calls, 2, 'the older successful response cannot resend a revoked key')
})

test('every login of a hidden service still reaches the CLIProxy tab, with its state', async () => {
  const proxy = {
    configured: () => true,
    async read() {
      return {
        accounts: [{ id: 'codex:proxy:c', backend: 'codex', label: 'c', source: 'cliproxy', status: 'ok', meters: [{ key: 'primary', remainingPct: 0, usedPct: 100, resetsAt: Date.now() + 3600e3 }] }],
        status: { configured: true, reachable: true },
        backends: new Set(['codex']),
      }
    },
  }
  const poller = new Poller({ proxy, fetchAccount: async (a) => ({ id: a.id, backend: a.backend, label: a.label, status: 'ok', meters: [] }) })
  poller.config = { pollIntervalSeconds: 90, providers: { codex: { hidden: true } } }
  poller.accounts = []
  await poller.poll()
  assert.deepEqual(poller.snapshot.accounts, [])
  assert.equal(poller.proxyAnnotated[0].state, 'limited')
})

test('fresh active readings are recorded once in proxy history; unavailable history does not break quota', async () => {
  const recorded = []
  let at = T0
  const { source } = setup({
    'GET /v8/management/credentials': () => ({ files: [claudeCred('a')] }),
    'POST /v8/management/requests/api-call': (body) => body.url.endsWith('/profile')
      ? { status_code: 200, body: {} }
      : { status_code: 200, body: { limits: [{ kind: 'session', percent: 22, resets_at: new Date(T0 + 3600e3).toISOString() }, { kind: 'weekly_all', percent: 100 }] } },
    'POST /v8/management/quota/history': (body) => { recorded.push(body); return { __status: 404 } },
  }, { now: () => at })
  const first = await source.read({ watched: true })
  await source.read({ watched: true })
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].auth_index, 'a197')
  assert.equal(recorded[0].windows.five_hour.used, 22)
  assert.equal(recorded[0].windows.seven_day.used, 100)
  assert.equal(first.accounts[0].meters[0].remainingPct, 78)
  assert.equal(first.accounts[0].activeError, null)
  at += 11 * 60_000
  await source.read({ watched: true })
  assert.equal(recorded.length, 2, 'history support is rechecked after a temporary failure')
})

test('Team seats retain the rate-limit tier multiplier for pooled graphs', async () => {
  const { source } = setup({
    'GET /v8/management/credentials': () => ({ files: [claudeCred('team')] }),
    'POST /v8/management/requests/api-call': (body) => body.url.endsWith('/profile')
      ? { status_code: 200, body: { organization: { organization_type: 'claude_team', rate_limit_tier: 'default_claude_max_5x' } } }
      : { status_code: 200, body: { limits: [{ kind: 'session', percent: 20 }] } },
  })
  const result = await source.read()
  assert.equal(result.accounts[0].plan, 'Team')
  assert.equal(result.accounts[0].planSize, 5)
})

test('synthetic refills retain the original reading and reset for quota history', async () => {
  let time = T0
  let failed = false
  const reset = T0 + 3600_000
  const { source } = setup({
    'GET /v8/management/credentials': () => ({ files: [{ name: 'a', provider: 'claude', auth_index: 'idx' }] }),
    'POST /v8/management/requests/api-call': (body) => {
      if (body.url.endsWith('/profile')) return { status_code: 200, body: {} }
      if (failed) throw new Error('unavailable')
      return { status_code: 200, body: { limits: [{ kind: 'weekly_all', percent: 100, resets_at: new Date(reset).toISOString() }] } }
    },
  }, { now: () => time })
  await source.read()
  time += 2 * 3600_000
  failed = true
  const { accounts } = await source.read()
  assert.equal(accounts[0].fetchedAt, T0)
  assert.equal(accounts[0].meters[0].remainingPct, 100)
  assert.deepEqual(accounts[0].meters[0].beforeRefill, { remainingPct: 0, resetsAt: reset })
})
