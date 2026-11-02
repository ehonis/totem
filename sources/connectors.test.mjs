// Connectors wired to the run log end to end, every external API a fake.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createSourceRuns } from './store.mjs'
import { createRemoteStravaClient } from '../strava/remote.mjs'
import { createRemoteWhoopClient } from '../whoop/remote.mjs'
import { createGmail } from '../gmail/index.mjs'

const T0 = Date.parse('2026-10-30T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

function clock(start = T0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

// Bushido answering `{ method, args }` with whatever `answer(method)` says.
function bushido(answer) {
  return async (_url, init) => {
    const { method } = JSON.parse(init.body)
    const out = await answer(method)
    if (out instanceof Error) throw out
    return { ok: out.ok !== false, status: out.status ?? 200, json: async () => out.body }
  }
}

test('Strava: a dead grant is failing even while Bushido\'s cache and status calls answer', async () => {
  const c = clock()
  const told = []
  const runs = createSourceRuns({ file: ':memory:', now: c.now, onFailing: async (h) => { told.push(h) } })
  const fetchImpl = bushido((method) => {
    if (method === 'sync') return { ok: false, status: 502, body: { error: 'Strava rejected the token: reconnect', status: 401, needsReauth: true } }
    if (method === 'status') return { body: { result: { state: 'needs-reauth', detail: 'Reconnect Strava.' } } }
    return { body: { result: { version: 1, activities: { a: {} } } } }
  })
  const strava = createRemoteStravaClient({ url: 'http://bushido.test', token: 't', fetchImpl, runs, now: c.now })
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(strava.sync())
    await strava.readCache()
    await strava.cachedList()
    await strava.status()
    c.advance(3 * HOUR)
    await settle()
  }
  const h = runs.get('strava')
  assert.equal(h.state, 'failing')
  assert.ok(h.failures >= 5)
  assert.equal(h.lastOkAt, null, 'the cache reads never counted as the grant working')
  assert.equal(told.length, 1)
  runs.close()
})

test('Strava: the grant working again recovers it; Bushido disconnected is not set up', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  let state = 'ready'
  const fetchImpl = bushido((method) => (method === 'status'
    ? { body: { result: { state, detail: 'Not connected.' } } }
    : { body: { result: { added: 1, updated: 0, count: 240 } } }))
  const strava = createRemoteStravaClient({ url: 'http://bushido.test', token: 't', fetchImpl, runs })
  await strava.status()
  assert.equal(runs.get('strava'), null, 'a ready status says nothing on its own')
  await strava.sync()
  assert.equal(runs.get('strava').state, 'ok')
  assert.equal(runs.get('strava').rows, 240)
  state = 'disconnected'
  await strava.status()
  assert.equal(runs.get('strava').state, 'unconfigured')
  runs.close()
})

test('Strava: an unreachable Bushido fails, its error is scrubbed, and the connector\'s own error comes through', async () => {
  const c = clock()
  const runs = createSourceRuns({ file: ':memory:', now: c.now })
  const fetchImpl = bushido(() => new Error('connect ECONNREFUSED 127.0.0.1:8790 (Authorization: Bearer bushido-token)'))
  const strava = createRemoteStravaClient({ url: 'http://bushido.test', token: 'bushido-token', fetchImpl, runs })
  for (let i = 0; i < 3; i += 1) { await assert.rejects(strava.activities(), /could not reach Bushido/); c.advance(10 * 60 * 1000) }
  const h = runs.get('strava')
  assert.equal(h.state, 'failing')
  assert.ok(!h.error.includes('bushido-token'), h.error)
  // Status still answers "unreachable" to its caller, and counts as a failed run.
  assert.equal((await strava.status()).state, 'unreachable')
  assert.equal(runs.get('strava').failures, 4)
  runs.close()
})

test('Strava unconfigured writes nothing: not set up is not failing', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  const strava = createRemoteStravaClient({ url: '', token: '', runs })
  await assert.rejects(strava.activities(), /BUSHIDO_URL/)
  assert.equal((await strava.status()).state, 'unconfigured')
  assert.deepEqual(runs.health(), [])
  runs.close()
})

test('WHOOP: a grant that needs reconnecting fails; a ready one with nights is ok', async () => {
  const c = clock()
  const runs = createSourceRuns({ file: ':memory:', now: c.now })
  let dead = true
  const fetchImpl = bushido((method) => {
    if (method === 'status') return { body: { result: { state: dead ? 'needs-reauth' : 'ready' } } }
    return dead
      ? { ok: false, status: 401, body: { error: 'WHOOP token expired', needsReauth: true } }
      : { body: { result: [{ date: '2026-10-29' }, { date: '2026-10-30' }] } }
  })
  const whoop = createRemoteWhoopClient({ url: 'http://bushido.test', token: 't', fetchImpl, runs })
  for (let i = 0; i < 3; i += 1) { await whoop.status(); await assert.rejects(whoop.sleepNights({})); c.advance(10 * 60 * 1000) }
  assert.equal(runs.get('whoop').state, 'failing')
  dead = false
  assert.equal((await whoop.sleepNights({})).length, 2)
  assert.equal(runs.get('whoop').state, 'ok')
  assert.equal(runs.get('whoop').rows, 2)
  runs.close()
})

// ---- Gmail ---------------------------------------------------------------------

function gmailHarness({ signInOk = true, messageStatus = 200 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'source-gmail-'))
  const tokensFile = join(dir, 'tokens.json')
  writeFileSync(tokensFile, JSON.stringify({ home: { refresh_token: 'r1', email: 'owner@example.com' } }))
  const state = { signInOk, messageStatus, requests: 0 }
  const fetchImpl = async (url) => {
    const u = String(url)
    state.requests += 1
    if (u.includes('oauth2.googleapis.com/token')) {
      return state.signInOk
        ? { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) }
        : { ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) }
    }
    if (/\/messages\?/.test(u)) {
      const messages = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` }))
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages, resultSizeEstimate: 8 }) }
    }
    if (state.messageStatus !== 200) {
      return { ok: false, status: state.messageStatus, text: async () => JSON.stringify({ error: { message: 'rateLimitExceeded' } }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'm', threadId: 't', payload: { headers: [] }, labelIds: [] }) }
  }
  return { tokensFile, fetchImpl, state }
}

const gmailOf = (h, runs) => createGmail({
  tokensFile: h.tokensFile, fetchImpl: h.fetchImpl, runs,
  loadClient: () => ({ installed: { client_id: 'c', client_secret: 's' } }),
  redirectUri: () => 'http://localhost/cb',
})

test('Gmail: one search that hits eight rate limits at once is one failed run, not an outage', async () => {
  const told = []
  const runs = createSourceRuns({ file: ':memory:', onFailing: async (h) => { told.push(h) } })
  const h = gmailHarness({ messageStatus: 429 })
  const gmail = gmailOf(h, runs)
  // search reports a failed account in `errors` rather than throwing.
  const failed = await gmail.search({ query: 'is:unread', account: 'home', max: 8 })
  assert.match(failed.errors.join(' '), /429/)
  await settle()
  assert.ok(h.state.requests >= 9, 'the search really fanned out')
  assert.equal(runs.get('gmail:home').failures, 1)
  assert.equal(runs.runs('gmail:home').length, 1)
  assert.equal(told.length, 0)
  h.state.messageStatus = 200
  const out = await gmail.search({ query: 'is:unread', account: 'home', max: 8 })
  assert.equal(out.messages.length, 8)
  assert.equal(runs.get('gmail:home').state, 'ok')
  assert.equal(runs.get('gmail:home').rows, 8)
  assert.equal(runs.runs('gmail:home').length, 2, 'one run per search, not one per request')
  runs.close()
})

test('Gmail: a sign-in that stopped working counts against its account', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  const h = gmailHarness({ signInOk: false })
  const gmail = gmailOf(h, runs)
  const listed = await gmail.listAccounts()
  assert.equal(listed.accounts[0].status, 'error')
  assert.equal(runs.get('gmail:home').state, 'degraded')
  assert.match(runs.get('gmail:home').error, /invalid_grant/)
  h.state.signInOk = true
  await gmail.listAccounts()
  assert.equal(runs.get('gmail:home').state, 'ok')
  assert.deepEqual(runs.health().map((x) => x.source), ['gmail:home'])
  runs.close()
})
