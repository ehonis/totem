import { describe, it, expect } from 'vitest'
import { shelve, shelfOf, settledAt, snoozePresets, customSnooze, countdown, ago, wakeChange, nextWake, DAY_MS, HOUR_MS } from './settle'
import type { ChatThread } from './types'

const NOW = new Date(2026, 9, 6, 10, 0).getTime() // Tue 6 Oct 2026, 10:00 local
const chat = (id: string, extra: Partial<ChatThread> = {}): ChatThread => ({ id, kind: 'regular', messages: [], createdAt: NOW - HOUR_MS, updatedAt: NOW - HOUR_MS, ...extra })

describe('shelves', () => {
  it('splits a list into active, snoozed (soonest first) and settled (latest first)', () => {
    const { active, snoozed, settled } = shelve([
      chat('a'),
      chat('s1', { snoozedUntil: NOW + 3 * HOUR_MS }),
      chat('s2', { snoozedUntil: NOW + HOUR_MS }),
      chat('old', { settledOverride: 'settled', settledAt: NOW - DAY_MS }),
      chat('new', { settledOverride: 'settled', settledAt: NOW - HOUR_MS }),
    ], NOW, 3)
    expect(active.map((t) => t.id)).toEqual(['a'])
    expect(snoozed.map((t) => t.id)).toEqual(['s2', 's1'])
    expect(settled.map((t) => t.id)).toEqual(['new', 'old'])
  })

  it('auto-settles a quiet chat at its last activity, unless pinned, running, or un-settled by hand', () => {
    const quiet = chat('q', { updatedAt: NOW - 4 * DAY_MS })
    expect(settledAt(quiet, NOW, 3)).toBe(NOW - 4 * DAY_MS)
    expect(settledAt(quiet, NOW, 0)).toBe(0)
    expect(settledAt(quiet, NOW, 7)).toBe(0)
    expect(settledAt({ ...quiet, pinned: true }, NOW, 3)).toBe(0)
    expect(settledAt(quiet, NOW, 3, true)).toBe(0)
    expect(settledAt({ ...quiet, settledOverride: 'active' }, NOW, 3)).toBe(0)
  })

  it('counts coming off the shelf as activity', () => {
    expect(shelfOf(chat('u', { updatedAt: NOW - 10 * DAY_MS, unsettledAt: NOW - HOUR_MS }), NOW, 3)).toBe('active')
  })

  it('puts a snooze over a settle, and wakes it once the time passes', () => {
    const t = chat('z', { settledOverride: 'settled', settledAt: NOW - DAY_MS, snoozedUntil: NOW + HOUR_MS })
    expect(shelfOf(t, NOW, 3)).toBe('snoozed')
    expect(shelfOf(chat('w', { snoozedUntil: NOW - 1 }), NOW, 3)).toBe('active')
  })

  it('finds the next wake', () => {
    expect(nextWake([chat('a', { snoozedUntil: NOW + 5 }), chat('b', { snoozedUntil: NOW + 2 }), chat('c', { snoozedUntil: NOW - 1 })], NOW)).toBe(NOW + 2)
  })

  it('moves a chat woken early to the top; acknowledging a past wake does not', () => {
    expect(wakeChange(chat('a', { snoozedUntil: NOW + HOUR_MS }), NOW)).toMatchObject({ snoozedUntil: undefined, unsettledAt: NOW })
    expect(wakeChange(chat('a', { snoozedUntil: NOW - HOUR_MS }), NOW)).not.toHaveProperty('unsettledAt')
  })
})

describe('snooze presets', () => {
  const ids = (d: Date) => snoozePresets(d).map((p) => p.id)
  it('offers the evening only while it is over an hour away', () => {
    expect(ids(new Date(2026, 9, 6, 16, 59))).toContain('evening')
    expect(ids(new Date(2026, 9, 6, 17, 0))).not.toContain('evening')
  })
  it('wakes tomorrow and next Monday at 9:00', () => {
    const p = snoozePresets(new Date(NOW))
    expect(new Date(p.find((x) => x.id === 'tomorrow')!.until)).toEqual(new Date(2026, 9, 7, 9, 0))
    expect(new Date(p.find((x) => x.id === 'next-week')!.until)).toEqual(new Date(2026, 9, 12, 9, 0))
  })
  it('leaves out next week on a Sunday, and means a week on a Monday', () => {
    expect(ids(new Date(2026, 9, 11, 10, 0))).not.toContain('next-week')
    const monday = snoozePresets(new Date(2026, 9, 12, 10, 0)).find((x) => x.id === 'next-week')!
    expect(new Date(monday.until)).toEqual(new Date(2026, 9, 19, 9, 0))
  })
})

describe('custom snooze', () => {
  it('takes a future date and time, refuses the past and impossible dates', () => {
    expect(customSnooze({ mode: 'date', date: '2026-10-07', time: '14:30' }, NOW)).toEqual({ until: new Date(2026, 9, 7, 14, 30).getTime() })
    expect(customSnooze({ mode: 'date', date: '2026-10-06', time: '09:00' }, NOW)).toHaveProperty('error')
    expect(customSnooze({ mode: 'date', date: '2026-02-30', time: '09:00' }, NOW)).toHaveProperty('error')
  })
  it('takes a positive duration', () => {
    expect(customSnooze({ mode: 'duration', amount: 2, unit: 'hours' }, NOW)).toEqual({ until: NOW + 2 * HOUR_MS })
    expect(customSnooze({ mode: 'duration', amount: 0, unit: 'hours' }, NOW)).toHaveProperty('error')
  })
})

describe('labels', () => {
  it('rounds a countdown up', () => {
    expect(countdown(NOW + 30_000, NOW)).toBe('1m')
    expect(countdown(NOW + 61 * 60_000, NOW)).toBe('2h')
    expect(countdown(NOW + 25 * HOUR_MS, NOW)).toBe('2d')
    expect(countdown(NOW - 1, NOW)).toBe('now')
  })
  it('says how long ago compactly', () => {
    expect(ago(NOW - 12 * 60_000, NOW)).toBe('12m')
    expect(ago(NOW - 18 * HOUR_MS, NOW)).toBe('18h')
    expect(ago(NOW - 3 * DAY_MS, NOW)).toBe('3d')
    expect(ago(NOW - 21 * DAY_MS, NOW)).toBe('3w')
  })
})
