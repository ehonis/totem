import { describe, expect, it } from 'vitest'
import { agendaDays, compactTitle, rangeTitle } from './agenda'

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)

describe('calendar titles', () => {
  it('names a week inside one month without Intl’s "(day: 28)"', () => {
    const title = rangeTitle('week', at(2026, 11, 25))
    expect(title).not.toMatch(/day:/)
    expect(title).toMatch(/22 – 28, 2026$/)
  })
  it('names a week across months and years in full', () => {
    expect(rangeTitle('week', at(2026, 12, 30))).toMatch(/27, 2026 – Jan 2, 2027$/)
  })
  it('keeps the phone title short and drops this year', () => {
    expect(compactTitle('week', at(2026, 11, 25), at(2026, 11, 25))).toMatch(/22 – 28$/)
    expect(compactTitle('month', at(2027, 1, 5), at(2026, 11, 25))).toMatch(/2027/)
  })
})

describe('agenda days', () => {
  const now = at(2026, 11, 25, 10, 0)
  const range: [Date, Date] = [at(2026, 11, 25), at(2026, 12, 9)]
  it('always heads today and tomorrow, and a day away', () => {
    const days = agendaDays([], [{ id: 'a', start: '2026-11-28', end: '2026-11-28', label: 'Trip', kind: 'trip' }], range, now)
    expect(days.map((d) => d.heading).slice(0, 2)).toEqual(['Today', 'Tomorrow'])
    expect(days[2].away?.label).toBe('Trip')
  })
  it('dims what is over and puts the now line before the next event', () => {
    const events = [
      { id: '1', title: 'Standup', start: at(2026, 11, 25, 9).toISOString(), end: at(2026, 11, 25, 9, 30).toISOString() },
      { id: '2', title: 'Review', start: at(2026, 11, 25, 13).toISOString(), end: at(2026, 11, 25, 14).toISOString() },
    ]
    const [today] = agendaDays(events, [], range, now)
    expect(today.events.map((e) => e.past)).toEqual([true, false])
    expect(today.nowAt).toBe(1)
  })
})
