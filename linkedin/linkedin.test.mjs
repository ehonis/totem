// Run with: node --test linkedin/linkedin.test.mjs
//
// The LinkedIn connector reads and proposes; it never acts. These check the three
// places that promise rests on: the tool list (nothing that mutates LinkedIn), the
// browser's request policy (only GETs leave a page) and the connector's own source
// (no clicks, typing or submits), plus the sign-in, the hourly budget and the
// proposal rules (one card per target, ever; at most five waiting).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserManager, readOnlyRequestDecision } from '../browser/manager.mjs'
import { LINKEDIN_HOSTS, canonicalLinkedinUrl } from './urls.mjs'
import { createLinkedinReader, linkedinOnly, sessionCookie } from './reader.mjs'
import { LINKEDIN_MCP_TOOL_DEFINITIONS, createLinkedinMcpTools } from './mcp.mjs'
import { MAX_PENDING, linkedinHistory, normalizeLinkedinProposal, proposalTitle, stagingConflict } from './proposals.mjs'
import { signedOutPath } from './pages.mjs'

const HERE = import.meta.dirname
const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/'
const FAR = Math.floor(Date.now() / 1000) + 365 * 86400
const cookie = (name, value, domain = '.linkedin.com', expires = FAR) => ({ name, value, domain, path: '/', expires, httpOnly: true, secure: true, sameSite: 'None' })
const signedInState = () => ({
  cookies: [cookie('li_at', 'AQEDAtest'), cookie('JSESSIONID', '"ajax:1"', '.www.linkedin.com'), cookie('SID', 'google', '.google.com')],
  origins: [{ origin: 'https://www.linkedin.com', localStorage: [] }, { origin: 'https://example.com', localStorage: [] }],
})

// ---- what the connector may do ------------------------------------------------

test('no LinkedIn tool mutates LinkedIn', () => {
  const byName = new Map(LINKEDIN_MCP_TOOL_DEFINITIONS.map((d) => [d.name.replace('totem_linkedin_', ''), d]))
  // The only tools that change anything change Totem's own files: the stored
  // sign-in, and a card in the owner's inbox.
  const writes = [...byName].filter(([, d]) => !d.annotations.readOnlyHint).map(([n]) => n).sort()
  assert.deepEqual(writes, ['propose_action', 'sign_in', 'sign_out'])
  assert.equal(byName.get('propose_action').annotations.openWorldHint, false)
  assert.equal(byName.get('sign_out').annotations.openWorldHint, false)
  // And no tool is named for an action on LinkedIn.
  for (const name of byName.keys()) {
    if (name === 'propose_action') continue
    assert.doesNotMatch(name, /(^|_)(like|react|comment|repost|share|send|post|reply|connect|follow|invite|accept|withdraw|endorse)($|_)/, name)
  }
  for (const d of LINKEDIN_MCP_TOOL_DEFINITIONS) {
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof d.annotations[hint], 'boolean', `${d.name} ${hint}`)
    assert.ok(d.outputSchema.required.includes('fetchedAt'), d.name)
  }
})

test("the connector's code never clicks, types, submits or posts", async () => {
  const files = (await readdir(HERE)).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
  assert.ok(files.length >= 5, files.join(', '))
  for (const f of files) {
    const src = await readFile(join(HERE, f), 'utf8')
    assert.doesNotMatch(src, /\.(click|dblclick|fill|type|press|pressSequentially|check|tap|dispatchEvent|submit|requestSubmit|setInputFiles)\(|\bkeyboard\b|\bmouse\b|\bfetch\(|method:\s*['"](POST|PUT|PATCH|DELETE)/, f)
    // The browser is used through readPage alone: never a chat's open/navigate/act tools.
    for (const m of src.matchAll(/\bbrowser\??\.(\w+)/g)) assert.ok(['readPage', 'available'].includes(m[1]), `${f}: browser.${m[1]}`)
  }
})

test('a read-only page lets only GETs to LinkedIn out', () => {
  const d = (method, url, resourceType = 'xhr') => readOnlyRequestDecision({ method, url, resourceType }, LINKEDIN_HOSTS)
  assert.equal(d('GET', 'https://www.linkedin.com/feed/', 'document'), 'continue')
  assert.equal(d('GET', 'https://www.linkedin.com/voyager/api/graphql?q=1'), 'continue')
  assert.equal(d('HEAD', 'https://static.licdn.com/sc/h/app.js', 'script'), 'continue')
  // Every way a page writes: a reaction, a comment, a read receipt, a beacon.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '']) assert.equal(d(method, 'https://www.linkedin.com/voyager/api/feed/reactions'), 'abort', method)
  // Elsewhere, or not https, or not worth the bytes.
  assert.equal(d('GET', 'https://evil-linkedin.com/x'), 'abort')
  assert.equal(d('GET', 'https://linkedin.com.evil.example/x'), 'abort')
  assert.equal(d('GET', 'https://www.google-analytics.com/collect'), 'abort')
  assert.equal(d('GET', 'http://www.linkedin.com/feed/', 'document'), 'abort')
  assert.equal(d('GET', 'https://media.licdn.com/dms/image/x.jpg', 'image'), 'abort')
  assert.equal(d('GET', 'not a url'), 'abort')
})

test('readPage puts that policy on every request of the page, and closes its sockets', async () => {
  // A stand-in for Playwright, so this runs without a Chromium.
  const seen = { routes: [], sockets: [], contextOptions: null, closed: false }
  const route = (method, url, resourceType = 'xhr') => {
    const r = { outcome: null, request: () => ({ method: () => method, url: () => url, resourceType: () => resourceType }) }
    r.continue = async () => { r.outcome = 'continue' }
    r.abort = async () => { r.outcome = 'abort' }
    return r
  }
  const page = {
    goto: async () => {
      for (const r of [route('GET', POST, 'document'), route('POST', 'https://www.linkedin.com/voyager/api/messaging/seen'), route('GET', 'https://ads.example.com/px'), route('PUT', 'https://www.linkedin.com/x')]) {
        await seen.handler(r)
        seen.routes.push([r.request().method(), r.outcome])
      }
      return { status: () => 200 }
    },
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async (fn, arg) => (typeof fn === 'function' && arg ? { mode: arg.mode } : null),
    url: () => POST, title: async () => 'Feed',
  }
  const context = {
    route: async (_glob, handler) => { seen.handler = handler },
    routeWebSocket: async (_re, handler) => { const ws = { close: () => seen.sockets.push('closed') }; handler(ws) },
    on: () => {}, newPage: async () => page, storageState: async () => signedInState(), close: async () => { seen.closed = true },
  }
  const chromium = { launch: async () => ({ on: () => {}, newContext: async (opts) => { seen.contextOptions = opts; return context }, close: async () => {} }) }
  const manager = createBrowserManager({ executablePath: '/bin/true', loadPlaywright: async () => ({ chromium }) })
  const out = await manager.readPage({ url: POST, hosts: LINKEDIN_HOSTS, extract: () => null, arg: { mode: 'feed' }, storageState: signedInState() })
  assert.deepEqual(seen.routes, [['GET', 'continue'], ['POST', 'abort'], ['GET', 'abort'], ['PUT', 'abort']])
  assert.deepEqual(out.blocked, ['POST https://www.linkedin.com/voyager/api/messaging/seen', 'GET https://ads.example.com/px', 'PUT https://www.linkedin.com/x'])
  assert.deepEqual(seen.sockets, ['closed'])
  assert.equal(seen.contextOptions.serviceWorkers, 'block')
  assert.equal(seen.contextOptions.acceptDownloads, false)
  assert.ok(seen.closed, 'the context is closed after the read')
  await assert.rejects(manager.readPage({ url: 'https://example.com/', hosts: LINKEDIN_HOSTS }), /may not open/)
  await assert.rejects(manager.readPage({ url: POST, hosts: [] }), /needs the hosts/)
  await manager.closeAll()
})

// ---- URLs ---------------------------------------------------------------------

test('a LinkedIn link has one canonical spelling', () => {
  assert.equal(canonicalLinkedinUrl(`${POST}?utm_source=share&trk=x#comments`).url, POST)
  assert.equal(canonicalLinkedinUrl('linkedin.com/feed/update/urn:li:activity:7123456789012345678').url, POST)
  assert.equal(canonicalLinkedinUrl('https://uk.linkedin.com/in/sam-lee').url, 'https://www.linkedin.com/in/sam-lee/')
  assert.equal(canonicalLinkedinUrl('https://www.linkedin.com/posts/sam-lee_launch-activity-71234-abcd').kind, 'post')
  assert.equal(canonicalLinkedinUrl('https://www.linkedin.com/messaging/thread/2-abc==/').kind, 'conversation')
  assert.throws(() => canonicalLinkedinUrl('https://evil.com/in/sam/'), /Not a LinkedIn link/)
  assert.throws(() => canonicalLinkedinUrl('https://www.linkedin.com/jobs/view/1/'), /must be/)
  assert.throws(() => canonicalLinkedinUrl(POST, { kinds: ['profile'] }), /a profile/)
  assert.throws(() => canonicalLinkedinUrl('javascript:alert(1)'), /Only https|Not a LinkedIn|Not a URL/)
})

test('the sign-in page, an authwall or a checkpoint mean signed out', () => {
  for (const u of ['https://www.linkedin.com/login?x', 'https://www.linkedin.com/authwall?trk=1', 'https://www.linkedin.com/checkpoint/challenge/1', 'https://www.linkedin.com/uas/login', 'https://example.com/']) assert.equal(signedOutPath(u), true, u)
  for (const u of ['https://www.linkedin.com/feed/', 'https://www.linkedin.com/notifications/', 'https://www.linkedin.com/in/login-expert/']) assert.equal(signedOutPath(u), false, u)
})

// ---- proposals ----------------------------------------------------------------

const comment = (extra = {}) => ({ kind: 'comment', targetUrl: POST, authorName: 'Sam Lee', postExcerpt: 'We shipped the new climbing wall today.', draftText: 'Congrats Sam, that wall looks great.', reason: 'A friend’s launch, worth a word', ...extra })

test('a proposal is checked before it is staged', () => {
  const ok = normalizeLinkedinProposal(comment({ targetUrl: `${POST}?utm=1`, postExcerpt: 'We shipped​ the‮ new wall' }))
  assert.equal(ok.targetUrl, POST)
  assert.equal(ok.postExcerpt, 'We shipped the new wall', 'format characters are dropped from the display-only excerpt')
  assert.equal(normalizeLinkedinProposal(comment({ kind: 'like', draftText: 'ignored' })).draftText, '')
  assert.throws(() => normalizeLinkedinProposal(comment({ draftText: '' })), /draftText is required for a comment/)
  assert.throws(() => normalizeLinkedinProposal(comment({ kind: 'connect' })), /a profile/)
  assert.equal(normalizeLinkedinProposal({ kind: 'connect', targetUrl: 'https://www.linkedin.com/in/sam-lee/', authorName: 'Sam Lee', reason: 'Met at the climbing gym opening' }).action, 'connect')
  assert.throws(() => normalizeLinkedinProposal({ kind: 'connect', targetUrl: 'https://www.linkedin.com/in/sam-lee/', authorName: 'Sam', reason: 'Met him at work', draftText: 'x'.repeat(301) }), /300/)
  assert.throws(() => normalizeLinkedinProposal(comment({ kind: 'message' })), /kind must be one of/)
  assert.throws(() => normalizeLinkedinProposal(comment({ reason: 'x' })), /reason is required/)
  assert.equal(proposalTitle(ok), 'Comment on Sam Lee’s post on LinkedIn')
})

const line = (id, target, status = 'open', note = null) => ({ id, kind: 'linkedin', title: `Like ${id}`, status, note, meta: { action: 'like', target, author: 'Sam' } })

test('a target is proposed once, ever, and at most five cards wait', () => {
  const card = normalizeLinkedinProposal(comment())
  assert.equal(stagingConflict([], card), null)
  assert.deepEqual(stagingConflict([line('P1', POST)], card), { alreadyProposed: { id: 'P1', status: 'open' } })
  assert.deepEqual(stagingConflict([line('P1', POST, 'resolved', 'skipped 2026-11-02')], card), { alreadyProposed: { id: 'P1', status: 'denied' } })
  assert.deepEqual(stagingConflict([line('P1', POST, 'resolved', 'confirmed 2026-11-02 → done on LinkedIn (like)')], card), { alreadyProposed: { id: 'P1', status: 'done' } })
  const open = Array.from({ length: MAX_PENDING }, (_, i) => line(`P${i + 10}`, `https://www.linkedin.com/in/p${i}/`))
  assert.deepEqual(stagingConflict(open, card), { capped: { pending: MAX_PENDING, max: MAX_PENDING } })
  const decided = open.map((l) => ({ ...l, status: 'resolved', note: 'skipped 2026-11-01' }))
  assert.equal(stagingConflict(decided, card), null, 'decided cards do not count against the cap')
  const history = linkedinHistory([{ id: 'P2', kind: 'todo', status: 'open', meta: {} }, line('P3', POST, 'resolved', 'confirmed 2026-11-03 → done'), line('P4', 'https://www.linkedin.com/in/x/')])
  assert.deepEqual(history.map((h) => [h.id, h.status, h.decided]), [['P4', 'open', null], ['P3', 'done', '2026-11-03']])
})

// ---- the reader ---------------------------------------------------------------

async function readerFixture(t, { pages = [], limit = 20, available = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-linkedin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'data', 'linkedin-tokens.json')
  const loads = []
  const browser = {
    available: () => available,
    readPage: async (opts) => {
      loads.push(opts)
      const next = pages.shift() || {}
      return { url: next.url || opts.url, status: next.status ?? 200, title: 'LinkedIn', data: { text: 'hello', links: [], posts: [], conversations: [] }, storageState: next.storageState || opts.storageState, blocked: [] }
    },
  }
  const runs = { tracked: [], unconfigured: [], track: async (source, fn) => { runs.tracked.push(source); return fn() }, markUnconfigured: (s, r) => runs.unconfigured.push([s, r]) }
  const reader = createLinkedinReader({ browser, file, runs, maxPagesPerHour: limit, pause: async () => {} })
  return { reader, file, loads, runs }
}

test('with no sign-in, nothing is read and the status says how to sign in', async (t) => {
  const { reader, loads, runs } = await readerFixture(t)
  const status = await reader.status()
  assert.equal(status.connected, false)
  assert.equal(status.state, 'not-signed-in')
  assert.match(status.nextStep, /preview_handoff/)
  await assert.rejects(reader.feed(), { code: 'LINKEDIN_NOT_CONNECTED' })
  await assert.rejects(reader.notifications(), /not connected/)
  assert.equal(loads.length, 0)
  assert.equal(runs.unconfigured[0][0], 'linkedin')
  const off = await readerFixture(t, { available: false })
  assert.equal((await off.reader.status()).state, 'unavailable')
})

test("signing in keeps only LinkedIn's cookies, in a private file, and checks them", async (t) => {
  const { reader, file, loads } = await readerFixture(t)
  assert.equal((await reader.signIn({ cookies: [cookie('SID', 'x', '.google.com')], origins: [] })).state, 'not-signed-in')
  assert.equal(loads.length, 0)
  const out = await reader.signIn(signedInState())
  assert.equal(out.connected, true)
  assert.equal(loads.length, 1, 'one read of the feed checks the sign-in')
  assert.deepEqual(loads[0].hosts, LINKEDIN_HOSTS)
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(saved.state.cookies.map((c) => c.name).sort(), ['JSESSIONID', 'li_at'])
  assert.deepEqual(saved.state.origins.map((o) => o.origin), ['https://www.linkedin.com'])
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await reader.status()).state, 'connected')
  await reader.signOut()
  assert.equal((await reader.status()).state, 'not-signed-in')
})

test('LinkedIn sending the browser to its sign-in page marks the sign-in ended', async (t) => {
  const { reader } = await readerFixture(t, { pages: [{}, { url: 'https://www.linkedin.com/authwall?trk=x' }] })
  await reader.signIn(signedInState())
  await assert.rejects(reader.messages(), { code: 'LINKEDIN_SIGNED_OUT', status: 401 })
  const status = await reader.status()
  assert.equal(status.state, 'signed-out')
  await assert.rejects(reader.feed(), { code: 'LINKEDIN_SIGNED_OUT' })
})

test('cookies LinkedIn rotates are kept, and the hour has a page budget', async (t) => {
  const rotated = { cookies: [cookie('li_at', 'AQEDArotated')], origins: [] }
  const { reader, file, loads } = await readerFixture(t, { limit: 3, pages: [{}, { storageState: rotated }] })
  await reader.signIn(signedInState())
  await reader.feed(5)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).state.cookies[0].value, 'AQEDArotated')
  await reader.profile('https://www.linkedin.com/in/sam-lee/?trk=x')
  assert.equal(loads.at(-1).url, 'https://www.linkedin.com/in/sam-lee/')
  await assert.rejects(reader.notifications(), { code: 'LINKEDIN_RATE_LIMIT' })
  assert.equal(loads.length, 3)
  assert.equal((await reader.status()).pagesLastHour, 3)
  await assert.rejects(reader.conversation('https://www.linkedin.com/in/sam/'), /a conversation/)
})

test('sessionCookie ignores an expired or foreign li_at', () => {
  assert.ok(sessionCookie(signedInState()))
  assert.equal(sessionCookie({ cookies: [cookie('li_at', 'x', '.linkedin.com', 1000)] }), null)
  assert.equal(sessionCookie({ cookies: [cookie('li_at', 'x', '.evil.com')] }), null)
  assert.deepEqual(linkedinOnly({ cookies: [cookie('a', '1', 'evil-linkedin.com')], origins: [] }).cookies, [])
})

// ---- the tools ----------------------------------------------------------------

test('propose_action stages only when connected, and passes the dedupe and the cap back', async () => {
  let connected = false
  const staged = []
  const answers = [{ id: 'P7' }, { alreadyProposed: { id: 'P7', status: 'denied' } }, { capped: { pending: 5, max: 5 } }]
  const tools = createLinkedinMcpTools({
    reader: { status: async () => ({ connected, state: connected ? 'connected' : 'not-signed-in', nextStep: connected ? null : 'Sign in.' }) },
    stage: async (card) => { staged.push(card); return answers.shift() },
    history: async () => [],
  })
  const off = await tools.totem_linkedin_propose_action(comment(), { actor: 'totem' })
  assert.equal(off.staged, false)
  assert.match(off.nextStep, /not connected/)
  assert.equal(staged.length, 0)
  connected = true
  const on = await tools.totem_linkedin_propose_action(comment({ targetUrl: `${POST}?utm=x` }), { actor: 'totem' })
  assert.deepEqual([on.staged, on.performed, on.id, on.targetUrl], [true, false, 'P7', POST])
  assert.equal(staged[0].src, 'totem')
  const again = await tools.totem_linkedin_propose_action(comment(), {})
  assert.deepEqual([again.staged, again.alreadyProposed], [false, { id: 'P7', status: 'denied' }])
  assert.match(again.nextStep, /never propose this one again/)
  const capped = await tools.totem_linkedin_propose_action(comment(), {})
  assert.deepEqual(capped.capped, { pending: 5, max: 5 })
  await assert.rejects(tools.totem_linkedin_propose_action(comment({ kind: 'reply', draftText: '' }), {}), /draftText is required/)
})

test('sign_in reads only the calling chat’s browser', async () => {
  const asked = []
  const tools = createLinkedinMcpTools({
    reader: { status: async () => ({ state: 'not-signed-in' }), signIn: async (state) => ({ connected: Boolean(state), state: 'connected' }) },
    stage: async () => ({}),
    history: async () => [],
    chatBrowserState: async (session) => { asked.push(session.chat.threadId); return session.chat.threadId === 'web-1' ? signedInState() : null },
  })
  assert.match((await tools.totem_linkedin_sign_in({}, { chat: null })).nextStep, /from a chat/)
  assert.match((await tools.totem_linkedin_sign_in({}, { chat: { threadId: 'web-2' } })).nextStep, /no browser open/)
  assert.equal((await tools.totem_linkedin_sign_in({}, { chat: { threadId: 'web-1' } })).connected, true)
  assert.deepEqual(asked, ['web-2', 'web-1'])
})

test('a stored sign-in file that is not JSON reads as not signed in', async (t) => {
  const { reader, file } = await readerFixture(t)
  await reader.signIn(signedInState())
  await writeFile(file, 'not json')
  assert.equal((await reader.status()).state, 'not-signed-in')
})
