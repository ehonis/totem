import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { recordGatewayStatus } from './gateway.mjs'
import { createSourceHttpHandler, sourceHealthPayload } from './http.mjs'
import { createSourceRuns, openSourceRuns } from './store.mjs'
import { isSourceFault, remoteClient, remoteFault, tracker } from './track.mjs'
import { createRemoteStravaClient } from '../strava/remote.mjs'

const T0 = Date.parse('2026-10-30T12:00:00.000Z')
const MIN = 60_000

function clock(start = T0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))
const tmp = (name) => mkdtempSync(join(tmpdir(), `source-runs-${name}-`))

// A Bushido that answers every call; used to show a connector still works on a broken log.
const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ result: [{ id: 1 }, { id: 2 }] }) })

// ---- opening ------------------------------------------------------------------

test('a corrupt run log is moved aside and a fresh one made', async () => {
  const dir = tmp('corrupt')
  const file = join(dir, 'source-runs.db')
  writeFileSync(file, 'this is not sqlite '.repeat(400))
  const logs = []
  const runs = openSourceRuns({ file, log: (m) => logs.push(m) })
  assert.equal(runs.disabled, false)
  assert.ok(readdirSync(dir).some((f) => f.startsWith('source-runs.db.corrupt-')))
  await runs.track('strava', async () => [1])
  assert.equal(runs.get('strava').state, 'ok')
  assert.match(logs.join('\n'), /moved to/)
  runs.close()
})

test('a run log that cannot be opened turns source health off and connectors keep working', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions')
  const ro = tmp('readonly')
  chmodSync(ro, 0o500)
  t.after(() => chmodSync(ro, 0o700))
  const blocker = join(tmp('file'), 'not-a-dir')
  writeFileSync(blocker, 'x')
  for (const [name, file] of [
    ['read-only directory', join(ro, 'source-runs.db')],
    ['missing subdirectory under a read-only one', join(ro, 'data', 'source-runs.db')],
    ['a path through a file', join(blocker, 'source-runs.db')],
  ]) {
    const logs = []
    const runs = openSourceRuns({ file, log: (m) => logs.push(m) })
    assert.equal(runs.disabled, true, name)
    assert.match(logs.join('\n'), /source health is off/, name)
    const strava = createRemoteStravaClient({ url: 'http://bushido.test', token: 't', fetchImpl: okFetch, runs })
    assert.equal((await strava.activities()).length, 2, name)
    assert.deepEqual(runs.health(), [])
    assert.equal(sourceHealthPayload({ runs }).disabled.length > 0, true)
  }
})

test('a closed log never changes what the connector returns or throws', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  runs.close()
  assert.equal(await runs.track('x', async () => 42), 42)
  const own = Object.assign(new Error('down'), { status: 503 })
  await assert.rejects(runs.track('x', async () => { throw own }), (e) => e === own)
  assert.deepEqual(runs.health(), [])
  assert.deepEqual(runs.runs('x'), [])
})

test('a hostile error object is rethrown as itself and recorded without throwing', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  const evil = { get message() { throw new Error('getter boom') }, status: 503 }
  await assert.rejects(runs.track('y', async () => { throw evil }), (e) => e === evil)
  assert.equal(runs.get('y').error, 'an error that could not be read')
  assert.equal(runs.record({ source: { toString() { throw new Error('bad id') } }, ok: false }), null)
  const out = await runs.track('z', async () => ({ weird: true }), { rows: () => { throw new Error('x') } })
  assert.deepEqual(out, { weird: true })
  runs.close()
})

// ---- tracking -----------------------------------------------------------------

test('track records what came back, and a request error counts as the source answering', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  assert.deepEqual(await runs.track('drive:home', async () => [1, 2, 3]), [1, 2, 3])
  assert.equal(runs.get('drive:home').rows, 3)
  const notFound = Object.assign(new Error('file not found'), { status: 404 })
  await assert.rejects(runs.track('drive:home', async () => { throw notFound }), /file not found/)
  assert.equal(runs.get('drive:home').state, 'ok')
  const down = Object.assign(new Error('backend error'), { status: 503 })
  await assert.rejects(runs.track('drive:home', async () => { throw down }), /backend error/)
  assert.equal(runs.get('drive:home').state, 'degraded')
  assert.equal(runs.runs('drive:home').length, 3)
  runs.close()
})

test('fault rules: unreachable, refused and misconfigured fail; a bad request does not', () => {
  assert.equal(isSourceFault(new TypeError('fetch failed')), true)
  for (const status of [401, 403, 409, 429, 500, 502]) assert.equal(isSourceFault({ status }), true, String(status))
  for (const status of [400, 404, 422]) assert.equal(isSourceFault({ status }), false, String(status))
})

test('an operation is one run however many tracked calls it makes, even eight at once', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  const track = tracker(runs)
  const limited = () => Promise.reject(Object.assign(new Error('rateLimitExceeded'), { status: 429 }))
  await assert.rejects(track('gmail:home', () => Promise.all(Array.from({ length: 8 }, () => track('gmail:home', limited)))))
  assert.equal(runs.get('gmail:home').failures, 1)
  assert.equal(runs.runs('gmail:home').length, 1)
  // A different source inside the operation is its own run.
  await track('gmail:home', () => track('drive:home', async () => [1]))
  assert.equal(runs.runs('drive:home').length, 1)
  runs.close()
})

test('a sync counts only the remote client\'s errors, and a local failure records nothing', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  const track = tracker(runs)
  const client = remoteClient({
    search: async () => { throw Object.assign(new Error('Bad credentials'), { status: 401 }) },
    gone: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }) },
    fine: async () => ['issue'],
  })
  await assert.rejects(track('github-tasks', () => client.search(), { isFault: remoteFault }), /Bad credentials/)
  assert.equal(runs.get('github-tasks').failures, 1)
  await assert.rejects(track('github-tasks', async () => { await client.fine(); throw new Error('SQLITE_BUSY') }, { isFault: remoteFault }))
  assert.equal(runs.runs('github-tasks').length, 1, 'the local failure wrote no run')
  await assert.rejects(track('github-tasks', () => client.gone(), { isFault: remoteFault }))
  assert.equal(runs.get('github-tasks').state, 'ok', 'a 404 from GitHub means it answered')
  runs.close()
})

// ---- telling the owner -----------------------------------------------------------

test('the owner is told once per outage, and only after the queue took the notice', async () => {
  const c = clock()
  const told = []
  const runs = createSourceRuns({ file: ':memory:', now: c.now, onFailing: async (h) => { told.push(h) } })
  for (let i = 0; i < 8; i += 1) { runs.record({ source: 'whoop', ok: false, error: 'Bushido answered HTTP 502' }); c.advance(5 * MIN); await settle() }
  assert.equal(told.length, 1)
  assert.equal(told[0].state, 'failing')
  assert.ok(runs.get('whoop').notifiedAt)
  runs.close()
})

test('a notice that fails to queue is tried again on the next failure', async () => {
  const c = clock()
  const told = []
  let queueUp = false
  const logs = []
  const runs = createSourceRuns({
    file: ':memory:', now: c.now, log: (m) => logs.push(m),
    onFailing: async (h) => { if (!queueUp) throw new Error('notifyStore is not defined yet'); told.push(h) },
  })
  const fail = async () => { runs.record({ source: 'feed:hn', ok: false, error: 'ECONNRESET' }); c.advance(10 * MIN); await settle() }
  for (let i = 0; i < 4; i += 1) await fail()
  assert.equal(told.length, 0)
  assert.equal(runs.get('feed:hn').notifiedAt, null)
  assert.match(logs.join('\n'), /will retry/)
  queueUp = true
  await fail()
  assert.equal(told.length, 1)
  await fail()
  assert.equal(told.length, 1)
  runs.close()
})

test('two long outages two hours apart are each announced', async () => {
  const c = clock()
  const told = []
  const runs = createSourceRuns({ file: ':memory:', now: c.now, onFailing: async (h) => { told.push(h) } })
  const step = async (ok) => { runs.record({ source: 'strava', ok, error: ok ? null : 'down' }); c.advance(10 * MIN); await settle() }
  for (let i = 0; i < 6; i += 1) await step(false)
  await step(true)
  c.advance(2 * 60 * MIN)
  for (let i = 0; i < 60; i += 1) await step(false)
  assert.equal(told.length, 2)
  assert.notEqual(told[0].failingSince, told[1].failingSince)
  runs.close()
})

test('a restart mid-outage does not announce it again', async () => {
  const file = join(tmp('restart'), 'runs.db')
  const c = clock()
  const told = []
  let runs = createSourceRuns({ file, now: c.now, onFailing: async (h) => { told.push(h) } })
  for (let i = 0; i < 4; i += 1) { runs.record({ source: 'strava', ok: false, error: 'down' }); c.advance(5 * MIN); await settle() }
  runs.close()
  runs = createSourceRuns({ file, now: c.now, onFailing: async (h) => { told.push(h) } })
  runs.record({ source: 'strava', ok: false, error: 'down' })
  await settle()
  assert.equal(runs.get('strava').failures, 5)
  assert.equal(told.length, 1)
  runs.close()
})

// ---- the gateway's status check -----------------------------------------------------

test('three quick Connections refreshes against a dead MCP server do not raise an alert', async () => {
  const c = clock()
  const told = []
  const runs = createSourceRuns({ file: ':memory:', now: c.now, onFailing: async (h) => { told.push(h) } })
  const report = { ok: true, totalTools: 4, servers: [{ id: 'plaud', ok: false, error: 'HTTP 502' }, { id: 'tasks', builtin: true, ok: true }] }
  for (let i = 0; i < 3; i += 1) { recordGatewayStatus(runs, report, { at: new Date(c.now()).toISOString() }); c.advance(5000); await settle() }
  assert.equal(runs.get('mcp:plaud').state, 'degraded')
  assert.equal(runs.get('mcp:tasks'), null, 'built-ins are not sources')
  assert.equal(told.length, 0)
  runs.close()
})

test('an MCP server waiting for its sign-in is not set up, not failing', () => {
  const runs = createSourceRuns({ file: ':memory:' })
  recordGatewayStatus(runs, { ok: true, totalTools: 0, servers: [{ id: 'github', ok: false, needsAuth: true, error: 'needs auth' }] })
  assert.equal(runs.get('mcp:github').state, 'unconfigured')
  assert.equal(runs.get('mcp:github').failures, 0)
  runs.close()
})

test('an MCP server\'s error keeps only the URL origin', () => {
  const runs = createSourceRuns({ file: ':memory:' })
  recordGatewayStatus(runs, { ok: true, servers: [{ id: 'zap', ok: false, error: 'fetch https://mcp.zap.example/s/abcdef0123456789/mcp failed' }] })
  assert.equal(runs.get('mcp:zap').error, 'fetch https://mcp.zap.example/… failed')
  runs.close()
})

// ---- writes and retention --------------------------------------------------------

test('a working run that changes nothing but the time does not rewrite health within a minute', () => {
  const c = clock()
  const runs = createSourceRuns({ file: ':memory:', now: c.now })
  runs.record({ source: 'gmail:home', ok: true, rows: 5 })
  const first = runs.get('gmail:home').lastOkAt
  c.advance(20_000)
  runs.record({ source: 'gmail:home', ok: true, rows: 5 })
  assert.equal(runs.get('gmail:home').lastOkAt, first)
  c.advance(60_000)
  runs.record({ source: 'gmail:home', ok: true, rows: 5 })
  assert.notEqual(runs.get('gmail:home').lastOkAt, first)
  assert.equal(runs.runs('gmail:home').length, 3, 'every run is still logged')
  runs.close()
})

test('retention drops old runs and caps each source, but keeps when a source last worked', () => {
  const c = clock()
  const runs = createSourceRuns({ file: ':memory:', now: c.now, retentionDays: 30, maxRunsPerSource: 5 })
  runs.record({ source: 'strava', ok: true, rows: 9 })
  const lastOk = runs.get('strava').lastOkAt
  c.advance(31 * 24 * 60 * MIN)
  for (let i = 0; i < 8; i += 1) { runs.record({ source: 'strava', ok: false, error: 'down' }); c.advance(1000) }
  runs.record({ source: 'gmail:home', ok: true })
  runs.prune()
  const kept = runs.runs('strava', { limit: 100 })
  assert.equal(kept.length, 5)
  assert.ok(kept.every((r) => !r.ok))
  assert.equal(runs.get('strava').lastOkAt, lastOk)
  assert.equal(runs.get('strava').failures, 8)
  assert.equal(runs.runs('gmail:home').length, 1)
  runs.close()
})

test('a source that has not run within retention is forgotten', () => {
  const c = clock()
  const runs = createSourceRuns({ file: ':memory:', now: c.now, retentionDays: 30 })
  runs.record({ source: 'drive:old', ok: true })
  c.advance(31 * 24 * 60 * MIN)
  // The first write after an hour prunes on its own; no explicit prune() here.
  runs.record({ source: 'drive:new', ok: true })
  assert.deepEqual(runs.health().map((h) => h.source), ['drive:new'])
  assert.deepEqual(runs.runs('drive:old'), [])
  runs.close()
})

// ---- the API ----------------------------------------------------------------

test('the payload groups sources under the goals they feed and lists a goal\'s unread source as unknown', () => {
  const c = clock()
  const runs = createSourceRuns({ file: ':memory:', now: c.now })
  for (let i = 0; i < 3; i += 1) { runs.record({ source: 'strava', ok: false, error: 'down' }); c.advance(10 * MIN) }
  runs.record({ source: 'gmail:home', ok: true })
  const goals = () => [
    { id: 'g1', title: 'Ride 40 miles', periodType: 'week', sources: ['strava'] },
    { id: 'g2', title: 'Sleep', periodType: 'week', sources: ['whoop'] },
  ]
  const payload = sourceHealthPayload({ runs, goals, metricSources: { strava_distance: 'strava' }, now: () => T0 })
  const byId = Object.fromEntries(payload.sources.map((s) => [s.source, s]))
  assert.equal(payload.disabled, null)
  assert.equal(byId.strava.state, 'failing')
  assert.deepEqual(byId.strava.goals, [{ id: 'g1', title: 'Ride 40 miles' }])
  assert.equal(byId.whoop.state, 'unknown')
  assert.ok(!('notifiedAt' in byId.strava))
  assert.deepEqual(payload.goals.map((g) => [g.id, g.failing]), [['g1', ['strava']], ['g2', []]])
  // A goal list that throws leaves the sources ungrouped rather than failing the page.
  assert.equal(sourceHealthPayload({ runs, goals: () => { throw new Error('db locked') } }).sources.length, 2)
  runs.close()
})

test('the route answers health and a source\'s runs, and only GET', async () => {
  const runs = createSourceRuns({ file: ':memory:' })
  runs.record({ source: 'mcp:plaud', ok: true, rows: 5 })
  const handler = createSourceHttpHandler({ runs, goals: () => [], metricSources: {} })
  const call = async (method, path) => {
    const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
    const handled = await handler({ method }, res, new URL(path, 'http://x'))
    return { handled, status: res.status, json: res.body ? JSON.parse(res.body) : null }
  }
  assert.equal((await call('GET', '/api/todos')).handled, false)
  assert.equal((await call('GET', '/api/sources')).json.sources[0].source, 'mcp:plaud')
  assert.equal((await call('GET', '/api/sources/runs?source=mcp%3Aplaud')).json.runs[0].rows, 5)
  assert.equal((await call('GET', '/api/sources/runs')).status, 400)
  assert.equal((await call('POST', '/api/sources')).status, 405)
  runs.close()
})
