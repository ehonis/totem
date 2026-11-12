// The Recs page's words and numbers (#181).
import test from 'node:test'
import assert from 'node:assert/strict'
import { decisionToast, recMeta, statTiles, whenLabel } from './card.ts'

const rec = (over = {}) => ({
  id: 'r', title: 't', body: '', evidence: '', costUsd: null, source: 'owner', createdAt: '', updatedAt: '',
  actBy: null, reviewOn: null, decision: 'pending', decidedAt: null, decisionNote: null, outcome: null,
  outcomeNote: null, outcomeAt: null, outcomeBy: null, changedNote: null, resurfacedAt: null, ...over,
})

test('recMeta joins cost, deadline and deferral state', () => {
  assert.equal(recMeta(rec()), '')
  assert.equal(recMeta(rec({ costUsd: 1200, actBy: '2026-11-10' })), '$1,200 · act by 2026-11-10')
  assert.equal(recMeta(rec({ costUsd: 9.5 })), '$9.50')
  assert.equal(recMeta(rec({ decision: 'deferred', reviewOn: '2026-12-01' })), 'back 2026-12-01')
  assert.equal(recMeta(rec({ resurfacedAt: '2026-11-01' })), 'back from deferral')
  assert.equal(recMeta(rec({ decision: 'accepted', resurfacedAt: '2026-11-01', reviewOn: '2026-12-01' })), '')
})

test('decisionToast names what happens next', () => {
  assert.equal(decisionToast({ decision: 'accepted', reviewOn: null }), 'Accepted.')
  assert.match(decisionToast({ decision: 'declined', reviewOn: null }), /30 days/)
  assert.equal(decisionToast({ decision: 'deferred', reviewOn: '2026-11-11' }), 'Deferred. It comes back on 2026-11-11.')
  assert.equal(decisionToast({ decision: 'pending', reviewOn: null }), 'Back to waiting on you.')
})

test('whenLabel', () => {
  const now = new Date(2026, 10, 4, 15)
  assert.equal(whenLabel(new Date(2026, 10, 4, 9).toISOString(), now), 'today')
  assert.equal(whenLabel(new Date(2026, 10, 3, 23).toISOString(), now), 'yesterday')
  assert.equal(whenLabel(new Date(2026, 10, 1, 12).toISOString(), now), '3 days ago')
  assert.equal(whenLabel(new Date(2026, 9, 20, 12).toISOString(), now), new Date(2026, 9, 20).toLocaleDateString([], { month: 'short', day: 'numeric' }))
  assert.equal(whenLabel(null, now), '')
  assert.equal(whenLabel('nope', now), '')
})

test('statTiles', () => {
  const tiles = statTiles({
    total: 10, pending: 2, accepted: 3, declined: 1, deferred: 1, worked: 1, partly: 1, failed: 0, measured: 2,
    acceptRate: 0.75, hitRate: null, agentReported: 0, acceptedCostUsd: 0, line: '',
  })
  assert.deepEqual(tiles.map((t) => [t.label, t.value]), [['Waiting', '2'], ['Accepted', '75%'], ['Worked', '–']])
})
