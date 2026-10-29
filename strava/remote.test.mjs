// The owner's Strava read through Bushido: what goes over the wire, what comes
// back, and what a failure looks like to the dashboard and the agents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteStravaClient, StravaError } from './remote.mjs'

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

test('a method runs on Bushido with the token, and its result comes back', async () => {
  const b = fakeBushido(({ method, args }) => ({ json: { result: { method, args } } }))
  const strava = createRemoteStravaClient({ url: 'http://127.0.0.1:8099/', token: 'tok', fetchImpl: b.fetchImpl })
  assert.equal(strava.configured(), true)
  assert.deepEqual(await strava.activity('42', { laps: true }), { method: 'activity', args: ['42', { laps: true }] })
  assert.equal(b.calls[0].url, 'http://127.0.0.1:8099/api/strava/owner')
  assert.equal(b.calls[0].auth, 'Bearer tok')
})

test('a StravaError from Bushido keeps its message and flags', async () => {
  const b = fakeBushido(() => ({ status: 502, json: { error: 'reconnect to grant activity:write', needsReauth: true, missingScope: 'activity:write' } }))
  const strava = createRemoteStravaClient({ url: 'http://b', token: 't', fetchImpl: b.fetchImpl })
  await assert.rejects(strava.updateActivity('1', { name: 'x' }), (e) => {
    assert.ok(e instanceof StravaError)
    assert.equal(e.message, 'reconnect to grant activity:write')
    assert.equal(e.needsReauth, true)
    assert.equal(e.missingScope, 'activity:write')
    return true
  })
})

test('a rate limit is a rate limit', async () => {
  const b = fakeBushido(() => ({ status: 429, json: { error: 'slow down' } }))
  const strava = createRemoteStravaClient({ url: 'http://b', token: 't', fetchImpl: b.fetchImpl })
  await assert.rejects(strava.athlete(), (e) => e.rateLimited === true)
})

test('the mirror is read once a minute, and a sync clears it', async () => {
  let t = 0
  const b = fakeBushido(({ method }) => ({ json: { result: method === 'readCache' ? { updatedAt: String(t) } : { added: 1 } } }))
  const strava = createRemoteStravaClient({ url: 'http://b', token: 't', fetchImpl: b.fetchImpl, now: () => t })
  await strava.readCache()
  t = 30_000
  await strava.readCache()
  assert.equal(b.calls.filter((c) => c.method === 'readCache').length, 1)
  await strava.sync()
  await strava.readCache()
  assert.equal(b.calls.filter((c) => c.method === 'readCache').length, 2)
  t = 200_000
  await strava.readCache()
  assert.equal(b.calls.filter((c) => c.method === 'readCache').length, 3)
})

test('unset, it says how to set it rather than calling anything', async () => {
  const b = fakeBushido(() => ({ json: {} }))
  const strava = createRemoteStravaClient({ url: '', token: '', fetchImpl: b.fetchImpl })
  assert.equal(strava.configured(), false)
  assert.equal((await strava.status()).state, 'unconfigured')
  await assert.rejects(strava.activities({}), /BUSHIDO_API_TOKEN/)
  assert.equal(b.calls.length, 0)
})

test('status links to the address the owner opens, and reports Bushido being down', async () => {
  const strava = createRemoteStravaClient({ url: 'http://127.0.0.1:8099', publicUrl: 'https://bushido.example.com', token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  const s = await strava.status()
  assert.equal(s.state, 'unreachable')
  assert.equal(s.bushidoUrl, 'https://bushido.example.com')
  assert.match(s.detail, /ECONNREFUSED/)
})
