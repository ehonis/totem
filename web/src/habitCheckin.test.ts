import { describe, expect, it } from 'vitest'
import { checkinItems, shouldOpenCheckin } from './habitCheckin'

const habit = (id: string, extra: any = {}) => ({ id, name: id, cadence: 'daily', target: 1, createdAt: '2026-01-01T00:00:00Z', archived: false, when: 'any', linkedApp: null, metric: null, ...extra })
const at = (h: number) => new Date(2026, 9, 10, h)

describe('morning check-in', () => {
  const base = {
    today: '2026-10-10',
    checkin: { lastShown: null },
    habits: [
      habit('read'),
      habit('gracie', { when: 'night' }),
      habit('journal', { when: 'morning' }),
      habit('krakatoa', { linkedApp: 'krakatoa' }),
      habit('sleep', { metric: { label: 'Sleep', source: 'whoop-sleep' } }),
      habit('business', { cadence: 'weekly', target: 4 }),
      habit('gym', { cadence: 'weekly', target: 3, when: 'night' }),
    ],
    entries: { '2026-10-09': { read: { count: 1 } } },
  }

  it('asks about yesterday and this morning, never app- or sync-filled habits', () => {
    const got = checkinItems(base).items.map((i) => `${i.part}:${i.habit.id}`)
    expect(got).toEqual(['yesterday:gracie', 'yesterday:gym', 'today:journal'])
  })

  it('counts a "no" as answered', () => {
    const p = { ...base, entries: { '2026-10-09': { read: { count: 1 }, gracie: { count: 0, skipped: true } } } }
    expect(checkinItems(p).items.map((i) => i.habit.id)).toEqual(['gym', 'journal'])
  })

  it('opens once a day, after 4am, only with something to ask', () => {
    expect(shouldOpenCheckin(base, at(7))).toBe(true)
    expect(shouldOpenCheckin(base, at(2))).toBe(false)
    expect(shouldOpenCheckin({ ...base, checkin: { lastShown: '2026-10-10' } }, at(7))).toBe(false)
    expect(shouldOpenCheckin({ ...base, habits: [habit('krakatoa', { linkedApp: 'krakatoa' })] }, at(7))).toBe(false)
  })
})
