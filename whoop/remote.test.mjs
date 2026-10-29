// The owner's WHOOP read through Bushido: what goes over the wire, what comes
// back, and what a failure looks like to the sleep sync and the dashboard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteWhoopClient, WhoopError } from './remote.mjs'

function fakeBushido(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, auth: init.headers.authorization, ...body })
    const { status = 200, json } = await handler(body)
    return { ok: status < 400, status, json: async () => json }
  }
  return { calls, fetchImpl }
}

const night = { id: 's1', updatedAt: '2026-10-14T12:00:00Z', date: '2026-10-13', wakeDate: '2026-10-14', value: 91, parts: { deep: 90 }, stats: { recovery: 72 }, window: null, totalMin: 420 }

test('sleepNights runs on Bushido with the token and the window', async () => {
  const b = fakeBushido(() => ({ json: { result: [night, null] } }))
  const whoop = createRemoteWhoopClient({ url: 'http://127.0.0.1:8099/', token: 'tok', fetchImpl: b.fetchImpl })
  assert.equal(whoop.configured(), true)
  const nights = await whoop.sleepNights({ start: '2026-10-10T00:00:00Z', end: '2026-10-15T00:00:00Z', value: 'performance' })
  assert.deepEqual(nights, [night])
  assert.equal(b.calls[0].url, 'http://127.0.0.1:8099/api/whoop/owner')
  assert.equal(b.calls[0].auth, 'Bearer tok')
  assert.equal(b.calls[0].method, 'sleepNights')
  assert.deepEqual(b.calls[0].args, [{ start: '2026-10-10T00:00:00Z', end: '2026-10-15T00:00:00Z', value: 'performance' }])
})

test('a sleepNights answer that is not a list is an error, not zero nights', async () => {
  const b = fakeBushido(() => ({ json: { result: { nights: [] } } }))
  const whoop = createRemoteWhoopClient({ url: 'http://b', token: 't', fetchImpl: b.fetchImpl })
  await assert.rejects(whoop.sleepNights({}), WhoopError)
})

test('an error from Bushido keeps its message and flags', async () => {
  const b = fakeBushido(() => ({ status: 502, json: { error: 'reconnect WHOOP to grant read:recovery', needsReauth: true, missingScope: 'read:recovery' } }))
  const whoop = createRemoteWhoopClient({ url: 'http://b', token: 't', fetchImpl: b.fetchImpl })
  await assert.rejects(whoop.sleepNights({}), (e) => {
    assert.ok(e instanceof WhoopError)
    assert.equal(e.message, 'reconnect WHOOP to grant read:recovery')
    assert.equal(e.status, 502)
    assert.equal(e.needsReauth, true)
    assert.equal(e.missingScope, 'read:recovery')
    return true
  })
})

test('a rate limit is a rate limit', async () => {
  const b = fakeBushido(() => ({ status: 429, json: { error: 'slow down' } }))
  const whoop = createRemoteWhoopClient({ url: 'http://b', token: 't', fetchImpl: b.fetchImpl })
  await assert.rejects(whoop.sleepNights({}), (e) => e.rateLimited === true)
})

test('Bushido without a WHOOP app says so', async () => {
  const b = fakeBushido(() => ({ status: 409, json: { error: 'WHOOP is not set up in Bushido' } }))
  const whoop = createRemoteWhoopClient({ url: 'http://b', token: 't', fetchImpl: b.fetchImpl })
  const s = await whoop.status()
  assert.equal(s.state, 'unreachable')
  assert.match(s.detail, /not set up in Bushido/)
})

test('unset, it says how to set it rather than calling anything', async () => {
  const b = fakeBushido(() => ({ json: {} }))
  const whoop = createRemoteWhoopClient({ url: '', token: '', fetchImpl: b.fetchImpl })
  assert.equal(whoop.configured(), false)
  assert.equal((await whoop.status()).state, 'unconfigured')
  await assert.rejects(whoop.sleepNights({}), /BUSHIDO_API_TOKEN/)
  assert.equal(b.calls.length, 0)
})

test('status passes Bushido\'s through, marked as Bushido\'s', async () => {
  const b = fakeBushido(() => ({ json: { result: { configured: true, connected: true, needsReauth: true, state: 'needs-reauth', detail: 'WHOOP rejected the saved grant.', scopes: ['read:sleep'], missingScopes: [] } } }))
  const whoop = createRemoteWhoopClient({ url: 'http://127.0.0.1:8099', publicUrl: 'https://bushido.example.com', token: 't', fetchImpl: b.fetchImpl })
  const s = await whoop.status()
  assert.equal(s.state, 'needs-reauth')
  assert.equal(s.source, 'bushido')
  assert.equal(s.bushidoUrl, 'https://bushido.example.com')
  assert.match(s.detail, /Connect it in Bushido/)
  assert.deepEqual(s.scopes, ['read:sleep'])
})

test('status links to the address the owner opens, and reports Bushido being down', async () => {
  const whoop = createRemoteWhoopClient({ url: 'http://127.0.0.1:8099', publicUrl: 'https://bushido.example.com', token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  const s = await whoop.status()
  assert.equal(s.state, 'unreachable')
  assert.equal(s.bushidoUrl, 'https://bushido.example.com')
  assert.match(s.detail, /ECONNREFUSED/)
})
