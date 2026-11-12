// Away spans on the dashboard: day matching, the Overview band's wording.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { awayDaysIn, awayOn, awayStatus, dayKey, upcomingAway, type AwaySpan } from './away'

const span = (start: string, end: string, label: string): AwaySpan => ({ id: label, start, end, label, kind: 'trip' })
const LISBON = span('2026-11-02', '2026-11-04', 'Lisbon')

// West of Greenwich, so a late-evening local time is already tomorrow in UTC.
let tz: string | undefined
beforeAll(() => { tz = process.env.TZ; process.env.TZ = 'America/Los_Angeles' })
afterAll(() => { process.env.TZ = tz })

describe('away days', () => {
  it('match a grid day by its local date, not its UTC one', () => {
    const lateOnTheFirst = new Date(2026, 10, 1, 23, 30)
    expect(lateOnTheFirst.toISOString().slice(0, 10)).toBe('2026-11-02')
    expect(dayKey(lateOnTheFirst)).toBe('2026-11-01')
    expect(awayOn([LISBON], dayKey(lateOnTheFirst))).toBeNull()
    expect(awayOn([LISBON], dayKey(new Date(2026, 10, 4, 23, 30)))?.label).toBe('Lisbon')
    expect(awayOn([LISBON], dayKey(new Date(2026, 10, 5, 0, 30)))).toBeNull()
  })

  it('list today\'s span and the next month\'s, soonest first', () => {
    const spans = [span('2026-12-20', '2026-12-27', 'Holidays'), LISBON, span('2026-10-01', '2026-10-03', 'Past'), span('2027-02-01', '2027-02-02', 'Far')]
    expect(upcomingAway(spans, '2026-11-03').map((s) => s.label)).toEqual(['Lisbon'])
    expect(upcomingAway(spans, '2026-11-30').map((s) => s.label)).toEqual(['Holidays'])
  })

  it('word the band for now, the last day, and later', () => {
    expect(awayStatus(LISBON, '2026-11-03')).toMatch(/^until /)
    expect(awayStatus(LISBON, '2026-11-04')).toBe('last day')
    expect(awayStatus(LISBON, '2026-11-01')).toMatch(/^tomorrow · /)
    expect(awayStatus(LISBON, '2026-10-30')).toMatch(/^in 3 days · /)
  })

  it('give the agenda every away day in its range, even with no events', () => {
    // The agenda's two weeks from 30 October: Lisbon's three days, and nothing past the range.
    const days = awayDaysIn([LISBON, span('2026-11-20', '2026-11-21', 'Later')], new Date(2026, 9, 30), new Date(2026, 10, 13))
    expect(days.map(dayKey)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04'])
    expect(awayDaysIn([], new Date(2026, 9, 30), new Date(2026, 10, 13))).toEqual([])
  })
})
