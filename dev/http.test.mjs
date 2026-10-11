import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createAlertStore } from './alerts.mjs'
import { createDevGithub } from './github.mjs'
import { createDevHttpHandler } from './http.mjs'
import { createAlertIngestHandler } from './ingest.mjs'
import { createDevService } from './service.mjs'
import { fakeGh, repoRoutes } from './fixtures.mjs'

const TOKEN = 'test-ingest-token'
const cleanups = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture({ config, token = TOKEN, routes = repoRoutes() } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'totem-dev-http-'))
  const configFile = join(directory, 'dev.json')
  if (config) writeFileSync(configFile, JSON.stringify(config))
  const notified = []
  const alerts = createAlertStore({ file: join(directory, 'dev-alerts.json'), notify: async (n) => { notified.push(n) } })
  const gh = fakeGh(routes)
  const service = createDevService({
    configFile,
    github: createDevGithub({ run: gh.run }),
    alerts,
    fetchImpl: async (url) => new Response('', { status: url.includes('down') ? 503 : 401 }),
  })
  const dev = createDevHttpHandler({ service })
  const ingest = createAlertIngestHandler({ alerts, token: () => token })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (await ingest(req, res, url)) return
    if (await dev(req, res, url)) return
    res.writeHead(418, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ unclaimed: true }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  cleanups.push(async () => {
    server.close()
    await once(server, 'close')
    rmSync(directory, { recursive: true, force: true })
  })
  async function request(method, path, body, headers = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  return { request, notified, gh, configFile }
}

const CONFIG = {
  repos: ['owner/repo'],
  health: [{ name: 'LLM proxy', url: 'http://proxy.example:4000/v1/models', expect: [200, 401] }, { name: 'Down', url: 'http://down.example/' }],
}

test('no config file, or no repos, means the feature is off', async () => {
  const { request, gh } = await fixture()
  const off = await request('GET', '/api/dev')
  assert.equal(off.status, 200)
  assert.equal(off.body.enabled, false)
  const empty = await fixture({ config: { repos: [] } })
  assert.equal((await empty.request('GET', '/api/dev')).body.enabled, false)
  assert.equal(gh.calls.length, 0, 'nothing calls GitHub while off')
  assert.equal((await request('GET', '/api/todos')).status, 418, 'other paths are not claimed')
})

test('the status lists repo cards and health checks, cached until refreshed', async () => {
  const { request, gh } = await fixture({ config: CONFIG })
  const first = await request('GET', '/api/dev')
  assert.equal(first.body.enabled, true)
  assert.equal(first.body.repos[0].repo, 'owner/repo')
  assert.equal(first.body.repos[0].ci[0].state, 'failure')
  assert.deepEqual(first.body.health.map((h) => [h.name, h.ok, h.status]), [['LLM proxy', true, 401], ['Down', false, 503]])
  assert.ok(first.body.fetchedAt)

  const calls = gh.calls.length
  await request('GET', '/api/dev')
  assert.equal(gh.calls.length, calls, 'a second look within a minute is served from memory')
  await request('GET', '/api/dev?refresh=1')
  assert.ok(gh.calls.length > calls, 'refresh goes back to GitHub')
})

test('the AI review switch sets and deletes the variable, for configured repos only', async () => {
  const { request, gh } = await fixture({ config: CONFIG })
  const off = await request('PUT', '/api/dev/repos/owner/repo/ai-review', { enabled: false })
  assert.deepEqual([off.status, off.body], [200, { repo: 'owner/repo', aiReview: 'off' }])
  assert.deepEqual(gh.calls.at(-1).slice(1, 4), ['-X', 'PATCH', 'repos/owner/repo/actions/variables/AI_REVIEW'])

  const on = await request('PUT', '/api/dev/repos/owner/repo/ai-review', { enabled: true })
  assert.deepEqual([on.status, on.body.aiReview], [200, 'on'])
  assert.deepEqual(gh.calls.at(-1).slice(1, 4), ['-X', 'DELETE', 'repos/owner/repo/actions/variables/AI_REVIEW'])

  const before = gh.calls.length
  const other = await request('PUT', '/api/dev/repos/someone/else/ai-review', { enabled: false })
  assert.equal(other.status, 400)
  assert.equal(gh.calls.length, before, 'an unlisted repo never reaches gh')
  assert.equal((await request('PUT', '/api/dev/repos/owner/repo/ai-review', { enabled: 'no' })).status, 400)
})

test('alert ingest is a 404 without a token configured', async () => {
  const { request, notified } = await fixture({ token: '' })
  const res = await request('POST', '/api/alerts/posthog', { title: 'x' }, { authorization: 'Bearer anything' })
  assert.equal(res.status, 404)
  assert.equal(notified.length, 0)
})

test('alert ingest wants the token, as a bearer or X-Alert-Token', async () => {
  const { request, notified } = await fixture()
  assert.equal((await request('POST', '/api/alerts/posthog', { title: 'x' })).status, 401)
  assert.equal((await request('POST', '/api/alerts/posthog', { title: 'x' }, { authorization: 'Bearer wrong' })).status, 401)
  assert.equal(notified.length, 0)

  const ok = await request('POST', '/api/alerts/posthog', { title: 'Checkout errors up', body: '5xx at 4%', url: 'https://example.com/x', key: 'checkout' }, { authorization: `Bearer ${TOKEN}` })
  assert.deepEqual([ok.status, ok.body.ok, ok.body.notified], [200, true, true])
  assert.equal(notified.length, 1)
  assert.deepEqual(notified[0], { level: 'warn', title: 'Checkout errors up', body: '5xx at 4%', category: 'alert.external', url: '/dev' })

  const header = await request('POST', '/api/alerts/cron', { title: 'Backup missed' }, { 'x-alert-token': TOKEN })
  assert.equal(header.status, 200)
  assert.equal(notified.length, 2)
})

test('alert ingest refuses bad sources, bad JSON and bodies over 64 KB', async () => {
  const { request } = await fixture()
  const auth = { authorization: `Bearer ${TOKEN}` }
  assert.equal((await request('POST', '/api/alerts/Bad_Source', { title: 'x' }, auth)).status, 400)
  assert.equal((await request('POST', '/api/alerts/posthog', '{not json', auth)).status, 400)
  assert.equal((await request('POST', '/api/alerts/posthog', { title: 'x'.repeat(70 * 1024) }, auth)).status, 413)
  assert.equal((await request('GET', '/api/alerts/posthog', undefined, auth)).status, 405)
})

test('ingested alerts show up in the Dev tab, even with the repo feature off', async () => {
  const { request } = await fixture()
  await request('POST', '/api/alerts/posthog', { title: 'Signups stalled' }, { authorization: `Bearer ${TOKEN}` })
  const dev = await request('GET', '/api/dev')
  assert.equal(dev.body.enabled, false)
  assert.deepEqual(dev.body.alerts.map((a) => [a.source, a.title]), [['posthog', 'Signups stalled']])
})

test('watching from the tab writes the config file, keeping its other keys', async () => {
  const { request, configFile } = await fixture()
  const added = await request('PUT', '/api/dev/repos', { repo: 'owner/repo', watch: true })
  assert.deepEqual([added.status, added.body.watched], [200, ['owner/repo']])
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), { repos: ['owner/repo'] }, 'a missing file is created')
  assert.equal((await request('GET', '/api/dev')).body.enabled, true)

  writeFileSync(configFile, JSON.stringify({ ...CONFIG, pollMinutes: 7 }))
  const removed = await request('PUT', '/api/dev/repos', { repo: 'owner/repo', watch: false })
  assert.deepEqual(removed.body.watched, [])
  const file = JSON.parse(readFileSync(configFile, 'utf8'))
  assert.deepEqual([file.repos, file.pollMinutes, file.health.length], [[], 7, 2])
  const off = await request('GET', '/api/dev')
  assert.deepEqual([off.body.enabled, off.body.watched], [false, []], 'an empty list is off')
})

test('watching refuses a malformed name or a repo gh cannot see', async () => {
  const { request, configFile } = await fixture()
  assert.equal((await request('PUT', '/api/dev/repos', { repo: 'not a repo', watch: true })).status, 400)
  assert.equal((await request('PUT', '/api/dev/repos', { repo: 'owner/repo' })).status, 400)
  const hidden = await request('PUT', '/api/dev/repos', { repo: 'someone/private', watch: true })
  assert.equal(hidden.status, 400)
  assert.match(hidden.body.error, /cannot see/)
  assert.throws(() => readFileSync(configFile), 'nothing was written')
})

test('a change to the watched list clears the cache', async () => {
  const { request, gh } = await fixture({ config: CONFIG })
  await request('GET', '/api/dev')
  await request('PUT', '/api/dev/repos', { repo: 'owner/repo', watch: true })
  const calls = gh.calls.length
  await request('GET', '/api/dev')
  assert.ok(gh.calls.length > calls)
})

test('a one-off review is dispatched only for a watched repo with the workflow', async () => {
  const { request, gh } = await fixture({ config: CONFIG })
  const ok = await request('POST', '/api/dev/repos/owner/repo/pulls/4/review')
  assert.deepEqual([ok.status, ok.body.queued], [200, true])
  assert.deepEqual(gh.calls.at(-1).slice(1, 4), ['-X', 'POST', 'repos/owner/repo/actions/workflows/review.yml/dispatches'])

  const before = gh.calls.length
  assert.equal((await request('POST', '/api/dev/repos/someone/else/pulls/4/review')).status, 400)
  assert.equal(gh.calls.length, before, 'an unwatched repo never reaches gh')

  const bare = await fixture({ config: CONFIG, routes: repoRoutes('owner/repo', { reviewWorkflow: false }) })
  assert.equal((await bare.request('POST', '/api/dev/repos/owner/repo/pulls/4/review')).status, 400)
})
