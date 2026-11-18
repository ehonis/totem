import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applySheetMarks, createSheetMarkStore } from './sheet-marks.mjs'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const row = (n, hash, title = `Row ${n}`) => ({ id: `sheet:7:${n}:${hash}`, row: n, title })
const feed = (items, extra = {}) => ({ configured: true, title: 'HQ', fetchedAt: '2026-11-18T11:59:00Z', stale: false, error: null, items, ...extra })

test('a done or snoozed row moves to hidden with its mark; the rest stay in order', () => {
  const marks = {
    'sheet:7:3:aaaaaaaa': { state: 'done', at: '2026-11-17T10:00:00Z' },
    'sheet:7:5:cccccccc': { state: 'snoozed', at: '2026-11-17T10:00:00Z', until: '2026-11-20T09:00:00Z' },
  }
  const { feed: out, changes } = applySheetMarks(feed([row(3, 'aaaaaaaa'), row(4, 'bbbbbbbb'), row(5, 'cccccccc')]), marks, NOW)
  assert.deepEqual(out.items.map((i) => i.row), [4])
  assert.deepEqual(out.hidden.map((i) => [i.row, i.mark.state, i.mark.until]), [[3, 'done', undefined], [5, 'snoozed', '2026-11-20T09:00:00Z']])
  assert.deepEqual(changes, [])
})

test('a snooze that has passed lets the row back and drops the mark', () => {
  const marks = { 'sheet:7:5:cccccccc': { state: 'snoozed', at: '2026-11-10T10:00:00Z', until: '2026-11-18T09:00:00Z' } }
  const { feed: out, changes } = applySheetMarks(feed([row(5, 'cccccccc')]), marks, NOW)
  assert.equal(out.items.length, 1)
  assert.deepEqual(changes, [{ ref: 'sheet:7:5:cccccccc', drop: 'woke', at: '2026-11-10T10:00:00Z' }])
})

test('a moved row keeps its mark (re-keyed); a row gone from a good read loses it; a stale read keeps every mark', () => {
  const marks = {
    'sheet:7:3:aaaaaaaa': { state: 'done', at: 'a' },
    'sheet:7:9:dddddddd': { state: 'done', at: 'b' },
  }
  const items = [row(4, 'aaaaaaaa')]
  const { feed: out, changes } = applySheetMarks(feed(items), marks, NOW)
  assert.deepEqual(out.items, [])
  assert.deepEqual(changes, [{ ref: 'sheet:7:3:aaaaaaaa', to: 'sheet:7:4:aaaaaaaa', at: 'a' }, { ref: 'sheet:7:9:dddddddd', drop: 'gone', at: 'b' }])
  assert.deepEqual(applySheetMarks(feed(items, { stale: true }), marks, NOW).changes, [{ ref: 'sheet:7:3:aaaaaaaa', to: 'sheet:7:4:aaaaaaaa', at: 'a' }])
  assert.deepEqual(applySheetMarks({ configured: false, items: [] }, marks, NOW).changes, [])
})

test('two rows with the same title: the exact ref is applied, a moved one is not guessed, and neither is dropped', () => {
  const marks = { 'sheet:7:3:aaaaaaaa': { state: 'done', at: 'a' } }
  const exact = applySheetMarks(feed([row(3, 'aaaaaaaa'), row(8, 'aaaaaaaa')]), marks, NOW)
  assert.deepEqual(exact.feed.items.map((i) => i.row), [8])
  const moved = applySheetMarks(feed([row(4, 'aaaaaaaa'), row(8, 'aaaaaaaa')]), marks, NOW)
  assert.equal(moved.feed.items.length, 2)
  assert.deepEqual(moved.changes, [])
})

test('a new row that only reuses a marked title is not the row marked: it stays in the list, and the mark goes', () => {
  // Marked done when it was row 5, due on the 20th; that row was closed and a new one added with the same title.
  const marks = { 'sheet:7:5:aaaaaaaa': { state: 'done', at: 'a', due: '2026-11-20', who: 'Sam' } }
  const next = { ...row(12, 'aaaaaaaa', 'Send the weekly update'), dueDate: '2026-11-27', who: 'Sam' }
  const { feed: out, changes } = applySheetMarks(feed([next]), marks, NOW)
  assert.deepEqual(out.items.map((i) => i.row), [12])
  assert.deepEqual(changes, [{ ref: 'sheet:7:5:aaaaaaaa', drop: 'gone', at: 'a' }])
  // Re-dated in place (same row, same title, next week's date): done no longer, back in the list.
  const redated = { ...row(5, 'aaaaaaaa', 'Send the weekly update'), dueDate: '2026-11-27', who: 'Sam' }
  const again = applySheetMarks(feed([redated]), marks, NOW)
  assert.deepEqual(again.feed.items.map((i) => i.row), [5])
  assert.deepEqual(again.changes, [{ ref: 'sheet:7:5:aaaaaaaa', drop: 'gone', at: 'a' }])
  // A snooze on it is left to run out.
  assert.deepEqual(applySheetMarks(feed([redated]), { 'sheet:7:5:aaaaaaaa': { state: 'snoozed', at: 'a', until: '2026-11-25T00:00:00Z', due: '2026-11-20', who: 'Sam' } }, NOW).feed.items, [])
  // The same row, moved down by an insert above it, keeps its mark.
  const moved = { ...row(6, 'aaaaaaaa', 'Send the weekly update'), dueDate: '2026-11-20', who: 'Sam' }
  assert.deepEqual(applySheetMarks(feed([moved]), marks, NOW).feed.items, [])
})

test('the store validates, writes 0600, applies, and tidies what a read found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'totem-sheet-marks-'))
  try {
    const file = join(dir, 'sheet-marks.json')
    let now = NOW
    const store = createSheetMarkStore({ file, now: () => now })
    await assert.rejects(store.set('local-1', { state: 'done' }), /not a sheet row/)
    await assert.rejects(store.set('sheet:7:3:aaaaaaaa', { state: 'snoozed', until: '2026-11-01T00:00:00Z' }), /past/)
    await assert.rejects(store.set('sheet:7:3:aaaaaaaa', { state: 'snoozed', until: '2028-11-01T00:00:00Z' }), /year/)
    await store.set('sheet:7:3:aaaaaaaa', { state: 'done', title: 'Row 3', row: { dueDate: null, who: 'Sam' } })
    assert.deepEqual([JSON.parse(readFileSync(file, 'utf8'))['sheet:7:3:aaaaaaaa'].due, JSON.parse(readFileSync(file, 'utf8'))['sheet:7:3:aaaaaaaa'].who], [null, 'Sam'])
    await store.set('sheet:7:5:cccccccc', { state: 'snoozed', until: '2026-11-19T09:00:00-05:00' })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved['sheet:7:5:cccccccc'].until, '2026-11-19T14:00:00.000Z')

    const out = await store.apply(feed([{ ...row(4, 'aaaaaaaa'), dueDate: null, who: 'Sam' }, row(5, 'cccccccc')]))
    assert.deepEqual(out.items, [])
    assert.deepEqual(Object.keys(await store.all()).sort(), ['sheet:7:4:aaaaaaaa', 'sheet:7:5:cccccccc'])

    now = Date.parse('2026-11-20T00:00:00Z')
    const later = await store.apply(feed([row(5, 'cccccccc')]))
    assert.deepEqual(later.items.map((i) => i.row), [5])
    assert.deepEqual(await store.all(), {})

    await store.set('sheet:7:5:cccccccc', { state: 'done' })
    await store.set('sheet:7:5:cccccccc', { state: null })
    assert.deepEqual(await store.all(), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
