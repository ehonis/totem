import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGmail, splitRef, GMAIL_SCOPE } from './index.mjs'
import { buildMessage, encodeHeader, parseAddressList, readPayload, htmlToText, replySubject } from './mime.mjs'

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url')

test('buildMessage folds header line breaks so no header can be injected', () => {
  const raw = buildMessage({ to: [{ name: '', email: 'a@x.com' }], subject: 'Hi\r\nBcc: evil@x.com', body: 'hello' })
  const head = raw.split('\r\n\r\n')[0]
  assert.equal(head.split('\r\n').filter((l) => /^bcc:/i.test(l)).length, 0)
  assert.match(head, /^Subject: Hi Bcc: evil@x.com$/m)
})

test('buildMessage writes a base64 UTF-8 body and encoded-word subjects', () => {
  const raw = buildMessage({
    to: [{ name: 'Zoë', email: 'z@x.com' }], cc: [{ name: 'Bo, Jr', email: 'b@x.com' }],
    subject: 'Café plans ☕', body: 'Line one\nLine two — ok', inReplyTo: '<m1@x>', references: '<m0@x> <m1@x>',
  })
  const [head, body] = raw.split('\r\n\r\n')
  assert.match(head, /^To: =\?UTF-8\?B\?.+\?= <z@x.com>$/m)
  assert.match(head, /^Cc: "Bo, Jr" <b@x.com>$/m)
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m)
  assert.match(head, /^In-Reply-To: <m1@x>$/m)
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Line one\r\nLine two — ok')
  const decoded = encodeHeader('Café plans ☕').split(' ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('')
  assert.equal(decoded, 'Café plans ☕')
})

test('parseAddressList keeps commas inside quoted names', () => {
  assert.deepEqual(parseAddressList('"Doe, Jane" <j@x.com>, b@y.com; Al <a@z.io>'), [
    { name: 'Doe, Jane', email: 'j@x.com' }, { name: '', email: 'b@y.com' }, { name: 'Al', email: 'a@z.io' },
  ])
  assert.deepEqual(parseAddressList(['a@x.com', 'b@x.com, c@x.com']).map((a) => a.email), ['a@x.com', 'b@x.com', 'c@x.com'])
})

test('readPayload prefers text/plain, falls back to html, and lists attachments', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: { data: b64u('<p>Hi <b>there</b></p>') } },
      ] },
      { mimeType: 'application/pdf', filename: 'r.pdf', body: { attachmentId: 'att1', size: 9 } },
    ],
  }
  const out = readPayload(payload)
  assert.equal(out.text, 'Hi there')
  assert.equal(out.hasHtml, true)
  assert.deepEqual(out.attachments, [{ attachmentId: 'att1', filename: 'r.pdf', mimeType: 'application/pdf', size: 9 }])
  payload.parts[0].parts.unshift({ mimeType: 'text/plain', body: { data: b64u('plain wins') } })
  assert.equal(readPayload(payload).text, 'plain wins')
})

test('htmlToText keeps link targets and drops styles', () => {
  assert.equal(htmlToText('<style>x{}</style><a href="https://a.co/x">Track</a>&amp;<br>next'), 'Track (https://a.co/x)&\nnext')
})

test('replySubject adds Re: once', () => {
  assert.equal(replySubject('Lunch'), 'Re: Lunch')
  assert.equal(replySubject('RE: Lunch'), 'RE: Lunch')
})

test('splitRef resolves account:id and bare ids', () => {
  assert.deepEqual(splitRef('personal:abc', null, ['personal', 'side']), { account: 'personal', id: 'abc' })
  assert.deepEqual(splitRef('abc', null, ['personal']), { account: 'personal', id: 'abc' })
  assert.throws(() => splitRef('abc', null, ['personal', 'side']), /which account/)
})

// ---- Client against a fake Gmail ------------------------------------------------

function harness({ accounts = { personal: { refresh_token: 'r1', email: 'me@example.com' } } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-'))
  const tokensFile = join(dir, 'gmail-tokens.json')
  writeFileSync(tokensFile, JSON.stringify(accounts))
  const calls = []
  const routes = []
  const on = (method, re, fn) => routes.push({ method, re, fn })
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    const method = init.method || 'GET'
    calls.push({ method, path: u.pathname, query: u.searchParams, body: init.body })
    if (u.hostname === 'oauth2.googleapis.com') {
      if (u.pathname === '/token') {
        const p = new URLSearchParams(String(init.body))
        if (p.get('grant_type') === 'refresh_token') return json({ access_token: `at-${p.get('refresh_token')}`, expires_in: 3600 })
        return json({ access_token: 'at-new', refresh_token: 'r-new', expires_in: 3600, scope: GMAIL_SCOPE })
      }
      return json({})
    }
    const path = u.pathname.replace('/gmail/v1/users/me', '')
    const route = routes.find((r) => r.method === method && r.re.test(path))
    if (!route) return json({ error: { message: `no route ${method} ${path}` } }, 404)
    return json(await route.fn({ path, query: u.searchParams, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization }))
  }
  const gmail = createGmail({
    tokensFile,
    cacheDir: join(dir, 'cache'),
    loadClient: () => ({ installed: { client_id: 'cid', client_secret: 'sec' } }),
    redirectUri: () => 'http://localhost:8787/gmail-oauth/callback',
    fetchImpl,
  })
  return { gmail, calls, on, tokensFile }
}

function json(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj }
}

const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }))

test('search merges accounts and tags ids with the account', async () => {
  const { gmail, on } = harness({ accounts: { personal: { refresh_token: 'r1' }, side: { refresh_token: 'r2' } } })
  on('GET', /^\/messages$/, ({ auth }) => ({ messages: [{ id: auth.endsWith('r1') ? 'm1' : 'm2' }] }))
  on('GET', /^\/messages\/m[12]$/, ({ path }) => ({
    id: path.slice(10), threadId: `t${path.slice(-1)}`, labelIds: ['INBOX', 'UNREAD'], snippet: 's',
    payload: { headers: hdrs({ From: 'a@x.com', Subject: `S${path.slice(-1)}`, Date: path.endsWith('1') ? 'Mon, 1 Jan 2026 10:00:00 +0000' : 'Tue, 2 Jan 2026 10:00:00 +0000' }) },
  }))
  const out = await gmail.search({ query: 'is:unread' })
  assert.deepEqual(out.messages.map((m) => m.id), ['side:m2', 'personal:m1'])
  assert.equal(out.messages[0].threadId, 'side:t2')
  assert.equal(out.messages[0].unread, true)
})

test('prepareEmail threads a reply to the original sender', async () => {
  const { gmail, on } = harness()
  on('GET', /^\/messages\/m1$/, () => ({
    id: 'm1', threadId: 't1', snippet: 'lunch?',
    payload: { headers: hdrs({ From: 'Amy <amy@x.com>', To: 'me@example.com, bo@x.com', Cc: 'cy@x.com', Subject: 'Lunch', 'Message-ID': '<orig@x>', References: '<root@x>' }) },
  }))
  const email = await gmail.prepareEmail({ replyTo: 'personal:m1', body: 'Sure, noon works.', replyAll: true })
  assert.deepEqual(email.to, [{ name: 'Amy', email: 'amy@x.com' }])
  assert.deepEqual(email.cc.map((x) => x.email), ['bo@x.com', 'cy@x.com'])
  assert.equal(email.subject, 'Re: Lunch')
  assert.equal(email.inReplyTo, '<orig@x>')
  assert.equal(email.references, '<root@x> <orig@x>')
  assert.equal(email.threadId, 'personal:t1')
  assert.equal(email.from, 'me@example.com')
  assert.equal(email.inReplyToMessage.from, 'Amy <amy@x.com>')
})

test('prepareEmail refuses bad addresses and missing subjects', async () => {
  const { gmail } = harness()
  await assert.rejects(gmail.prepareEmail({ to: 'not-an-address', subject: 's', body: 'b' }), /not an email address/)
  await assert.rejects(gmail.prepareEmail({ to: 'a@x.com', body: 'b' }), /subject is required/)
  await assert.rejects(gmail.prepareEmail({ to: 'a@x.com', subject: 's', body: ' ' }), /body is required/)
})

test('createDraft posts a raw message in the reply thread', async () => {
  const { gmail, on, calls } = harness()
  on('POST', /^\/drafts$/, () => ({ id: 'd1', message: { id: 'm9' } }))
  const email = { account: 'personal', from: 'me@example.com', to: [{ name: '', email: 'a@x.com' }], cc: [], bcc: [], subject: 'Hi', body: 'Hello', threadId: 'personal:t1', inReplyTo: '<o@x>', references: '<o@x>' }
  const out = await gmail.createDraft({ prepared: email })
  assert.equal(out.draftId, 'personal:d1')
  const body = JSON.parse(calls.find((c) => c.path.endsWith('/drafts')).body)
  assert.equal(body.message.threadId, 't1')
  const raw = Buffer.from(body.message.raw, 'base64url').toString('utf8')
  assert.match(raw, /^To: a@x.com$/m)
  assert.match(raw, /^In-Reply-To: <o@x>$/m)
})

test('modify resolves label names and archive removes INBOX', async () => {
  const { gmail, on, calls } = harness()
  on('GET', /^\/labels$/, () => ({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_7', name: 'Receipts', type: 'user' }] }))
  on('POST', /^\/messages\/batchModify$/, () => ({}))
  const out = await gmail.modify({ ids: ['personal:m1', 'm2'], add: ['receipts'], remove: ['INBOX'] })
  assert.equal(out.changed, 2)
  const body = JSON.parse(calls.find((c) => c.path.endsWith('batchModify')).body)
  assert.deepEqual(body, { ids: ['m1', 'm2'], addLabelIds: ['Label_7'], removeLabelIds: ['INBOX'] })
  await assert.rejects(gmail.modify({ ids: ['m1'], add: ['Nope'] }), /not a label/)
})

test('one token refresh is shared by concurrent calls', async () => {
  const { gmail, on, calls } = harness()
  on('GET', /^\/profile$/, () => ({ emailAddress: 'me@example.com' }))
  await Promise.all([gmail.listAccounts(), gmail.listAccounts(), gmail.listAccounts()])
  assert.equal(calls.filter((c) => c.path === '/token').length, 1)
})

test('completeAuth stores the account 0600 and rejects a grant without Gmail', async () => {
  const { gmail, on, tokensFile } = harness({ accounts: {} })
  on('GET', /^\/profile$/, () => ({ emailAddress: 'new@example.com' }))
  const { authUrl } = gmail.startAuth({ label: 'side' })
  const url = new URL(authUrl)
  assert.equal(url.searchParams.get('scope'), GMAIL_SCOPE)
  const state = url.searchParams.get('state')
  const res = await gmail.completeAuth(new URLSearchParams({ state, code: 'c' }))
  assert.equal(res.ok, true, res.message)
  const saved = JSON.parse(readFileSync(tokensFile, 'utf8'))
  assert.equal(saved.side.email, 'new@example.com')
  assert.equal(saved.side.refresh_token, 'r-new')
  assert.equal(statSync(tokensFile).mode & 0o777, 0o600)
  assert.equal((await gmail.completeAuth(new URLSearchParams({ state, code: 'c' }))).ok, false, 'a state is single-use')
})

test('readThread falls back from a message id to its thread', async () => {
  const { gmail, on } = harness()
  on('GET', /^\/messages\/m1$/, () => ({ id: 'm1', threadId: 't1' }))
  on('GET', /^\/threads\/t1$/, () => ({
    id: 't1', messages: [{ id: 'm1', threadId: 't1', labelIds: [], payload: { mimeType: 'text/plain', headers: hdrs({ Subject: 'Yo', From: 'a@x.com' }), body: { data: b64u('body text') } } }],
  }))
  const out = await gmail.readThread({ id: 'm1' })
  assert.equal(out.threadId, 'personal:t1')
  assert.equal(out.messages[0].body, 'body text')
})
