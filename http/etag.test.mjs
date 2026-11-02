import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { etagEligible, etagMatches, etagResponse, weakEtag } from './etag.mjs'
import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs'
import { createGoalHttpHandler } from '../goals/http.mjs'
import { createGoalService } from '../goals/service.mjs'

// A server shaped like the bridge's /api/ gate: etagResponse first, then a
// handler that answers the way the bridge's modules do.
async function serve(handler) {
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    etagResponse(req, res, path)
    handler(req, res, path)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    get: (path, headers = {}, method = 'GET') => fetch(base + path, { method, headers }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

test('a read route answers with a weak ETag, then 304 for the same body', async (t) => {
  let todos = [{ id: 't1', content: 'Buy milk' }]
  const server = await serve((req, res) => sendJson(res, 200, { todos }))
  t.after(server.close)

  const first = await server.get('/api/todos')
  assert.equal(first.status, 200)
  const etag = first.headers.get('etag')
  assert.match(etag, /^W\/"[\w-]+"$/)
  assert.equal(first.headers.get('cache-control'), 'private, no-cache')
  assert.deepEqual(await first.json(), { todos })

  const again = await server.get('/api/todos', { 'if-none-match': etag })
  assert.equal(again.status, 304)
  assert.equal(again.headers.get('etag'), etag)
  assert.equal(await again.text(), '')

  todos = [...todos, { id: 't2', content: 'Call the bank' }]
  const changed = await server.get('/api/todos', { 'if-none-match': etag })
  assert.equal(changed.status, 200)
  assert.notEqual(changed.headers.get('etag'), etag)
  assert.deepEqual(await changed.json(), { todos })
})

test('the query string is part of what is tagged', async (t) => {
  const server = await serve((req, res) => sendJson(res, 200, { url: req.url }))
  t.after(server.close)
  const week = await server.get('/api/habits?days=7')
  assert.ok(week.headers.get('etag'))
  const year = await server.get('/api/habits?days=371', { 'if-none-match': week.headers.get('etag') })
  assert.equal(year.status, 200)
  assert.notEqual(year.headers.get('etag'), week.headers.get('etag'))
  assert.deepEqual(await year.json(), { url: '/api/habits?days=371' })
})

test('every way the modules answer is tagged: setHeader + end, writeHead with a status message, a Buffer', async (t) => {
  const server = await serve((req, res, path) => {
    if (path === '/api/lists') { res.setHeader('content-type', 'application/json'); res.end('{"lists":[]}'); return }
    if (path === '/api/goals') { res.writeHead(200, 'OK', { 'content-type': 'application/json' }); res.end(Buffer.from('{"goals":[]}')); return }
    sendJson(res, 404, { error: 'not found' })
  })
  t.after(server.close)
  for (const path of ['/api/lists', '/api/goals']) {
    const r = await server.get(path)
    assert.equal(r.status, 200, path)
    assert.ok(r.headers.get('etag'), path)
    assert.equal((await server.get(path, { 'if-none-match': r.headers.get('etag') })).status, 304, path)
  }
})

test('excluded routes never get an ETag or a 304, even for If-None-Match: *', async (t) => {
  const server = await serve((req, res) => sendJson(res, 200, { ok: true, at: 1 }))
  t.after(server.close)
  const excluded = [
    '/api/usage', '/api/ai-usage', '/api/assistant-usage', '/api/jobs', '/api/runs', '/api/runs/r1',
    '/api/chat/runs', '/api/chat/runs/thread-1/stream', '/api/ai-usage/stream',
    '/api/ai/settings', '/api/integrations', '/api/chat/settings', '/api/mcp', '/api/connections',
    '/api/calendar/accounts', '/api/gmail/accounts', '/api/drive/accounts',
    '/api/todos/connectors/sheet', '/api/todos/connectors/github', '/api/journal/settings',
    '/api/auth/status', '/api/threads/t1/messages', '/health', '/version', '/', '/index.html', '/chat',
    '/api/inbox', '/api/journal', '/api/journal/entries/e1', '/api/goals/search', '/api/search',
  ]
  // The same server tags a listed route, so the checks below are not vacuous.
  assert.ok((await server.get('/api/todos')).headers.get('etag'))
  for (const path of excluded) {
    const r = await server.get(path, { 'if-none-match': '*' })
    assert.equal(r.status, 200, path)
    assert.equal(r.headers.get('etag'), null, path)
    assert.equal(r.headers.get('cache-control'), null, path)
    await r.arrayBuffer()
  }
})

test('only a whole 200 JSON body is tagged: not a write, an error, other content, no-store or another method', async (t) => {
  const server = await serve((req, res, path) => {
    if (req.method === 'POST') return sendJson(res, 200, { todo: { id: 't1' } })
    if (path === '/api/threads') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: 1\n\n')
      res.end('data: 2\n\n')
      return
    }
    if (path === '/api/goals') return sendJson(res, 500, { error: 'boom' })
    if (path === '/api/calendar') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hi'); return }
    if (path === '/api/notifications') { res.setHeader('cache-control', 'no-store'); return sendJson(res, 200, { items: [] }) }
    sendJson(res, 200, {})
  })
  t.after(server.close)
  assert.equal((await server.get('/api/lists', { 'if-none-match': '*' })).status, 304)

  const stream = await server.get('/api/threads', { 'if-none-match': '*' })
  assert.equal(stream.headers.get('etag'), null)
  assert.equal(stream.headers.get('cache-control'), 'no-cache')
  assert.equal(await stream.text(), 'data: 1\n\ndata: 2\n\n')

  for (const [path, method, status] of [['/api/todos', 'POST', 200], ['/api/goals', 'GET', 500], ['/api/calendar', 'GET', 200], ['/api/notifications', 'GET', 200]]) {
    const r = await server.get(path, { 'if-none-match': '*' }, method)
    assert.equal(r.status, status, path)
    assert.equal(r.headers.get('etag'), null, `${method} ${path}`)
    await r.arrayBuffer()
  }
})

test('If-None-Match uses the weak comparison and reads a list', () => {
  const etag = weakEtag('{"a":1}')
  const opaque = etag.slice(2)
  assert.ok(etagMatches(etag, etag))
  assert.ok(etagMatches(opaque, etag))
  assert.ok(etagMatches(`W/"other", ${etag}`, etag))
  assert.ok(etagMatches('*', etag))
  assert.ok(!etagMatches('W/"other"', etag))
  assert.ok(!etagMatches(undefined, etag))
})

test('the allow list covers record ids but not their sub-routes', () => {
  assert.ok(etagEligible('GET', '/api/todos/t1'))
  assert.ok(etagEligible('GET', '/api/goals/g1'))
  assert.ok(etagEligible('GET', '/api/lists/l1'))
  assert.ok(!etagEligible('GET', '/api/todos/connectors/sheet'))
  assert.ok(!etagEligible('GET', '/api/lists/l1/items'))
  assert.ok(!etagEligible('HEAD', '/api/todos'))
  assert.ok(!etagEligible('GET', '/api/goals/search'))
})

test('the real goals routes: the list is tagged, a typed search is not', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'totem-etag-goals-'))
  const db = openTodoDatabase({ file: join(dir, 'todos.db') })
  const service = createGoalService({ db, actionLog: { record() {} }, timeZone: 'UTC' })
  const handler = createGoalHttpHandler({ service })
  const server = await serve(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://localhost'))) sendJson(res, 404, { error: 'no route' })
  })
  t.after(async () => { await server.close(); closeTodoDatabase(db); rmSync(dir, { recursive: true, force: true }) })

  const list = await server.get('/api/goals?period=this_week')
  assert.equal(list.status, 200)
  assert.ok(list.headers.get('etag'))
  assert.equal((await server.get('/api/goals?period=this_week', { 'if-none-match': list.headers.get('etag') })).status, 304)

  const search = await server.get('/api/goals/search?q=marathon', { 'if-none-match': '*' })
  assert.equal(search.status, 200)
  assert.equal(search.headers.get('etag'), null)
  assert.equal(search.headers.get('cache-control'), null)
})

test('the habits answer carries no clock or file path, so an unchanged tracker can 304', () => {
  const bridge = readFileSync(join(import.meta.dirname, '..', 'bridge.mjs'), 'utf8')
  const fn = bridge.slice(bridge.indexOf('async function buildHabitsPayload('))
  const ret = fn.slice(0, fn.indexOf('\n}\n')).split('\n').filter((l) => /^\s*return \{/.test(l)).at(-1)
  assert.ok(ret, 'buildHabitsPayload returns an object literal')
  assert.doesNotMatch(ret, /generatedAt|new Date|Date\.now|HABITS_FILE|source/)
})

test('the bridge tags only behind the /api/ sign-in gate, and HTML stays no-cache', () => {
  const bridge = readFileSync(join(import.meta.dirname, '..', 'bridge.mjs'), 'utf8')
  const calls = bridge.match(/etagResponse\(req, res, path\)/g) || []
  assert.equal(calls.length, 1)
  const gate = bridge.indexOf("if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })\n    if (refusedAsCrossSite(req, res)) return")
  const call = bridge.indexOf('etagResponse(req, res, path)')
  assert.ok(gate > 0 && call > gate && call - gate < 400, 'etagResponse runs right after the auth gate')

  // serveStatic: index.html and the SPA fallback are no-cache; only /assets/ and /models/ are immutable.
  const serveStatic = bridge.slice(bridge.indexOf('async function serveStatic('), bridge.indexOf('function readJsonBody('))
  assert.match(serveStatic, /immutable \? \{ 'cache-control': 'public, max-age=31536000, immutable' \} : \{ 'cache-control': 'no-cache' \}/)
  assert.match(serveStatic, /'content-type': 'text\/html; charset=utf-8', 'cache-control': 'no-cache'/)
  assert.doesNotMatch(serveStatic, /etag/i)
})
