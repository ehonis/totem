// Run with: node --test todos/connectors/task-sheet-feed.test.mjs
//
// The read-only task sheet feed, against the real Drive client (drive/index.mjs)
// over a fake fetch. Nothing here reaches Google. Fixtures follow the shared
// sheet's shape: a title block, headers on row 4 from column B, data from row 5.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDrive, DRIVE_SCOPE } from '../../drive/index.mjs'
import {
  createTaskSheetFeed, parseSheetRows, parseDueDate, parsePriority, rangeStart, columnLetter, findHeader, TASK_SHEET_SOURCE,
} from './task-sheet-feed.mjs'

const SHEET_ID = 'sheet-abc'
const GID = 314
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`
const ENV = { TASK_SHEET_ID: SHEET_ID, TASK_SHEET_ASSIGNEES: 'Alex, Alex & Sam' }

const HEADERS = ['Task Name', 'Who', 'Priority', 'Status', 'Due Date', 'Notes & Links', 'Tag']
// As the Sheets API returns the whole tab: from A1, formatted values, trailing blanks cut.
function liveShape(rows) {
  return [
    ['', 'Example HQ'],
    ['', 'Action items, updated weekly'],
    [],
    ['', ...HEADERS],
    ...rows.map((r) => ['', ...r]),
  ]
}
const ROWS = [
  ['Book the venue', 'Alex', 'High', 'Not Started', '11/23/2026', 'https://example.com/venue'],         // row 5
  ['Send the deck', 'Sam', 'Medium', 'Not Started', '11/24/2026', ''],                                   // row 6: not ours
  ['Draft the budget', 'Alex & Sam', 'Low', 'In Progress', '', 'see tab 2', 'Ops', 'stray', 'cells'],    // row 7
  ['File the permit', 'Alex', 'High', 'Done', '11/1/2026', ''],                                          // row 8: done
  ['', 'Alex', 'High', 'Not Started', '11/30/2026', ''],                                                 // row 9: no title
  ['Order signage', 'alex', 'Urgent', '', 'next week', ''],                                              // row 10
]

function fakeRuns() {
  const tracked = []
  const unconfigured = []
  return {
    tracked, unconfigured,
    async track(source, fn, opts) {
      const entry = { source }
      tracked.push(entry)
      try {
        const out = await fn()
        entry.ok = true
        entry.rows = opts?.rows ? opts.rows(out) : null
        return out
      } catch (e) {
        entry.ok = !opts?.isFault?.(e)
        throw e
      }
    },
    markUnconfigured(source, reason) { unconfigured.push({ source, reason }) },
  }
}

function json(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj }
}

/** The real Drive client over a fake Google: one spreadsheet, one tab. */
function harness({ accounts = { personal: { refresh_token: 'r1' } }, values = liveShape(ROWS), range = "'Action Items'!A1:J10", env = ENV, tokenStatus = 200, clock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'task-sheet-feed-'))
  const tokensFile = join(dir, 'drive-tokens.json')
  writeFileSync(tokensFile, JSON.stringify(accounts))
  const calls = []
  const sheet = { values, range, fail: null, title: 'Example HQ', tabs: [{ sheetId: 0, title: 'Overview' }, { sheetId: GID, title: 'Action Items' }] }
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    const method = init.method || 'GET'
    calls.push({ method, host: u.hostname, path: decodeURIComponent(u.pathname), query: u.searchParams, auth: init.headers?.Authorization })
    if (u.hostname === 'oauth2.googleapis.com') {
      if (tokenStatus !== 200) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, tokenStatus)
      const p = new URLSearchParams(String(init.body))
      return json({ access_token: `at-${p.get('refresh_token')}`, expires_in: 3600, scope: DRIVE_SCOPE })
    }
    if (u.hostname !== 'sheets.googleapis.com') return json({ error: { message: 'unexpected host' } }, 500)
    if (sheet.fail) return json({ error: { message: sheet.fail.message } }, sheet.fail.status)
    if (u.pathname.endsWith('/values:batchGet')) {
      return json({ valueRanges: [{ range: sheet.range, majorDimension: 'ROWS', values: sheet.values }] })
    }
    return json({
      spreadsheetId: SHEET_ID,
      properties: { title: sheet.title, timeZone: 'America/New_York' },
      sheets: sheet.tabs.map((t, index) => ({ properties: { ...t, index, gridProperties: { rowCount: 100, columnCount: 10 } } })),
    })
  }
  const time = clock || { now: Date.parse('2026-11-09T15:00:00Z') }
  const drive = createDrive({
    tokensFile,
    cacheDir: join(dir, 'cache'),
    loadClient: () => ({ installed: { client_id: 'cid', client_secret: 'sec' } }),
    redirectUri: () => 'http://localhost:8787/drive-oauth/callback',
    fetchImpl,
    now: () => time.now,
  })
  const runs = fakeRuns()
  const feed = createTaskSheetFeed({ drive, runs, env: { ...env }, now: () => time.now })
  const sheetCalls = () => calls.filter((c) => c.host === 'sheets.googleapis.com')
  return { feed, drive, calls, sheetCalls, sheet, runs, time }
}

// ---- parsing ----------------------------------------------------------------

test('finds the header under a title block and maps the open rows for the assignees', async () => {
  const { feed } = harness()
  const out = await feed.read()
  assert.equal(out.configured, true)
  assert.equal(out.title, 'Example HQ')
  assert.equal(out.url, SHEET_URL)
  assert.equal(out.stale, false)
  assert.equal(out.error, null)
  assert.ok(Date.parse(out.fetchedAt))
  assert.deepEqual(out.items.map((i) => [i.row, i.title, i.who, i.priority, i.status, i.dueDate]), [
    [5, 'Book the venue', 'Alex', 1, 'Not Started', '2026-11-23'],
    [7, 'Draft the budget', 'Alex & Sam', 3, 'In Progress', null],
    [10, 'Order signage', 'alex', null, '', null],
  ])
  const [first] = out.items
  assert.match(first.id, new RegExp(`^sheet:${GID}:5:[0-9a-f]{8}$`))
  assert.equal(first.url, `${SHEET_URL}#gid=${GID}&range=B5`)
  assert.equal(first.notes, 'https://example.com/venue')
  assert.deepEqual(Object.keys(first).sort(), ['dueDate', 'id', 'notes', 'priority', 'row', 'status', 'title', 'url', 'who'])
})

test('columns are matched by header text, in any order, wherever the range starts', () => {
  const values = [
    ['Team tracker'],
    ['Status', 'Notes & Links', 'Owner notes', 'Due Date', 'Who', 'Priority', 'Task Name'],
    ['In Progress', 'n1', 'x', '12/1/2026', 'Alex', 'Medium', 'Shuffled task'],
    ['Done', '', '', '', 'Alex', 'High', 'Finished'],
  ]
  // A range that starts at C3: the header is on sheet row 4, the task in column I.
  const items = parseSheetRows({ values, start: rangeStart("'Action Items'!C3:I6"), gid: 7, assignees: ['alex'], sheetUrl: SHEET_URL })
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    id: items[0].id, row: 5, title: 'Shuffled task', who: 'Alex', priority: 2, status: 'In Progress',
    dueDate: '2026-12-01', notes: 'n1', url: `${SHEET_URL}#gid=7&range=I5`,
  })
})

test('stray cells past the table and a Tag column change nothing', () => {
  const plain = parseSheetRows({ values: liveShape([ROWS[0]]), gid: GID, assignees: ['alex'], sheetUrl: SHEET_URL })
  const noisy = parseSheetRows({
    values: liveShape([[...ROWS[0], 'Ops', 'Task Name', 'Who', '=junk', '']]),
    gid: GID, assignees: ['alex'], sheetUrl: SHEET_URL,
  })
  assert.deepEqual(noisy, plain)
})

test('Who matches an assignee trimmed and case-insensitively, inner spaces folded', () => {
  const rows = [
    ['a', ' ALEX ', '', 'Not Started', '', ''],
    ['b', 'Alex  &   Sam', '', 'Not Started', '', ''],
    ['c', 'Sam', '', 'Not Started', '', ''],
    ['d', 'Alexander', '', 'Not Started', '', ''],
    ['e', '', '', 'Not Started', '', ''],
  ]
  const items = parseSheetRows({ values: liveShape(rows), gid: GID, assignees: ['alex', 'alex & sam'], sheetUrl: SHEET_URL })
  assert.deepEqual(items.map((i) => i.title), ['a', 'b'])
  assert.equal(items[0].who, 'ALEX', 'the cell is shown as written, trimmed')
})

test('Done is filtered whatever its case; In Progress, Not Started and blank stay', () => {
  const rows = ['Done', ' done ', 'DONE', 'In Progress', 'Not Started', '', 'Blocked'].map((status, i) => [`t${i}`, 'Alex', '', status, '', ''])
  const items = parseSheetRows({ values: liveShape(rows), gid: GID, assignees: ['alex'], sheetUrl: SHEET_URL })
  assert.deepEqual(items.map((i) => i.status), ['In Progress', 'Not Started', '', 'Blocked'])
})

test('due dates: M/D/YYYY and ISO become day keys; blanks, junk and impossible dates are null', () => {
  assert.equal(parseDueDate('11/23/2026'), '2026-11-23')
  assert.equal(parseDueDate(' 1/5/2027 '), '2027-01-05')
  assert.equal(parseDueDate('2/29/2028'), '2028-02-29')
  assert.equal(parseDueDate('2026-11-23'), '2026-11-23')
  for (const junk of ['', null, undefined, 'next week', 'TBD', '2/30/2026', '2/29/2027', '13/1/2026', '0/10/2026', '11/0/2026', '11/23/26', '23/11/2026', '45992', '11-23-2026']) {
    assert.equal(parseDueDate(junk), null, String(junk))
  }
})

test('priority: High 1, Medium 2, Low 3, anything else null', () => {
  assert.deepEqual(['High', ' medium ', 'LOW', 'Urgent', '', null, 'P1'].map(parsePriority), [1, 2, 3, null, null, null, null])
})

test('ids stay put across reads and change when the row or its title does', () => {
  const read = (rows) => parseSheetRows({ values: liveShape(rows), gid: GID, assignees: ['alex'], sheetUrl: SHEET_URL })
  const a = read([ROWS[0]])[0]
  assert.equal(read([ROWS[0]])[0].id, a.id)
  // Status, date, notes and priority edits keep the id.
  assert.equal(read([['Book the venue', 'Alex', 'Low', 'In Progress', '12/1/2026', 'moved']])[0].id, a.id)
  assert.notEqual(read([['Book the hall', 'Alex', 'High', 'Not Started', '', '']])[0].id, a.id)
  const shifted = read([['x', 'Sam', '', '', '', ''], ROWS[0]])[0]
  assert.equal(shifted.row, 6)
  assert.notEqual(shifted.id, a.id)
  assert.equal(shifted.id.split(':')[3], a.id.split(':')[3], 'the title hash is the same')
})

test('the header must be in the first ten rows and name Who and Status', () => {
  const late = [...Array.from({ length: 10 }, () => ['']), ['Task Name', 'Who', 'Status']]
  assert.equal(findHeader(late), null)
  assert.throws(() => parseSheetRows({ values: late, gid: 0, assignees: ['alex'], sheetUrl: SHEET_URL }), /No header row/)
  assert.throws(() => parseSheetRows({ values: [['Task Name', 'Owner', 'Status']], gid: 0, assignees: ['alex'], sheetUrl: SHEET_URL }), /"Who"/)
  assert.ok(findHeader([['Task Name ', 'Who', 'Status']]), 'a trailing space in the header cell is fine')
})

test('rangeStart and columnLetter', () => {
  assert.deepEqual(rangeStart("'Action Items'!A1:Z1000"), { row: 1, col: 0 })
  assert.deepEqual(rangeStart("'It''s'!B4:G60"), { row: 4, col: 1 })
  assert.deepEqual(rangeStart('Sheet1!$AA$10'), { row: 10, col: 26 })
  assert.deepEqual(rangeStart('Sheet1'), { row: 1, col: 0 })
  assert.deepEqual([0, 1, 25, 26, 27, 701, 702].map(columnLetter), ['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
})

// ---- the feed -----------------------------------------------------------------

test('not configured: says what to set, reads nothing, and marks the source not set up', async () => {
  for (const [env, missing] of [[{}, /TASK_SHEET_ID and TASK_SHEET_ASSIGNEES/], [{ TASK_SHEET_ID: 'x' }, /TASK_SHEET_ASSIGNEES/], [{ TASK_SHEET_ASSIGNEES: 'Alex' }, /TASK_SHEET_ID/]]) {
    const { feed, calls, runs } = harness({ env })
    const out = await feed.read()
    assert.deepEqual(Object.keys(out).sort(), ['configured', 'items', 'reason'])
    assert.equal(out.configured, false)
    assert.deepEqual(out.items, [])
    assert.match(out.reason, missing)
    assert.equal(calls.length, 0)
    assert.deepEqual(runs.unconfigured.map((u) => u.source), [TASK_SHEET_SOURCE])
    await feed.read()
    assert.equal(runs.unconfigured.length, 1, 'once per cache window, not on every poll')
    assert.equal(feed.status().configured, false)
  }
})

test('no Drive account, several without TASK_SHEET_ACCOUNT, or an unknown one: not configured, with the fix', async () => {
  const none = harness({ accounts: {} })
  assert.match((await none.feed.read()).reason, /Connect a Google Drive account/)
  const two = { personal: { refresh_token: 'r1' }, work: { refresh_token: 'r2', email: 'work@example.com' } }
  const several = harness({ accounts: two })
  const out = await several.feed.read()
  assert.equal(out.configured, false)
  assert.match(out.reason, /Several Google Drive accounts.*TASK_SHEET_ACCOUNT/)
  const unknown = harness({ accounts: two, env: { ...ENV, TASK_SHEET_ACCOUNT: 'side' } })
  assert.match((await unknown.feed.read()).reason, /No Google Drive account "side"/)
  for (const h of [none, several, unknown]) assert.equal(h.calls.length, 0)
})

test('TASK_SHEET_ACCOUNT picks the account, by label or address', async () => {
  const two = { personal: { refresh_token: 'r1' }, work: { refresh_token: 'r2', email: 'work@example.com' } }
  for (const account of ['work', 'WORK@example.com']) {
    const { feed, sheetCalls } = harness({ accounts: two, env: { ...ENV, TASK_SHEET_ACCOUNT: account } })
    assert.equal((await feed.read()).items.length, 3)
    assert.ok(sheetCalls().every((c) => c.auth === 'Bearer at-r2'), account)
  }
})

test('TASK_SHEET_TITLE names the feed; TASK_SHEET_TAB picks the tab, and a missing tab is an error', async () => {
  const titled = harness({ env: { ...ENV, TASK_SHEET_TITLE: 'Shared HQ' } })
  assert.equal((await titled.feed.read()).title, 'Shared HQ')
  const missing = harness({ env: { ...ENV, TASK_SHEET_TAB: 'Backlog' } })
  const out = await missing.feed.read()
  assert.equal(out.stale, true)
  assert.match(out.error, /no tab named "Backlog"/)
  const caseless = harness({ env: { ...ENV, TASK_SHEET_TAB: 'action items' } })
  assert.equal((await caseless.feed.read()).items.length, 3)
})

test('an expired Drive sign-in is an error on a configured feed, and keeps the last good items', async () => {
  const cold = harness({ tokenStatus: 400 })
  const first = await cold.feed.read()
  assert.equal(first.configured, true)
  assert.equal(first.stale, true)
  assert.deepEqual(first.items, [])
  assert.equal(first.fetchedAt, null)
  assert.match(first.error, /sign-in for "personal" failed.*Reconnect/)
  assert.equal('title' in first, false, 'no title until a read has named the spreadsheet')
  const named = harness({ tokenStatus: 400, env: { ...ENV, TASK_SHEET_TITLE: 'Shared HQ' } })
  assert.equal((await named.feed.read()).title, 'Shared HQ', 'unless the owner named it')
  assert.deepEqual(cold.runs.tracked.map((r) => [r.source, r.ok]), [[TASK_SHEET_SOURCE, false]])
})

test('a failed read answers the last good items, stale, with the error scrubbed', async () => {
  const { feed, sheet, time, runs } = harness()
  const good = await feed.read()
  sheet.fail = { status: 503, message: 'backend error for access_token=ya29.a0AfH6SMBexampleexampleexample1234' }
  time.now += 121_000
  const out = await feed.read()
  assert.equal(out.stale, true)
  assert.deepEqual(out.items, good.items)
  assert.equal(out.fetchedAt, good.fetchedAt, 'when the items were read, not now')
  assert.match(out.error, /HTTP 503/)
  assert.doesNotMatch(out.error, /ya29|a0AfH6/)
  assert.match(out.error, /\[redacted\]/)
  assert.deepEqual(runs.tracked.map((r) => r.ok), [true, false])
  // Recovery clears it.
  sheet.fail = null
  time.now += 121_000
  const back = await feed.read()
  assert.equal(back.stale, false)
  assert.equal(back.error, null)
})

test('a sheet the account cannot open is the feed\'s failure only: Drive records no run of its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-sheet-feed-runs-'))
  const tokensFile = join(dir, 'drive-tokens.json')
  writeFileSync(tokensFile, JSON.stringify({ personal: { refresh_token: 'r1' } }))
  let status = 200
  const fetchImpl = async (url) => {
    const u = new URL(String(url))
    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at', expires_in: 3600 })
    if (status !== 200) return json({ error: { message: 'The caller does not have permission' } }, status)
    if (u.pathname.endsWith('/values:batchGet')) return json({ valueRanges: [{ range: "'Action Items'!A1:H10", values: liveShape(ROWS) }] })
    return json({ spreadsheetId: SHEET_ID, properties: { title: 'Example HQ' }, sheets: [{ properties: { sheetId: GID, title: 'Action Items', index: 0 } }] })
  }
  const runs = fakeRuns()
  // One run log for both, as in the bridge.
  const drive = createDrive({ tokensFile, loadClient: () => ({ installed: { client_id: 'c', client_secret: 's' } }), redirectUri: () => 'x', fetchImpl, runs })
  const clock = { now: Date.parse('2026-11-09T15:00:00Z') }
  const feed = createTaskSheetFeed({ drive, runs, env: ENV, now: () => clock.now })
  for (const code of [403, 404]) {
    status = code
    clock.now += 121_000
    const out = await feed.read()
    assert.equal(out.stale, true)
    assert.match(out.error, new RegExp(`HTTP ${code}`))
  }
  status = 200
  clock.now += 121_000
  assert.equal((await feed.read()).items.length, 3)
  assert.deepEqual(runs.tracked.map((r) => [r.source, r.ok]), [[TASK_SHEET_SOURCE, false], [TASK_SHEET_SOURCE, false], [TASK_SHEET_SOURCE, true]])
  // Drive's own calls outside the feed still record against Drive.
  await drive.sheetInfo({ id: SHEET_ID })
  assert.deepEqual(runs.tracked.at(-1).source, 'drive:personal')
})

test('a sheet that changed shape is a failure, not an empty list', async () => {
  const { feed, sheet, time } = harness()
  await feed.read()
  sheet.values = [['Totally different'], ['a', 'b']]
  time.now += 121_000
  const out = await feed.read()
  assert.equal(out.stale, true)
  assert.equal(out.items.length, 3)
  assert.match(out.error, /No header row/)
})

test('cached for 120 s; refresh reads again at most once per 10 s', async () => {
  const { feed, sheetCalls, time, runs } = harness()
  const reads = () => sheetCalls().filter((c) => c.path.endsWith('values:batchGet')).length
  await feed.read()
  assert.equal(reads(), 1)
  time.now += 60_000
  await feed.read()
  assert.equal(reads(), 1, 'inside the cache window')
  await feed.read({ refresh: true })
  assert.equal(reads(), 2, 'refresh bypasses the cache')
  time.now += 5_000
  await feed.read({ refresh: true })
  assert.equal(reads(), 2, 'a second refresh within 10 s is served from the cache')
  time.now += 5_000
  await feed.read({ refresh: true })
  assert.equal(reads(), 3, '10 s later it reads again')
  time.now += 119_000
  await feed.read()
  assert.equal(reads(), 3)
  time.now += 2_000
  await feed.read()
  assert.equal(reads(), 4, 'past 120 s the cache expires')
  assert.equal(runs.tracked.length, 4, 'one source-health run per read')
  assert.ok(runs.tracked.every((r) => r.source === TASK_SHEET_SOURCE && r.ok && r.rows === 3))
})

test('concurrent reads share one fetch', async () => {
  const { feed, sheetCalls } = harness()
  const [a, b, c] = await Promise.all([feed.read(), feed.read(), feed.read({ refresh: true })])
  assert.equal(sheetCalls().filter((x) => x.path.endsWith('values:batchGet')).length, 1)
  assert.equal(a, b)
  assert.equal(b, c)
})

test('changing a setting takes effect on the next read, without a restart', async () => {
  const h = harness()
  const env = { ...ENV }
  const feed = createTaskSheetFeed({ drive: h.drive, env, now: () => h.time.now })
  assert.equal((await feed.read()).items.length, 3)
  env.TASK_SHEET_ASSIGNEES = 'Sam'
  assert.deepEqual((await feed.read()).items.map((i) => i.title), ['Send the deck'])
})

test('read-only: every request to Google is a GET, and only to the Sheets API', async () => {
  const { feed, calls, sheet, time } = harness()
  await feed.read()
  await feed.read({ refresh: true })
  sheet.fail = { status: 500, message: 'boom' }
  time.now += 121_000
  await feed.read()
  const google = calls.filter((c) => c.host !== 'oauth2.googleapis.com')
  assert.ok(google.length >= 4)
  assert.deepEqual([...new Set(google.map((c) => `${c.method} ${c.host}`))], ['GET sheets.googleapis.com'])
  assert.ok(google.every((c) => c.path === `/v4/spreadsheets/${SHEET_ID}` || c.path === `/v4/spreadsheets/${SHEET_ID}/values:batchGet`))
})

test('read-only: the feed module calls nothing on Drive but its reads', async () => {
  const touched = new Set()
  const drive = new Proxy({
    configured: () => true,
    accountLabels: () => ['personal'],
    requireAccount: () => 'personal',
    sheetInfo: async () => ({ title: 'T', tabs: [{ sheetId: 1, title: 'Action Items' }] }),
    sheetRead: async () => ({ ranges: [{ range: "'Action Items'!A1:H9", values: liveShape(ROWS) }] }),
  }, { get(target, prop) { touched.add(prop); return target[prop] } })
  const feed = createTaskSheetFeed({ drive, env: ENV })
  await feed.read()
  assert.deepEqual([...touched].sort(), ['accountLabels', 'configured', 'requireAccount', 'sheetInfo', 'sheetRead'])
})

test('status() reports set up, last read and error without reading the sheet', async () => {
  const { feed, sheetCalls, sheet, time } = harness()
  assert.deepEqual(feed.status(), { configured: true, account: 'personal', fetchedAt: null, stale: false, error: null, items: null })
  assert.equal(sheetCalls().length, 0)
  const out = await feed.read()
  assert.deepEqual(feed.status(), { configured: true, account: 'personal', fetchedAt: out.fetchedAt, stale: false, error: null, items: 3 })
  sheet.fail = { status: 500, message: 'boom' }
  time.now += 121_000
  await feed.read()
  assert.equal(feed.status().stale, true)
  assert.match(feed.status().error, /boom/)
})
