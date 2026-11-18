// todos/sheet-marks.mjs — the owner's own done and snoozed marks on shared sheet rows.
//
// The task sheet is read-only (docs/task-sheet.md): Totem never writes a row. But a
// row the owner has finished, or wants out of sight until next week, should leave
// the owner's list without anyone else seeing a change. So the mark lives here, in Totem,
// and the sheet is untouched: GET /api/todos/sheet moves a marked row from `items`
// to `hidden`, with its `mark`, and every client lists `items` only.
//
// Layout: one JSON file, { "<sheet ref>": { state, at, until?, title } }.
//   done     hidden until the owner takes the mark off, or the row leaves the feed
//            (marked Done in the sheet, reassigned, deleted): the mark goes with it.
//   snoozed  hidden until `until` (an instant); the mark is dropped once it passes.
// A row's ref changes when a row above it is inserted or deleted, so a mark finds
// its row again by tab and title (findSheetItem) and is re-keyed to the new ref, but
// only when the row still has the due date and assignee it had when marked: a new
// row that merely reuses a title (a weekly "Send the update") is not the row marked.
// The mark also keeps `due` and `who` for that check, and a done mark ends when the
// row itself is re-dated or reassigned in place.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { findSheetItem } from '../chat/task-link.mjs'

export const SHEET_MARK_STATES = Object.freeze(['done', 'snoozed'])
const SHEET_REF = /^sheet:[A-Za-z0-9_-]{1,40}:\d{1,7}:[0-9a-f]{8}$/
// A snooze is for days or weeks; a year out is a typo, not a plan.
const MAX_SNOOZE_MS = 366 * 86_400_000

export const validSheetRef = (ref) => typeof ref === 'string' && SHEET_REF.test(ref)

function validMark(mark) {
  if (!mark || typeof mark !== 'object' || !SHEET_MARK_STATES.includes(mark.state)) return false
  if (typeof mark.at !== 'string' || Number.isNaN(Date.parse(mark.at))) return false
  if (mark.state === 'snoozed' && (typeof mark.until !== 'string' || Number.isNaN(Date.parse(mark.until)))) return false
  return true
}

/**
 * Split a feed's rows into what the owner sees (`items`) and what he marked
 * (`hidden`, each with its `mark`). Returns { feed, changes }: `changes` are the
 * edits the store should make ({ ref, to } re-keys a mark, { ref, drop } drops one;
 * `at` is the mark's, so a mark set again since is left alone).
 * Marks are only dropped for a row gone from a good read; a stale or failed read
 * keeps them all.
 */
export function applySheetMarks(feed, marks, now = Date.now()) {
  const items = Array.isArray(feed?.items) ? feed.items : []
  const good = feed?.configured === true && !feed.stale && Boolean(feed.fetchedAt)
  const byItem = new Map()
  const changes = []
  for (const [ref, mark] of Object.entries(marks || {})) {
    if (mark.state === 'snoozed' && Date.parse(mark.until) <= now) { changes.push({ ref, drop: 'woke', at: mark.at }); continue }
    const found = findSheetItem(items, ref)
    // Found by its title alone, the same row moved only if its due date and assignee
    // held. A done row re-dated or reassigned in place (a weekly row bumped to next
    // week) is the next one to do, so its done mark goes too; a snooze ends anyway.
    const item = found && ((found.id === ref && mark.state !== 'done') || sameRow(mark, found)) ? found : null
    if (!item) {
      // Ambiguous (two rows now share the title) is not gone: keep it, apply nothing.
      if (good && !ambiguous(items, ref)) changes.push({ ref, drop: 'gone', at: mark.at })
      continue
    }
    // The exact ref wins over one that found the row by its title.
    const held = byItem.get(item.id)
    if (held && held.ref === item.id) continue
    byItem.set(item.id, { ref, mark })
    if (ref !== item.id) changes.push({ ref, to: item.id, at: mark.at })
  }
  const shown = []
  const hidden = []
  for (const item of items) {
    const found = byItem.get(item.id)
    if (!found) { shown.push(item); continue }
    const { state, at, until } = found.mark
    hidden.push({ ...item, mark: { state, at, ...(state === 'snoozed' ? { until } : {}) } })
  }
  return { feed: { ...feed, items: shown, hidden }, changes }
}

function sameRow(mark, item) {
  return (mark.due === undefined || mark.due === (item.dueDate ?? null)) && (mark.who === undefined || mark.who === (item.who ?? ''))
}

function ambiguous(items, ref) {
  const tail = (id) => { const p = String(id).split(':'); return `${p[1]}:${p[3]}` }
  const want = tail(ref)
  return items.filter((i) => tail(i.id) === want).length > 1
}

export function createSheetMarkStore({ file, now = Date.now } = {}) {
  if (!file) throw new TypeError('createSheetMarkStore requires file')
  let queue = Promise.resolve()

  async function all() {
    let raw = {}
    try { raw = JSON.parse(await readFile(file, 'utf8')) } catch {}
    const out = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [ref, mark] of Object.entries(raw)) if (validSheetRef(ref) && validMark(mark)) out[ref] = mark
    }
    return out
  }

  async function write(map) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
  }

  function change(fn) {
    const run = queue.then(async () => {
      const map = await all()
      const out = fn(map)
      if (out !== false) await write(map)
      return map
    })
    queue = run.catch(() => {})
    return run
  }

  /**
   * Mark a row done or snoozed (`until`, an ISO instant in the future), or clear
   * its mark with state null. `title` is kept only to make the file readable; `row`
   * (the feed's item) gives the due date and assignee a moved row is matched on.
   */
  function set(ref, { state, until = null, title = '', row = null } = {}) {
    if (!validSheetRef(ref)) return Promise.reject(Object.assign(new Error('not a sheet row id'), { status: 400 }))
    if (state != null && !SHEET_MARK_STATES.includes(state)) return Promise.reject(Object.assign(new Error('state must be done, snoozed or null'), { status: 400 }))
    let wake = null
    if (state === 'snoozed') {
      const t = Date.parse(until)
      if (typeof until !== 'string' || Number.isNaN(t)) return Promise.reject(Object.assign(new Error('a snooze needs until, an ISO date-time'), { status: 400 }))
      if (t <= now()) return Promise.reject(Object.assign(new Error('until is in the past'), { status: 400 }))
      if (t - now() > MAX_SNOOZE_MS) return Promise.reject(Object.assign(new Error('a snooze is at most a year'), { status: 400 }))
      wake = new Date(t).toISOString()
    }
    return change((map) => {
      if (!state) {
        if (!(ref in map)) return false
        delete map[ref]
        return true
      }
      map[ref] = {
        state, at: new Date(now()).toISOString(), ...(wake ? { until: wake } : {}), title: String(title || '').slice(0, 200),
        ...(row ? { due: row.dueDate ?? null, who: String(row.who ?? '') } : {}),
      }
      return true
    })
  }

  /** The feed as the owner sees it: marked rows moved to `hidden`; stale marks tidied. */
  async function apply(feed) {
    const { feed: out, changes } = applySheetMarks(feed, await all(), now())
    if (changes.length) {
      await change((map) => {
        let changed = false
        for (const c of changes) {
          // Marked again since this read: the newer mark stays as it is.
          if (!(c.ref in map) || map[c.ref].at !== c.at) continue
          if (c.to && !(c.to in map)) map[c.to] = map[c.ref]
          delete map[c.ref]
          changed = true
        }
        return changed
      })
    }
    return out
  }

  return { all, set, apply }
}
