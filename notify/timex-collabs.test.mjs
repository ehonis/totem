import test from 'node:test'
import assert from 'node:assert/strict'
import { isTimexCollabHeadline, partnerFromTitle } from './timex-collabs.mjs'

test('isTimexCollabHeadline accepts collab wording', () => {
  assert.equal(isTimexCollabHeadline("Timex's Latest Pan Am Collab Is a Slice of History"), true)
  assert.equal(isTimexCollabHeadline('Bespoke Post x Timex Heritage 66 Gift Set'), true)
})

test('isTimexCollabHeadline rejects generic Timex product posts', () => {
  assert.equal(isTimexCollabHeadline('Timex Just Made a Seriously Cool Dive Watch for $269'), false)
})

test('partnerFromTitle extracts cross-brand names', () => {
  assert.equal(partnerFromTitle('Bespoke Post x Timex Heritage 66'), 'Bespoke Post')
  assert.equal(partnerFromTitle("Timex's Latest Pan Am Collab Is Cool"), 'Pan Am')
})
