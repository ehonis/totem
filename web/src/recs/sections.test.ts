import { describe, expect, it } from 'vitest'
import { mergeLedger, outcomeLabel, recSections, recSourceLabel, recSourcePath } from './sections'
import type { Rec, RecLedger } from './types'

const rec = (id: string, patch: Partial<Rec> = {}): Rec => ({
  id, title: id, body: '', evidence: '', costUsd: null, source: 'chat:a',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  actBy: null, reviewOn: null, decision: 'pending', decidedAt: null, decisionNote: null,
  outcome: null, outcomeNote: null, outcomeAt: null, outcomeBy: null, changedNote: null, resurfacedAt: null, ...patch,
})

describe('recSections', () => {
  it('groups the ledger into waiting, deferred, decided and outcomes, dropping empty sections', () => {
    const sections = recSections([
      rec('measured', { decision: 'accepted', decidedAt: '2026-10-02T00:00:00.000Z', outcome: 'worked', outcomeAt: '2026-10-20T00:00:00.000Z' }),
      rec('later', { decision: 'deferred', decidedAt: '2026-10-02T00:00:00.000Z', reviewOn: '2026-11-20' }),
      rec('sooner', { decision: 'deferred', decidedAt: '2026-10-02T00:00:00.000Z', reviewOn: '2026-11-05' }),
      rec('accepted', { decision: 'accepted', decidedAt: '2026-10-03T00:00:00.000Z' }),
      rec('declined', { decision: 'declined', decidedAt: '2026-10-04T00:00:00.000Z' }),
    ])
    expect(sections.map((s) => [s.id, s.recs.map((r) => r.id)])).toEqual([
      ['deferred', ['sooner', 'later']],
      ['decided', ['declined', 'accepted']],
      ['outcomes', ['measured']],
    ])
  })
})

describe('sources', () => {
  it('names and links chats and totems', () => {
    expect(recSourceLabel('owner')).toBe('You')
    expect(recSourceLabel('totem:coach')).toBe('Totem coach')
    expect(recSourcePath('chat:t1')).toBe('/chat?thread=t1')
    expect(recSourcePath('totem:coach')).toBe('/chat?thread=totem-coach')
    expect(recSourcePath('owner')).toBeNull()
  })

  it('labels an outcome an agent reported', () => {
    expect(outcomeLabel(rec('a', { decision: 'accepted', outcome: 'worked', outcomeBy: 'agent' }))).toBe('Worked (reported by an agent)')
    expect(outcomeLabel(rec('b', { decision: 'accepted', outcome: 'failed', outcomeBy: 'owner' }))).toBe("Didn't work")
  })
})

describe('mergeLedger', () => {
  const decided = (n: number, patch: Partial<Rec> = {}) =>
    rec(`d${String(n).padStart(3, '0')}`, { decision: 'declined', decidedAt: `2026-06-01T00:${String(n % 60).padStart(2, '0')}:00.000Z`, ...patch })
  const ledger = (open: Rec[], history: Rec[], nextBefore: string | null): RecLedger =>
    ({ open, history, nextBefore, stats: {} as RecLedger['stats'] })

  it('keeps the older pages loaded after a change, with the change applied', () => {
    // Two pages loaded: d059…d010 (newest first), and the cursor after d010.
    const loaded = Array.from({ length: 50 }, (_, i) => decided(59 - i))
    const prev = { history: loaded, nextBefore: '2026-06-01T00:10:00.000Z|d010' }
    // The owner records an outcome on d012, deep in the second page; then decides the
    // pending p1, which jumps to the top. The fresh first page is 25 long.
    const outcome = { ...decided(12), decision: 'accepted' as const, outcome: 'worked' as const, outcomeBy: 'owner' as const }
    const p1 = rec('p1', { decision: 'accepted', decidedAt: '2026-11-02T00:00:00.000Z' })
    const first = ledger([], [p1, ...loaded.slice(0, 24)], '2026-06-01T00:35:00.000Z|d035')

    const merged = mergeLedger(prev, first, outcome)
    expect(merged.history).toHaveLength(51)
    expect(merged.history[0].id).toBe('p1')
    expect(merged.history.at(-1)!.id).toBe('d010')
    expect(merged.history.find((r) => r.id === 'd012')!.outcome).toBe('worked')
    expect(merged.nextBefore).toBe(prev.nextBefore)
  })

  it('drops a rec decided again from the history and takes the new page cursor when only one page was loaded', () => {
    const prev = { history: [decided(3), decided(2), decided(1)], nextBefore: null }
    const reopened = { ...decided(2), decision: 'pending' as const, decidedAt: null }
    const merged = mergeLedger(prev, ledger([reopened], [decided(3), decided(1)], null), reopened)
    expect(merged.open.map((r) => r.id)).toEqual(['d002'])
    expect(merged.history.map((r) => r.id)).toEqual(['d003', 'd001'])
    expect(merged.nextBefore).toBeNull()
  })
})
