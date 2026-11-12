// The owner's shared action-items sheet, read-only (docs/task-sheet.md).
//
// A Google Sheet that someone else also edits holds a table of action items. Totem
// shows the open rows assigned to the owner beside the task list and never writes
// to the sheet: this module only reads, through the owner's Google Drive sign-in
// (drive/index.mjs), whose `drive` scope also reaches the Sheets API. The only
// calls it makes are the spreadsheet's metadata and one values read.
//
// The sheet's layout is not trusted: the header row is found by its "Task Name"
// cell, columns are matched by header text, and anything past them is ignored.

import { createHash } from 'node:crypto'
import { tracker, unconfiguredMarker } from '../../sources/track.mjs'
import { scrubError } from '../../sources/scrub.mjs'
import { tabRef } from '../../drive/index.mjs'

export const TASK_SHEET_SOURCE = 'task-sheet'
export const DEFAULT_TAB = 'Action Items'
const CACHE_MS = 120_000
const REFRESH_MIN_MS = 10_000
// The header row must be within the first rows; a title block sits above it.
const HEADER_SCAN_ROWS = 10
const MAX_CELLS = 200_000

const FIELDS = Object.freeze({
  'task name': 'title',
  who: 'who',
  priority: 'priority',
  status: 'status',
  'due date': 'dueDate',
  'notes & links': 'notes',
})
const PRIORITY = Object.freeze({ high: 1, medium: 2, low: 3 })

/**
 * One open row, as GET /api/todos/sheet returns it.
 * @typedef {object} SheetItem
 * @property {string} id        `sheet:<gid>:<row>:<8 hex of the title>`
 * @property {number} row       the row's number in the sheet (1-based)
 * @property {string} title
 * @property {string} who
 * @property {1|2|3|null} priority  High 1, Medium 2, Low 3
 * @property {string} status    as the sheet says it ("Not Started", "In Progress", …)
 * @property {string|null} dueDate  a `YYYY-MM-DD` day key
 * @property {string} notes
 * @property {string} url       a link to the row in the sheet
 */

/**
 * The response of GET /api/todos/sheet.
 * @typedef {object} SheetFeed
 * @property {boolean} configured
 * @property {string} [reason]      what to set, when not configured
 * @property {string} [title]     the spreadsheet's (or TASK_SHEET_TITLE); unset before a first good read
 * @property {string} [url]
 * @property {string|null} [fetchedAt]  when the items were read (the last good read when stale)
 * @property {boolean} [stale]
 * @property {string|null} [error]
 * @property {SheetItem[]} items
 */

const fold = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const text = (s) => String(s ?? '').trim()

/** The assignees setting as a list of folded names. */
export function parseAssignees(value) {
  return String(value || '').split(',').map(fold).filter(Boolean)
}

/** TASK_SHEET_* from the environment (or Settings → Tasks, which writes into it). */
export function taskSheetConfig(env = process.env) {
  return {
    spreadsheetId: text(env.TASK_SHEET_ID),
    tab: text(env.TASK_SHEET_TAB) || DEFAULT_TAB,
    assignees: parseAssignees(env.TASK_SHEET_ASSIGNEES),
    title: text(env.TASK_SHEET_TITLE),
    account: text(env.TASK_SHEET_ACCOUNT),
  }
}

/** A sheet date (`M/D/YYYY`, or `YYYY-MM-DD`) as a day key, or null. */
export function parseDueDate(value) {
  const s = text(value)
  let y, m, d
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (match) [, m, d, y] = match.map(Number)
  else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [, y, m, d] = match.map(Number)
  else return null
  if (m < 1 || m > 12 || d < 1) return null
  // Day 0 of the next month is the last day of this one.
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function parsePriority(value) {
  return PRIORITY[fold(value)] ?? null
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Where a values range starts: `'Action Items'!B4:G60` → { row: 4, col: 1 } (row 1-based, col 0-based). */
export function rangeStart(range) {
  const s = String(range || '')
  // A bare tab name is the whole tab, from A1.
  const bang = s.lastIndexOf('!')
  if (bang < 0) return { row: 1, col: 0 }
  const cell = s.slice(bang + 1).split(':')[0]
  const m = /^\$?([A-Za-z]{0,3})\$?(\d*)$/.exec(cell)
  if (!m) return { row: 1, col: 0 }
  let col = 0
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: m[2] ? Number(m[2]) : 1, col: m[1] ? col - 1 : 0 }
}

const titleHash = (title) => createHash('sha1').update(title).digest('hex').slice(0, 8)

/**
 * The header row and the column of each field it names. `rows` are the values as
 * read; the header is the first of the first ten rows holding a "Task Name" cell.
 */
export function findHeader(rows) {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS)
  for (let i = 0; i < limit; i++) {
    const cells = rows[i] || []
    if (!cells.some((c) => text(c) === 'Task Name')) continue
    const columns = {}
    cells.forEach((c, at) => {
      const field = FIELDS[fold(c)]
      if (field && columns[field] === undefined) columns[field] = at
    })
    return { index: i, columns }
  }
  return null
}

/**
 * The open rows for the assignees. `values` is the tab as read, starting at
 * `start` ({ row, col } of its first cell); `gid` is the tab's numeric id.
 * Throws when the header row or a needed column cannot be found.
 * @returns {SheetItem[]}
 */
export function parseSheetRows({ values, start = { row: 1, col: 0 }, gid, assignees, sheetUrl }) {
  const rows = Array.isArray(values) ? values : []
  const header = findHeader(rows)
  if (!header) throw new Error(`No header row: none of the first ${HEADER_SCAN_ROWS} rows has a "Task Name" cell.`)
  const missing = ['who', 'status'].filter((f) => header.columns[f] === undefined)
  if (missing.length) throw new Error(`The header row has no ${missing.map((f) => (f === 'who' ? '"Who"' : '"Status"')).join(' or ')} column.`)
  const mine = new Set(assignees)
  const col = header.columns
  const cell = (cells, field) => (col[field] === undefined ? '' : text(cells[col[field]]))
  const nameColumn = columnLetter(start.col + col.title)
  const items = []
  for (let i = header.index + 1; i < rows.length; i++) {
    const cells = rows[i] || []
    const title = cell(cells, 'title')
    if (!title) continue
    const who = cell(cells, 'who')
    if (!mine.has(fold(who))) continue
    const status = cell(cells, 'status')
    if (fold(status) === 'done') continue
    const row = start.row + i
    items.push({
      id: `sheet:${gid}:${row}:${titleHash(title)}`,
      row,
      title,
      who,
      priority: parsePriority(cell(cells, 'priority')),
      status,
      dueDate: parseDueDate(cell(cells, 'dueDate')),
      notes: cell(cells, 'notes'),
      url: `${sheetUrl}#gid=${gid}&range=${nameColumn}${row}`,
    })
  }
  return items
}

/**
 * @param {object} options
 * @param {object} options.drive  the Drive client, or the read half of it:
 *        configured, accountLabels, requireAccount, sheetInfo, sheetRead
 * @param {object} [options.runs] the source-run log (sources/store.mjs)
 */
export function createTaskSheetFeed({ drive, runs = null, env = process.env, now = Date.now, cacheMs = CACHE_MS, refreshMinMs = REFRESH_MIN_MS } = {}) {
  const track = tracker(runs)
  const markUnconfigured = unconfiguredMarker(runs)
  // What a read gave, for one configuration. `lastGood` survives a failed read.
  let cache = null       // { key, at, payload }
  let lastGood = null    // { key, payload }
  let lastRefreshAt = -Infinity
  let inflight = null    // { key, promise }

  /** The Drive account to read through, or why there is none. */
  function account(cfg) {
    if (!drive || (typeof drive.configured === 'function' && !drive.configured())) {
      return { reason: 'Totem has no Google OAuth client. Set one up (as for Calendar), then connect Google Drive in Settings → Connections.' }
    }
    const labels = drive.accountLabels()
    if (!labels.length) return { reason: 'Connect a Google Drive account that can open the sheet in Settings → Connections.' }
    if (!cfg.account && labels.length > 1) {
      return { reason: `Several Google Drive accounts are connected (${labels.join(', ')}). Set TASK_SHEET_ACCOUNT in Settings → Tasks to the one that can open the sheet.` }
    }
    try {
      return { label: drive.requireAccount(cfg.account || null) }
    } catch {
      return { reason: `No Google Drive account "${cfg.account}" is connected (${labels.join(', ')}). Fix TASK_SHEET_ACCOUNT in Settings → Tasks.` }
    }
  }

  function unconfigured(cfg) {
    const missing = [!cfg.spreadsheetId && 'TASK_SHEET_ID', !cfg.assignees.length && 'TASK_SHEET_ASSIGNEES'].filter(Boolean)
    if (missing.length) return { reason: `Set ${missing.join(' and ')} in Settings → Tasks.` }
    const a = account(cfg)
    return a.reason ? { reason: a.reason } : { label: a.label }
  }

  async function fetchFeed(cfg, label) {
    const ref = `${label}:${cfg.spreadsheetId}`
    const info = await drive.sheetInfo({ id: ref })
    const tabs = info.tabs || []
    const tab = tabs.find((t) => t.title === cfg.tab) || tabs.find((t) => fold(t.title) === fold(cfg.tab))
    if (!tab) throw new Error(`The spreadsheet has no tab named "${cfg.tab}".`)
    const read = await drive.sheetRead({ id: ref, ranges: [tabRef(tab.title)], maxCells: MAX_CELLS })
    const range = read.ranges?.[0] || { values: [] }
    if (range.truncated) throw new Error(`The "${tab.title}" tab is too large to read (over ${MAX_CELLS.toLocaleString('en-US')} cells).`)
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.spreadsheetId)}/edit`
    const items = parseSheetRows({ values: range.values, start: rangeStart(range.range), gid: tab.sheetId, assignees: cfg.assignees, sheetUrl })
    return {
      configured: true,
      title: cfg.title || info.title || cfg.tab,
      url: sheetUrl,
      fetchedAt: new Date(now()).toISOString(),
      stale: false,
      error: null,
      items,
    }
  }

  /**
   * The feed. Cached for two minutes; `refresh` reads again at most once per ten
   * seconds. A failed read answers the last good items, marked stale.
   * @returns {Promise<SheetFeed>}
   */
  async function read({ refresh = false } = {}) {
    const cfg = taskSheetConfig(env)
    const setup = unconfigured(cfg)
    const key = JSON.stringify([cfg, setup.label || null])
    const t = now()
    if (setup.reason) {
      // Once per cache window, not on every poll.
      if (!(cache && cache.key === key && t - cache.at < cacheMs)) {
        markUnconfigured(TASK_SHEET_SOURCE, setup.reason)
        cache = { key, at: t, payload: { configured: false, items: [], reason: setup.reason } }
      }
      return cache.payload
    }
    const fresh = cache && cache.key === key && t - cache.at < cacheMs
    const mayRefresh = refresh && t - lastRefreshAt >= refreshMinMs
    if (fresh && !mayRefresh) return cache.payload
    if (inflight && inflight.key === key) return inflight.promise
    if (refresh) lastRefreshAt = t
    const promise = (async () => {
      let payload
      try {
        payload = await track(TASK_SHEET_SOURCE, () => fetchFeed(cfg, setup.label), {
          rows: (p) => p.items.length,
          // Any failure to read the sheet the owner configured is this source failing,
          // and only this one: Drive's own runs for these calls join this run, so a
          // sheet not shared with the account (403/404) never reads as Drive failing.
          isFault: () => true,
          covers: [`drive:${setup.label}`],
        })
        lastGood = { key, payload }
      } catch (e) {
        const error = scrubError(e?.message || e) || 'The sheet could not be read.'
        const base = lastGood && lastGood.key === key
          ? lastGood.payload
          // No title until a read has named the spreadsheet, unless the owner set one.
          : { configured: true, ...(cfg.title ? { title: cfg.title } : {}), url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.spreadsheetId)}/edit`, fetchedAt: null, items: [] }
        payload = { ...base, stale: true, error }
      }
      cache = { key, at: now(), payload }
      return payload
    })()
    inflight = { key, promise }
    try { return await promise } finally { if (inflight?.promise === promise) inflight = null }
  }

  /** One line for Settings → Tasks: set up, last read, error. Never reads the sheet. */
  function status() {
    const cfg = taskSheetConfig(env)
    const setup = unconfigured(cfg)
    if (setup.reason) return { configured: false, reason: setup.reason, fetchedAt: null, stale: false, error: null, items: null, account: null }
    const key = JSON.stringify([cfg, setup.label])
    const p = cache && cache.key === key ? cache.payload : null
    return { configured: true, account: setup.label, fetchedAt: p?.fetchedAt ?? null, stale: Boolean(p?.stale), error: p?.error ?? null, items: p ? p.items.length : null }
  }

  return { read, status }
}
