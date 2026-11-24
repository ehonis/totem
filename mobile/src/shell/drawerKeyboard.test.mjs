import test from 'node:test'
import assert from 'node:assert/strict'
import { startsOpening } from './drawerKeyboard.ts'

// The keyboard is dismissed at each step startsOpening says yes to.
const dismissals = (steps) => steps.slice(1).filter((p, i) => startsOpening(p, steps[i])).length

test('an opening dismisses the keyboard once, at its first step', () => {
  assert.equal(startsOpening(0.04, 0), true)
  // A swipe, then a Menu press's animation: one dismissal each.
  assert.equal(dismissals([0, 0.02, 0.2, 0.6, 1]), 1)
  assert.equal(dismissals([0, 0.3, 0.7, 1, 0.5, 0, 0.1, 1]), 2)
})

test('closing, resting shut and the first reading never dismiss it', () => {
  assert.equal(startsOpening(0, null), false)
  assert.equal(startsOpening(1, null), false)
  assert.equal(dismissals([1, 0.6, 0.2, 0]), 0)
  assert.equal(dismissals([0, 0, 0.004, 0]), 0)
})

test('a swipe given up and tried again dismisses again', () => {
  assert.equal(dismissals([0, 0.1, 0, 0.1, 1]), 2)
})
