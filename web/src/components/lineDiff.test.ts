import test from 'node:test'
import assert from 'node:assert/strict'

import { lineDiff, diffHunks, diffStats } from './lineDiff.ts'

const ops = (before: string, after: string) => lineDiff(before, after).map((r) => `${r.op[0]}${r.text}`)

test('identical text produces no changes and no hunks', () => {
  const rows = lineDiff('a\nb\nc', 'a\nb\nc')
  assert.deepEqual(rows.map((r) => r.op), ['same', 'same', 'same'])
  assert.deepEqual(diffStats(rows), { added: 0, removed: 0 })
  assert.deepEqual(diffHunks(rows), [])
})

test('an inserted line is an add, and the rest stays same', () => {
  assert.deepEqual(ops('a\nc', 'a\nb\nc'), ['sa', 'ab', 'sc'])
  assert.deepEqual(diffStats(lineDiff('a\nc', 'a\nb\nc')), { added: 1, removed: 0 })
})

test('a deleted line is a remove', () => {
  assert.deepEqual(ops('a\nb\nc', 'a\nc'), ['sa', 'rb', 'sc'])
})

test('a changed line reads as the removal then the addition', () => {
  assert.deepEqual(ops('a\nold\nc', 'a\nnew\nc'), ['sa', 'rold', 'anew', 'sc'])
})

test('line numbers track each side independently', () => {
  const rows = lineDiff('keep\ndrop\ntail', 'keep\nadded\ntail')
  assert.deepEqual(
    rows.map((r) => [r.op, r.beforeLine, r.afterLine]),
    [['same', 1, 1], ['remove', 2, null], ['add', null, 2], ['same', 3, 3]],
  )
})

test('the longest common subsequence is used, not a naive line-by-line compare', () => {
  // A block moved to the front: a positional compare would call every line
  // changed. Only the moved lines should show up.
  const rows = lineDiff('a\nb\nc\nd', 'c\nd\na\nb')
  const { added, removed } = diffStats(rows)
  assert.equal(added, 2)
  assert.equal(removed, 2)
  assert.equal(rows.filter((r) => r.op === 'same').length, 2)
})

test('empty text on either side is all-add or all-remove', () => {
  assert.deepEqual(ops('', 'x'), ['r', 'ax'])
  assert.deepEqual(diffStats(lineDiff('a\nb', '')), { added: 1, removed: 2 })
})

test('hunks keep context around a change and count what they collapsed', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
  const after = before.replace('line 10', 'CHANGED')
  const hunks = diffHunks(lineDiff(before, after), 2)
  assert.equal(hunks.length, 1)
  // 2 lines of context each side, plus the removal and the addition.
  assert.deepEqual(hunks[0].rows.map((r) => r.text), ['line 8', 'line 9', 'line 10', 'CHANGED', 'line 11', 'line 12'])
  assert.equal(hunks[0].skipped, 7) // lines 1-7
})

test('two distant changes become two hunks', () => {
  const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
  const after = before.replace('l5', 'A').replace('l30', 'B')
  const hunks = diffHunks(lineDiff(before, after), 2)
  assert.equal(hunks.length, 2)
  assert.ok(hunks[1].skipped > 0, 'the gap between hunks is reported')
})

test('a very large input degrades instead of building the table', () => {
  const big = Array.from({ length: 3100 }, (_, i) => `l${i}`).join('\n')
  const rows = lineDiff(big, big)
  // Same text, but past the cap it is reported as a wholesale replacement rather
  // than pretending nothing changed.
  assert.equal(rows.filter((r) => r.op === 'same').length, 0)
  assert.equal(rows.length, 6200)
})
