import assert from 'node:assert/strict'
import test from 'node:test'
import { createCliproxyClient } from './client.mjs'
import { createCliproxyManager } from './manage.mjs'
import { createCliproxyHttpHandler } from './http.mjs'

const now = Date.UTC(2026, 10, 6)
function harness(status = 200) {
  const calls = []
  const client = createCliproxyClient({ url: () => 'http://proxy.example.net', key: () => 'test-key', fetch: async (url, init) => {
    const u = new URL(url); calls.push({ path: u.pathname, query: u.search, method: init.method })
    if (u.pathname.endsWith('/credentials')) return Response.json({ files: [{ name: 'a.json', provider: 'claude', auth_index: 'idx' }] })
    return Response.json(status === 200 ? { samples: [{ t: now - 100, auth_index: 'idx', provider: 'claude', windows: { five_hour: { used: 78 }, seven_day: { used: 100 } }, token: 'SECRET' }] } : { error: status === 403 ? 'scoped key: route not allowed' : 'no history' }, { status })
  } })
  const manager = createCliproxyManager({ client, now: () => now })
  return { manager, calls, handler: createCliproxyHttpHandler({ manager, configured: () => true }) }
}

test('authenticated history adapter returns allowlisted data using a fixed history range', async () => {
  const { handler, calls } = harness()
  let result
  const url = new URL('http://totem.example/api/cliproxy/history?hours=99999&auth_index=untrusted')
  const handled = await handler({ method: 'GET' }, { writeHead: (status) => assert.equal(status, 200), end: (body) => { result = JSON.parse(body) } }, url, url.pathname)
  assert.equal(handled, true)
  assert.equal(result.samples[0].accountId, 'claude:proxy:a.json')
  assert.doesNotMatch(JSON.stringify(result), /SECRET|test-key|auth_index/)
  assert.deepEqual(calls[0], { path: '/v8/management/quota/history', query: '?hours=504', method: 'GET' })
})

test('old proxies report unsupported history; scope refusals remain actionable', async () => {
  assert.deepEqual(await harness(404).manager.history(), { supported: false, samples: [] })
  await assert.rejects(harness(403).manager.history(), (e) => e.code === 'scope_refused')
})
