import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDrive, buildQuery, tabRef, DRIVE_SCOPE, TYPES } from './index.mjs'

function json(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj, arrayBuffer: async () => Buffer.from(JSON.stringify(obj)) }
}
function bytes(s, status = 200) {
  return { ok: status < 400, status, text: async () => s, arrayBuffer: async () => Buffer.from(s) }
}

function harness({ accounts = { personal: { refresh_token: 'r1', email: 'me@example.com' } } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drive-'))
  const tokensFile = join(dir, 'drive-tokens.json')
  writeFileSync(tokensFile, JSON.stringify(accounts))
  const calls = []
  const routes = []
  const on = (method, host, re, fn) => routes.push({ method, host, re, fn })
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    const method = init.method || 'GET'
    calls.push({ method, host: u.hostname, path: u.pathname, query: u.searchParams, body: init.body, headers: init.headers })
    if (u.hostname === 'oauth2.googleapis.com') {
      const p = new URLSearchParams(String(init.body))
      if (p.get('grant_type') === 'refresh_token') return json({ access_token: `at-${p.get('refresh_token')}`, expires_in: 3600 })
      return json({ access_token: 'at-new', refresh_token: 'r-new', expires_in: 3600, scope: DRIVE_SCOPE })
    }
    const route = routes.find((r) => r.method === method && u.hostname.startsWith(r.host) && r.re.test(u.pathname))
    if (!route) return json({ error: { message: `no route ${method} ${u.hostname}${u.pathname}` } }, 404)
    const out = await route.fn({ path: u.pathname, query: u.searchParams, body: init.body, auth: init.headers?.Authorization })
    return out?.ok !== undefined && out?.status ? out : json(out)
  }
  const drive = createDrive({
    tokensFile,
    cacheDir: join(dir, 'cache'),
    loadClient: () => ({ installed: { client_id: 'cid', client_secret: 'sec' } }),
    redirectUri: () => 'http://localhost:8787/drive-oauth/callback',
    fetchImpl,
  })
  return { drive, calls, on, tokensFile }
}

test('buildQuery turns words into a name/full-text search and skips trash', () => {
  assert.equal(buildQuery({ query: "Acme Co's HQ" }), "(name contains 'Acme Co\\'s HQ' or fullText contains 'Acme Co\\'s HQ') and trashed = false")
  assert.equal(buildQuery({ type: 'sheet', folderId: 'F1' }), `mimeType = '${TYPES.sheet}' and 'F1' in parents and trashed = false`)
  assert.equal(buildQuery({ q: 'trashed = true' }), '(trashed = true)')
  assert.throws(() => buildQuery({ type: 'spreadsheetz' }), /type:/)
})

test('tabRef quotes tab names A1 notation cannot take bare', () => {
  assert.equal(tabRef('Sheet1'), 'Sheet1')
  assert.equal(tabRef('Action Items'), "'Action Items'")
  assert.equal(tabRef("Owner's"), "'Owner''s'")
})

test('search merges accounts, newest first, with account-tagged ids', async () => {
  const { drive, on } = harness({ accounts: { personal: { refresh_token: 'r1' }, work: { refresh_token: 'r2' } } })
  on('GET', 'www.googleapis.com', /\/drive\/v3\/files$/, ({ auth }) => ({
    files: auth.endsWith('r1')
      ? [{ id: 'a', name: 'Old', mimeType: TYPES.doc, modifiedTime: '2026-01-01T00:00:00Z' }]
      : [{ id: 'b', name: 'New', mimeType: TYPES.sheet, modifiedTime: '2026-02-01T00:00:00Z', parents: ['p'] }],
  }))
  const out = await drive.search({})
  assert.deepEqual(out.files.map((f) => f.id), ['work:b', 'personal:a'])
  assert.equal(out.files[0].type, 'sheet')
  assert.deepEqual(out.files[0].parents, ['work:p'])
})

test('sheetWrite sends USER_ENTERED values to the right spreadsheet', async () => {
  const { drive, on, calls } = harness()
  on('POST', 'sheets.googleapis.com', /values:batchUpdate$/, () => ({ totalUpdatedCells: 3, totalUpdatedRows: 1, responses: [{ updatedRange: "'Action Items'!B5:D5" }] }))
  const out = await drive.sheetWrite({ id: 'personal:S1', data: [{ range: "'Action Items'!B5:D5", values: ['Call DJ', 'High', null] }] })
  assert.equal(out.updatedCells, 3)
  const call = calls.find((c) => c.host === 'sheets.googleapis.com')
  assert.equal(call.path, '/v4/spreadsheets/S1/values:batchUpdate')
  assert.deepEqual(JSON.parse(call.body), { valueInputOption: 'USER_ENTERED', data: [{ range: "'Action Items'!B5:D5", values: [['Call DJ', 'High', '']] }] })
})

test('sheetAppend inserts rows after the table in the named tab', async () => {
  const { drive, on, calls } = harness()
  on('POST', 'sheets.googleapis.com', /:append$/, () => ({ updates: { updatedRange: "'Action Items'!B40:C40", updatedRows: 1 } }))
  const out = await drive.sheetAppend({ id: 'S1', range: 'Action Items', values: [['x', 'y']] })
  assert.equal(out.updatedRows, 1)
  const call = calls.find((c) => c.host === 'sheets.googleapis.com')
  assert.equal(decodeURIComponent(call.path), '/v4/spreadsheets/S1/values/Action Items:append')
  assert.equal(call.query.get('insertDataOption'), 'INSERT_ROWS')
})

test('readFile gives a Sheet its tabs and a preview of the first one', async () => {
  const { drive, on, calls } = harness()
  on('GET', 'www.googleapis.com', /\/files\/S1$/, () => ({ id: 'S1', name: 'Acme Co HQ', mimeType: TYPES.sheet }))
  on('GET', 'sheets.googleapis.com', /\/spreadsheets\/S1$/, () => ({
    spreadsheetId: 'S1', properties: { title: 'Acme Co HQ' },
    sheets: [{ properties: { sheetId: 0, title: 'Action Items', index: 0, gridProperties: { rowCount: 100, columnCount: 9 } } }],
  }))
  on('GET', 'sheets.googleapis.com', /values:batchGet$/, ({ query }) => ({ valueRanges: [{ range: query.get('ranges'), values: [['Task Name', 'Who']] }] }))
  const out = await drive.readFile({ id: 'S1' })
  assert.equal(out.format, 'sheet')
  assert.equal(out.tabs[0].title, 'Action Items')
  assert.deepEqual(out.preview.values, [['Task Name', 'Who']])
  assert.equal(calls.find((c) => c.path.endsWith('batchGet')).query.get('ranges'), "'Action Items'!1:200")
})

test('readFile exports a Doc as Markdown, falling back to plain text', async () => {
  const { drive, on } = harness()
  on('GET', 'www.googleapis.com', /\/files\/D1$/, () => ({ id: 'D1', name: 'Plan', mimeType: TYPES.doc }))
  on('GET', 'www.googleapis.com', /\/files\/D1\/export$/, ({ query }) => (query.get('mimeType') === 'text/markdown'
    ? json({ error: { message: 'bad export' } }, 400) : bytes('# Plan\nhello')))
  const out = await drive.readFile({ id: 'D1' })
  assert.equal(out.content, '# Plan\nhello')
})

test('readFile saves a binary file to the cache and returns its path', async () => {
  const { drive, on } = harness()
  on('GET', 'www.googleapis.com', /\/files\/X1$/, ({ query }) => (query.get('alt') === 'media'
    ? bytes('PK\u0003\u0004')
    : { id: 'X1', name: 'HQ.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const out = await drive.readFile({ id: 'X1' })
  assert.equal(out.format, 'download')
  assert.equal(readFileSync(out.path, 'utf8'), 'PK\u0003\u0004')
})

test('copyFile with convert turns an .xlsx into a Google Sheet', async () => {
  const { drive, on, calls } = harness()
  on('GET', 'www.googleapis.com', /\/files\/X1$/, () => ({ id: 'X1', name: 'HQ.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  on('POST', 'www.googleapis.com', /\/files\/X1\/copy$/, () => ({ id: 'S2', name: 'HQ', mimeType: TYPES.sheet }))
  const out = await drive.copyFile({ id: 'X1', convert: true })
  assert.equal(out.file.id, 'personal:S2')
  assert.deepEqual(JSON.parse(calls.find((c) => c.path.endsWith('/copy')).body), { mimeType: TYPES.sheet, name: 'HQ' })
})

test('createFile uploads CSV that Drive converts into a Sheet', async () => {
  const { drive, on, calls } = harness()
  on('POST', 'www.googleapis.com', /\/upload\/drive\/v3\/files$/, () => ({ id: 'N1', name: 'Budget', mimeType: TYPES.sheet }))
  await drive.createFile({ name: 'Budget', type: 'sheet', content: 'a,b\n1,2' })
  const call = calls.find((c) => c.path === '/upload/drive/v3/files')
  assert.equal(call.query.get('uploadType'), 'multipart')
  assert.match(call.body, new RegExp(`"mimeType":"${TYPES.sheet}"`))
  assert.match(call.body, /content-type: text\/csv/)
})

test('updateFile moves a file out of its old folder', async () => {
  const { drive, on, calls } = harness()
  on('GET', 'www.googleapis.com', /\/files\/F1$/, () => ({ id: 'F1', parents: ['old1', 'old2'] }))
  on('PATCH', 'www.googleapis.com', /\/files\/F1$/, () => ({ id: 'F1', name: 'x', parents: ['new'] }))
  await drive.updateFile({ id: 'F1', moveTo: 'new' })
  const patch = calls.find((c) => c.method === 'PATCH')
  assert.equal(patch.query.get('addParents'), 'new')
  assert.equal(patch.query.get('removeParents'), 'old1,old2')
  await assert.rejects(drive.updateFile({ id: 'F1' }), /nothing to change/)
})

test('trash only moves to Trash; there is no delete call', async () => {
  const { drive, on, calls } = harness()
  on('PATCH', 'www.googleapis.com', /\/files\/[AB]$/, ({ path }) => ({ id: path.slice(-1), trashed: true }))
  const out = await drive.trash({ ids: ['A', 'personal:B'] })
  assert.equal(out.changed, 2)
  assert.equal(calls.some((c) => c.method === 'DELETE'), false)
  assert.deepEqual(JSON.parse(calls.find((c) => c.method === 'PATCH').body), { trashed: true })
})

test('docEdit batches replace, prepend and append', async () => {
  const { drive, on, calls } = harness()
  on('POST', 'docs.googleapis.com', /:batchUpdate$/, () => ({ replies: [{ replaceAllText: { occurrencesChanged: 2 } }, {}, {}] }))
  const out = await drive.docEdit({ id: 'D1', replace: [{ find: 'Q3', with: 'Q4' }], prepend: 'Top\n', append: '\nEnd' })
  assert.deepEqual(out.replacements, [2])
  const { requests } = JSON.parse(calls.find((c) => c.host === 'docs.googleapis.com').body)
  assert.deepEqual(requests.map((r) => Object.keys(r)[0]), ['replaceAllText', 'insertText', 'insertText'])
  assert.deepEqual(requests[2].insertText.endOfSegmentLocation, {})
})

test('a disabled API names the API to enable', async () => {
  const { drive, on } = harness()
  on('GET', 'sheets.googleapis.com', /values:batchGet$/, () => json({ error: { message: 'Google Sheets API has not been used in project 1 before or it is disabled.' } }, 403))
  await assert.rejects(drive.sheetRead({ id: 'S1', ranges: ['A1'] }), /Google Sheets API is not enabled/)
})

test('sign-in asks for the full drive scope', () => {
  const { drive } = harness({ accounts: {} })
  const url = new URL(drive.startAuth({ label: 'work' }).authUrl)
  assert.equal(url.searchParams.get('scope'), DRIVE_SCOPE)
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8787/drive-oauth/callback')
})
