import { describe, expect, it } from 'vitest'
import { fableMeter, mainMeters, type UsageAccount } from './usagePools'

const claude = (meters: UsageAccount['meters']): UsageAccount => ({ id: 'claude:a', backend: 'claude', label: 'a', meters })

describe('fableMeter', () => {
  it("finds Claude's Fable tier and keeps it out of the main windows", () => {
    const a = claude([
      { key: 'session:', label: '5-hour limit', remainingPct: 53, windowMinutes: 300 },
      { key: 'weekly_all:', label: '7-day limit', remainingPct: 22, windowMinutes: 10080 },
      { key: 'weekly_scoped:Fable', label: '7-day Fable', remainingPct: 64, windowMinutes: 10080 },
    ])
    expect(fableMeter(a)?.remainingPct).toBe(64)
    expect(mainMeters(a).map((m) => m.key)).toEqual(['session:', 'weekly_all:'])
  })

  it('is absent without a reading, for other scoped caps, and for other providers', () => {
    expect(fableMeter(claude([{ key: 'weekly_scoped:Fable', label: '7-day Fable', remainingPct: null }]))).toBeUndefined()
    expect(fableMeter(claude([{ key: 'weekly_scoped:Opus', label: '7-day Opus', remainingPct: 40 }]))).toBeUndefined()
    expect(fableMeter({ ...claude([{ key: 'weekly_scoped:Fable', label: 'Fable', remainingPct: 5 }]), backend: 'codex' })).toBeUndefined()
  })
})
