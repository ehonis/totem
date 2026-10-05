// Run with: node --test notify/text.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { fitTitle, bodyOf, TITLE_MAX } from './text.mjs'

test('a title that fits keeps its detail', () => {
  assert.equal(fitTitle('Due today', 'Pick up bike'), 'Due today: Pick up bike')
})

test('a title that would be truncated falls back to its label', () => {
  // The phone cuts the END, and the end is the point — so drop the detail here
  // and let the body carry it, rather than shipping "Due today: Renew the dom…".
  const long = fitTitle('Due today', 'Renew the domain before it lapses on Friday')
  assert.equal(long, 'Due today')
  assert.ok(long.length <= TITLE_MAX)
})

test('no detail is just the label', () => {
  assert.equal(fitTitle('Streak ends tonight'), 'Streak ends tonight')
})

test('the boundary is inclusive', () => {
  const exact = 'x'.repeat(TITLE_MAX)
  assert.equal(fitTitle(exact), exact)
  assert.equal(fitTitle('ab', 'x'.repeat(TITLE_MAX)), 'ab')
})

test('bodyOf drops empty parts and collapses whitespace', () => {
  assert.equal(bodyOf('3 of 4.', '', '2 days left.'), '3 of 4. 2 days left.')
  assert.equal(bodyOf('', null, undefined), '')
})

test('a body assembled from fragments still reads as a sentence', () => {
  // These are stitched together from collector fragments, so the first one can
  // easily be a lowercase clause: "your mom, Marion, turns 65 today."
  assert.equal(bodyOf('your mom, Marion, turns 65 today.'), 'Your mom, Marion, turns 65 today.')
  assert.equal(bodyOf(''), '')
})
