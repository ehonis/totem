// Run with `node --test mobile/src/features/goals/summary.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { periodSummary, ringOffset } from './summary.ts'

const goal = (over = {}) => ({ complete: false, abandoned: false, progress: { percent: 0 }, ...over })

test('periodSummary: achieved over the goals still in play', () => {
  const s = periodSummary([
    goal({ complete: true, progress: { percent: 80 } }),
    goal({ progress: { percent: 50 } }),
    goal({ abandoned: true, progress: { percent: 10 } }),
    goal({ progress: { percent: null } }),
  ])
  assert.equal(s.achieved, 1)
  assert.equal(s.counted, 3)
  assert.equal(s.notDoing, 1)
  assert.equal(s.ratio, 1 / 3)
  // 100 (achieved counts as full) and 50; the unreadable one is left out, the stopped one too.
  assert.equal(s.meanPercent, 75)
})

test('periodSummary: a goal achieved after being stopped still counts as achieved', () => {
  const s = periodSummary([goal({ complete: true, abandoned: true })])
  assert.equal(s.achieved, 1)
  assert.equal(s.notDoing, 0)
})

test('periodSummary: nothing set reads as zero, not as a division by zero', () => {
  assert.deepEqual(periodSummary([]), { achieved: 0, counted: 0, notDoing: 0, ratio: 0, meanPercent: null })
})

test('ringOffset: clamps to the ring and treats null as empty', () => {
  assert.equal(ringOffset(25, 100), 75)
  assert.equal(ringOffset(140, 100), 0)
  assert.equal(ringOffset(null, 100), 100)
  assert.equal(ringOffset(-5, 100), 100)
})
