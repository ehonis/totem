// The Recs page's words and numbers (#181), the same as the app's (mobile/src/features/recs/card.test.mjs).
import { expect, it } from 'vitest'
import { decisionToast, recMeta, statTiles, whenLabel } from './card'
import type { Rec } from './types'

const rec = (over: Partial<Rec> = {}): Rec => ({
  id: 'r', title: 't', body: '', evidence: '', costUsd: null, source: 'owner', createdAt: '', updatedAt: '',
  actBy: null, reviewOn: null, decision: 'pending', decidedAt: null, decisionNote: null, outcome: null,
  outcomeNote: null, outcomeAt: null, outcomeBy: null, changedNote: null, resurfacedAt: null, ...over,
})

it('recMeta joins cost, deadline and deferral state', () => {
  expect(recMeta(rec())).toBe('')
  expect(recMeta(rec({ costUsd: 1200, actBy: '2026-11-10' }))).toBe('$1,200 · act by 2026-11-10')
  expect(recMeta(rec({ costUsd: 9.5 }))).toBe('$9.50')
  expect(recMeta(rec({ decision: 'deferred', reviewOn: '2026-12-01' }))).toBe('back 2026-12-01')
  expect(recMeta(rec({ resurfacedAt: '2026-11-01' }))).toBe('back from deferral')
  expect(recMeta(rec({ decision: 'accepted', resurfacedAt: '2026-11-01', reviewOn: '2026-12-01' }))).toBe('')
})

it('decisionToast names what happens next', () => {
  expect(decisionToast({ decision: 'accepted', reviewOn: null })).toBe('Accepted.')
  expect(decisionToast({ decision: 'declined', reviewOn: null })).toMatch(/30 days/)
  expect(decisionToast({ decision: 'deferred', reviewOn: '2026-11-11' })).toBe('Deferred. It comes back on 2026-11-11.')
  expect(decisionToast({ decision: 'pending', reviewOn: null })).toBe('Back to waiting on you.')
})

it('whenLabel', () => {
  const now = new Date(2026, 10, 4, 15)
  expect(whenLabel(new Date(2026, 10, 4, 9).toISOString(), now)).toBe('today')
  expect(whenLabel(new Date(2026, 10, 3, 23).toISOString(), now)).toBe('yesterday')
  expect(whenLabel(new Date(2026, 10, 1, 12).toISOString(), now)).toBe('3 days ago')
  expect(whenLabel(new Date(2026, 9, 20, 12).toISOString(), now)).toBe(new Date(2026, 9, 20).toLocaleDateString([], { month: 'short', day: 'numeric' }))
  expect(whenLabel(null, now)).toBe('')
  expect(whenLabel('nope', now)).toBe('')
})

it('statTiles', () => {
  const tiles = statTiles({
    total: 10, pending: 2, accepted: 3, declined: 1, deferred: 1, worked: 1, partly: 1, failed: 0, measured: 2,
    acceptRate: 0.75, hitRate: null, agentReported: 0, acceptedCostUsd: 0, line: '',
  })
  expect(tiles.map((t) => [t.label, t.value])).toEqual([['Waiting', '2'], ['Accepted', '75%'], ['Worked', '–']])
})
