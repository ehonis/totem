import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createDevHttpHandler } from './http.mjs'
import { createRunIngestHandler, isRunIngestRequest } from './ingest.mjs'
import { createRunStore, t3ThreadUrl, validateRun, DEDUPE_MS } from './runs.mjs'

const TOKEN = 'test-ingest-token'
const T0 = Date.parse('2026-11-10T12:00:00Z')
const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

function dir() {
  const d = mkdtempSync(join(tmpdir(), 'totem-dev-runs-'))
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

function store({ clock = { t: T0 }, notify, fs } = {}) {
  const d = dir()
  const file = join(d, 'dev-runs.json')
  const notified = []
  const runs = createRunStore({
    file,
    now: () => clock.t,
    notify: notify || (async (n) => { notified.push(n) }),
    t3Url: () => 'https://t3.example',
    ...(fs ? { fs } : {}),
  })
  return { runs, notified, file, dir: d, clock }
}

const body = (extra = {}) => ({
  run: 'totem-tasks',
  title: 'Totem tasks ORCH',
  repo: 'owner/totem',
  orchThreadId: 'mcp:launch:abc123',
  environmentId: 'e36bafe1-8d6e-476d-9a6e-b7ac1f84c02b',
  updatedAt: new Date(T0 - 60_000).toISOString(),
  waitingOnEthan: [],
  incidents: [],
  threads: [
    { issue: '#12', title: 'Kanban board', stage: 'review 2', lastReportAt: new Date(T0 - 120_000).toISOString(), pr: 41, ci: 'passing', codeScore: 9, uxScore: '8/10', skippedSeats: ['Fable'] },
    { issue: 13, title: 'Sheet feed', stage: 'blocked', pr: 'https://github.com/owner/totem/pull/42', ci: 'failure', codeScore: null, uxScore: null, skippedSeats: [] },
  ],
  ...extra,
})

async function server(runs, token = TOKEN) {
  const ingest = createRunIngestHandler({ runs, token: () => token })
  const dev = createDevHttpHandler({ service: {}, runs })
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    // As bridge.mjs does: the ingest ahead of the gate, the dashboard routes behind it.
    if (isRunIngestRequest(req.method, url.pathname) && await ingest(req, res, url)) return
    if (req.headers.authorization !== 'Bearer owner') { res.writeHead(401); res.end('{"error":"gate"}'); return }
    if (await dev(req, res, url)) return
    res.writeHead(418); res.end('{}')
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  cleanups.push(async () => { srv.close(); await once(srv, 'close') })
  const origin = `http://127.0.0.1:${srv.address().port}`
  return async (method, path, payload, headers = {}) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: payload === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
}

test('the ingest route needs the alert token: none set is a 404, a missing or wrong one a 401', async () => {
  const { runs, file } = store()
  const off = await server(runs, '')
  assert.equal((await off('POST', '/api/dev/runs/totem', body(), { authorization: `Bearer ${TOKEN}` })).status, 404)

  const req = await server(runs)
  assert.equal((await req('POST', '/api/dev/runs/totem', body())).status, 401)
  assert.equal((await req('POST', '/api/dev/runs/totem', body(), { authorization: 'Bearer nope' })).status, 401)
  assert.equal((await req('POST', '/api/dev/runs/totem', body(), { 'x-alert-token': 'nope' })).status, 401)
  assert.throws(() => readFileSync(file), 'nothing is written before the token checks out')

  const bearer = await req('POST', '/api/dev/runs/totem', body(), { authorization: `Bearer ${TOKEN}` })
  assert.equal(bearer.status, 200)
  assert.deepEqual(bearer.body, { ok: true, slug: 'totem', archived: false, notified: [] })
  assert.equal((await req('POST', '/api/dev/runs/other', body(), { 'x-alert-token': TOKEN })).status, 200)
})

test('the token is DEV_RUNS_TOKEN when set, else ALERT_INGEST_TOKEN', async () => {
  const saved = { dev: process.env.DEV_RUNS_TOKEN, alert: process.env.ALERT_INGEST_TOKEN }
  const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try {
    const { runs } = store()
    const handler = createRunIngestHandler({ runs })
    const call = async (token) => {
      const srv = createServer(async (req, res) => { if (!(await handler(req, res))) { res.statusCode = 418; res.end() } })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/dev/runs/totem`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body()),
        })
        return res.status
      } finally { await new Promise((r) => srv.close(r)) }
    }
    process.env.ALERT_INGEST_TOKEN = 'alert-token'
    delete process.env.DEV_RUNS_TOKEN
    assert.equal(await call('alert-token'), 200, 'falls back to the alert token')
    process.env.DEV_RUNS_TOKEN = 'runs-token'
    assert.equal(await call('runs-token'), 200)
    assert.equal(await call('alert-token'), 401, 'its own token replaces the alert token')
  } finally {
    restore('DEV_RUNS_TOKEN', saved.dev)
    restore('ALERT_INGEST_TOKEN', saved.alert)
  }
})

test('only POST is claimed ahead of the gate; reading and archiving need the owner', async () => {
  assert.equal(isRunIngestRequest('POST', '/api/dev/runs/x'), true)
  assert.equal(isRunIngestRequest('PUT', '/api/dev/runs/x'), false)
  assert.equal(isRunIngestRequest('GET', '/api/dev/runs'), false)
  assert.equal(isRunIngestRequest('POST', '/api/dev/runs/x/y'), false)

  const { runs } = store()
  const req = await server(runs)
  await req('POST', '/api/dev/runs/totem', body(), { authorization: `Bearer ${TOKEN}` })
  // The ingest token is not the owner's: the gate refuses it on GET and PUT.
  assert.equal((await req('GET', '/api/dev/runs', undefined, { authorization: `Bearer ${TOKEN}` })).status, 401)
  assert.equal((await req('PUT', '/api/dev/runs/totem', { archived: true }, { authorization: `Bearer ${TOKEN}` })).status, 401)

  const list = await req('GET', '/api/dev/runs', undefined, { authorization: 'Bearer owner' })
  assert.equal(list.status, 200)
  assert.equal(list.body.runs[0].orchUrl, 'https://t3.example/e36bafe1-8d6e-476d-9a6e-b7ac1f84c02b/mcp%3Alaunch%3Aabc123')
  assert.equal((await req('PUT', '/api/dev/runs/totem', { archived: 'yes' }, { authorization: 'Bearer owner' })).status, 400)
  assert.equal((await req('PUT', '/api/dev/runs/nope', { archived: true }, { authorization: 'Bearer owner' })).status, 404)
  const put = await req('PUT', '/api/dev/runs/totem', { archived: true }, { authorization: 'Bearer owner' })
  assert.equal(put.status, 200)
  assert.equal(put.body.run.archived, true)
})

test('a body over 64 KB is a 413, and a bad slug or non-object body a 400', async () => {
  const { runs } = store()
  const req = await server(runs)
  const auth = { authorization: `Bearer ${TOKEN}` }
  const big = body({ waitingOnEthan: ['x'.repeat(70 * 1024)] })
  assert.equal((await req('POST', '/api/dev/runs/totem', big, auth)).status, 413)
  assert.equal((await req('POST', '/api/dev/runs/Bad_Slug', body(), auth)).status, 400)
  assert.equal((await req('POST', `/api/dev/runs/${'a'.repeat(65)}`, body(), auth)).status, 400)
  assert.equal((await req('POST', '/api/dev/runs/totem', '[1,2]', auth)).status, 400)
  assert.equal((await req('POST', '/api/dev/runs/totem', '{not json', auth)).status, 400)
  const bad = await req('POST', '/api/dev/runs/totem', body({ threads: [{ title: 'x', stage: 'shipping' }] }), auth)
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /threads\[0\]\.stage must be one of building, pr, review/)
})

test('validation names the field, normalises stages, PRs, CI and scores, and ignores unknown fields', () => {
  const v = validateRun(body({ extra: 'ignored' }))
  assert.equal(v.extra, undefined)
  assert.deepEqual(v.threads[0], {
    issue: '#12', title: 'Kanban board', stage: 'review', round: 2, lastReportAt: new Date(T0 - 120_000).toISOString(),
    pr: { number: 41, url: 'https://github.com/owner/totem/pull/41' }, ci: 'passing', codeScore: 9, uxScore: 8, skippedSeats: ['Fable'],
  })
  assert.deepEqual(v.threads[1].pr, { number: 42, url: 'https://github.com/owner/totem/pull/42' })
  assert.equal(v.threads[1].ci, 'failing')
  assert.equal(validateRun(body({ threads: [{ title: 't', stage: 'review', round: 3 }] })).threads[0].round, 3)
  assert.equal(validateRun(body({ threads: [{ title: 't', stage: 'Review r4' }] })).threads[0].round, 4)
  assert.equal(validateRun(body({ threads: [{ title: 't', stage: 'review' }] })).threads[0].round, null)

  const bad = (extra, re) => assert.throws(() => validateRun(body(extra)), (e) => e.status === 400 && re.test(e.message), String(re))
  bad({ title: '' }, /title is required/)
  bad({ repo: 'not a repo' }, /repo must be owner\/name/)
  bad({ orchThreadId: 'a b<script>' }, /orchThreadId/)
  bad({ waitingOnEthan: 'merge it' }, /waitingOnEthan must be an array/)
  bad({ incidents: [1] }, /incidents\[0\] must be a string/)
  bad({ threads: {} }, /threads must be an array/)
  bad({ threads: ['x'] }, /threads\[0\] must be an object/)
  bad({ threads: [{ title: 't', stage: 'pr', ci: 'green' }] }, /threads\[0\]\.ci must be one of/)
  bad({ threads: [{ title: 't', stage: 'pr', codeScore: 11 }] }, /codeScore must be a number from 0 to 10/)
  bad({ threads: [{ title: 't', stage: 'pr', pr: 'javascript:alert(1)' }] }, /pr must be an http/)
  bad({ threads: [{ title: 't', stage: 'pr', skippedSeats: 'Fable' }] }, /skippedSeats must be an array/)
  bad({ updatedAt: 'yesterday' }, /updatedAt must be an ISO date/)
  bad({ handoffUrl: { url: 'x' } }, /handoffUrl must be a string/)
  bad({ finished: 'yes' }, /finished must be true or false/)
  bad({ threads: Array.from({ length: 101 }, () => ({ title: 't', stage: 'pr' })) }, /more than 100/)
})

test('writes are atomic: a failed rename leaves the last good file and no temp file', async () => {
  let failRename = false
  const fs = { ...fsp, rename: async (a, b) => { if (failRename) throw new Error('disk full'); return fsp.rename(a, b) } }
  const { runs, file, dir: d } = store({ fs })
  await runs.ingest('totem', body())
  const good = readFileSync(file, 'utf8')
  failRename = true
  await assert.rejects(runs.ingest('totem', body({ title: 'Changed' })), /disk full/)
  assert.equal(readFileSync(file, 'utf8'), good, 'the last good file is untouched')
  assert.deepEqual(readdirSync(d), ['dev-runs.json'], 'the temp file is cleaned up')
  failRename = false
  assert.equal((await runs.list())[0].title, 'Totem tasks ORCH')
})

test('concurrent pushes are serialised, so none is lost', async () => {
  const { runs, file } = store()
  await Promise.all(Array.from({ length: 20 }, (_, i) => runs.ingest(`run-${i}`, body({ title: `Run ${i}` }))))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Object.keys(saved.runs).length, 20)
})

test('the latest body per slug is kept, newest-updated first, and a clock ahead of ours reads as now', async () => {
  const { runs, clock } = store()
  await runs.ingest('a', body({ title: 'A', updatedAt: new Date(T0 - 3_600_000).toISOString() }))
  await runs.ingest('b', body({ title: 'B' }))
  await runs.ingest('a', body({ title: 'A2', updatedAt: new Date(T0 + 86_400_000).toISOString() }))
  const list = await runs.list()
  assert.deepEqual(list.map((r) => r.title), ['A2', 'B'])
  assert.equal(list[0].updatedAt, new Date(clock.t).toISOString())
})

test('a finish line archives the run once; after that only the owner moves it', async () => {
  const { runs } = store()
  await runs.ingest('totem', body())
  assert.equal((await runs.list())[0].archived, false)

  const done = await runs.ingest('totem', body({ finished: true }))
  assert.equal(done.run.archived, true)
  assert.ok(done.run.finishedAt)

  await runs.setArchived('totem', false)
  await runs.ingest('totem', body({ finished: true }))
  assert.equal((await runs.list())[0].archived, false, 'a later finished push does not undo the owner restoring it')

  await runs.ingest('handoff', body({ handoffUrl: 'https://github.com/owner/totem/blob/main/HANDOFF.md' }))
  assert.equal((await runs.list()).find((r) => r.slug === 'handoff').archived, true, 'a handoff link is a finish too')

  const path = await runs.ingest('handoff-path', body({ handoffUrl: '~/.config/totem/HANDOFF.md' }))
  assert.equal(path.run.archived, true, 'a handoff file path is a finish too')
  assert.equal(path.run.handoffUrl, null, 'only a web link is kept')
  const js = await runs.ingest('handoff-js', body({ handoffUrl: 'javascript:alert(1)' }))
  assert.equal(js.run.handoffUrl, null)

  await runs.ingest('manual', body())
  await runs.setArchived('manual', true)
  await runs.ingest('manual', body())
  assert.equal((await runs.list()).find((r) => r.slug === 'manual').archived, true, 'an owner archive stays through later pushes')
  await assert.rejects(runs.setArchived('missing', true), (e) => e.status === 404)
})

test('push when waiting goes from empty to non-empty or an incident is new, never the same item twice in an hour', async () => {
  const { runs, notified, clock } = store()
  await runs.ingest('totem', body())
  assert.equal(notified.length, 0, 'nothing waiting, nothing pushed')

  const waiting = await runs.ingest('totem', body({ waitingOnEthan: ['Merge PR #41'] }))
  assert.deepEqual(waiting.notified, ['waiting'])
  assert.deepEqual(notified[0], { level: 'warn', title: 'Totem tasks ORCH: waiting on you', body: 'Merge PR #41', category: 'dev.run', url: '/dev' })

  assert.deepEqual((await runs.ingest('totem', body({ waitingOnEthan: ['Merge PR #41', 'Pick a colour'] }))).notified, [], 'still waiting is not new')
  await runs.ingest('totem', body())
  clock.t += 10 * 60_000
  assert.deepEqual((await runs.ingest('totem', body({ waitingOnEthan: ['Merge PR #41'] }))).notified, [], 'the same item again within the hour')
  await runs.ingest('totem', body())
  assert.deepEqual((await runs.ingest('totem', body({ waitingOnEthan: ['Something else'] }))).notified, ['waiting'], 'a different item is news')

  assert.deepEqual((await runs.ingest('totem', body({ incidents: ['Deleted a worktree'] }))).notified, ['incident'])
  assert.equal(notified.at(-1).level, 'error')
  assert.deepEqual((await runs.ingest('totem', body({ incidents: ['Deleted a worktree'] }))).notified, [], 'a reported incident is not new')
  assert.deepEqual((await runs.ingest('totem', body({ incidents: ['Deleted a worktree', 'Live API call'] }))).notified, ['incident'])
  await runs.ingest('totem', body())
  assert.deepEqual((await runs.ingest('totem', body({ incidents: ['Deleted a worktree'] }))).notified, [], 'dropped and re-added within the hour')

  clock.t += DEDUPE_MS
  await runs.ingest('totem', body())
  assert.deepEqual((await runs.ingest('totem', body({ waitingOnEthan: ['Merge PR #41'] }))).notified, ['waiting'], 'an hour on, it can go out again')
  assert.deepEqual((await runs.ingest('other', body({ waitingOnEthan: ['Merge PR #41'] }))).notified, ['waiting'], 'another run is its own item')
})

test('an undelivered push is tried again on the next change', async () => {
  const outcomes = [{ ok: false, reason: 'send-failed' }, { ok: true }]
  const { runs } = store({ notify: async (n) => ({ ...n, delivery: outcomes.shift() }) })
  assert.deepEqual((await runs.ingest('totem', body({ waitingOnEthan: ['Merge'] }))).notified, [])
  await runs.ingest('totem', body())
  assert.deepEqual((await runs.ingest('totem', body({ waitingOnEthan: ['Merge'] }))).notified, ['waiting'])
})

test('a T3 link needs both ids', () => {
  assert.equal(t3ThreadUrl('https://app.t3.codes/', 'env', 'thread'), 'https://app.t3.codes/env/thread')
  assert.equal(t3ThreadUrl('https://app.t3.codes', null, 'thread'), null)
  assert.equal(t3ThreadUrl('https://app.t3.codes', 'env', null), null)
})

test('an unreadable file starts empty rather than failing', async () => {
  const { runs, file } = store()
  writeFileSync(file, '{oops')
  assert.deepEqual(await runs.list(), [])
  await runs.ingest('totem', body())
  assert.equal((await runs.list()).length, 1)
})
