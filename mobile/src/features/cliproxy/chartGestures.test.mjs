// The pool chart's pinch (chartGestures.ts). Run with
// `node --test mobile/src/features/cliproxy/*.test.mjs` (also in the root npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { focalView, thinResets, turnedInsets } from './chartGestures.ts'

const H = 3_600_000
const bounds = { startMs: 0, endMs: 100 * H }

test('spreading the fingers keeps the time under them where it was', () => {
  const view = focalView(bounds, bounds, 40 * H, 2, 0.4)
  assert.deepEqual(view, { startMs: 20 * H, endMs: 70 * H })
})

test('sliding both fingers pans the view with them', () => {
  // The anchor was under the middle; the fingers moved to a quarter of the way across.
  const from = { startMs: 20 * H, endMs: 60 * H }
  assert.deepEqual(focalView(from, bounds, 40 * H, 1, 0.25), { startMs: 30 * H, endMs: 70 * H })
})

test('closing them past the whole range shows the whole range', () => {
  assert.equal(focalView({ startMs: 20 * H, endMs: 60 * H }, bounds, 40 * H, 0.2, 0.5), null)
})

test('the view stops at the edges and at half an hour wide', () => {
  assert.deepEqual(focalView(bounds, bounds, 1 * H, 4, 0.9), { startMs: 0, endMs: 25 * H })
  const tight = focalView(bounds, bounds, 50 * H, 10_000, 0.5)
  assert.equal(tight.endMs - tight.startMs, 30 * 60_000)
})

test('a broken reading leaves the view as it was', () => {
  const from = { startMs: 20 * H, endMs: 60 * H }
  assert.deepEqual(focalView(from, bounds, 40 * H, 0, 0.5), from)
  assert.deepEqual(focalView(from, bounds, 40 * H, Number.NaN, 0.5), from)
  assert.deepEqual(focalView(from, bounds, 40 * H, 2, Number.NaN), from)
})

test('the sideways view keeps clear of the Dynamic Island and the home bar, either way round', () => {
  const insets = { top: 59, right: 0, bottom: 34, left: 0 }
  // Top of the phone to the left: the island is on the view's left, the home bar on its right.
  assert.deepEqual(turnedInsets(1, insets), { left: 59, right: 34, top: 0, bottom: 0 })
  // Turned the other way: they swap sides.
  assert.deepEqual(turnedInsets(-1, insets), { left: 34, right: 59, top: 0, bottom: 0 })
})

test('a narrow chart labels the biggest refill in each slice of the view, in time order', () => {
  const r = (h, delta) => ({ t: h * H, delta })
  const resets = [r(1, 50), r(5, 100), r(12, 88), r(14, 50), r(30, 100), r(101, 99), r(-2, 99)]
  // Four 25-hour slices: 0-25 keeps the 100, 25-50 the 30 h one, nothing from 50-100, and outside the view is dropped.
  assert.deepEqual(thinResets(resets, 0, 100 * H, 4).map((x) => x.t / H), [5, 30])
  assert.equal(thinResets(resets, 0, 100 * H, 0).length, resets.length)
  // Counted from the page's start, a slide and the small change of width a pinch
  // brings keep the same refills labelled.
  assert.deepEqual(thinResets(resets, 3 * H, 103 * H, 4, 0).map((x) => x.t / H), [5, 30, 101])
  assert.deepEqual(thinResets(resets, 3 * H, 103.02 * H, 4, 0).map((x) => x.t / H), [5, 30, 101])
})
