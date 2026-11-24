import { describe, it, expect } from 'vitest'
import { shelve, shelfOf, settledAt, offersSettle, taskDoneSince, ownerAt, keptOpenId, snoozePresets, customSnooze, countdown, ago, wakeChange, ownerMessageChange, nextWake, DAY_MS, HOUR_MS } from './settle'
import type { ChatThread } from './types'

const NOW = new Date(2026, 9, 6, 10, 0).getTime() // Tue 6 Oct 2026, 10:00 local
const chat = (id: string, extra: Partial<ChatThread> = {}): ChatThread => ({ id, kind: 'regular', messages: [], createdAt: NOW - HOUR_MS, updatedAt: NOW - HOUR_MS, ...extra })

describe('shelves', () => {
  it('settles a chat its agent marked done once the reply is read, and offers Settle until then', () => {
    const done = chat('d', { doneAt: NOW - 60_000, updatedAt: NOW - 30_000 })
    // Unread: still in play, with Settle on the row.
    expect(settledAt({ ...done, needsReply: true }, NOW, 3)).toBe(0)
    expect(offersSettle({ ...done, needsReply: true }, 'active')).toBe(true)
    // Read: settled at its last activity, at once.
    expect(settledAt(done, NOW, 3)).toBe(NOW - 30_000)
    expect(shelfOf(done, NOW, 3)).toBe('settled')
    // The chat on screen stays put until he moves off it.
    expect(settledAt(done, NOW, 3, false, true)).toBe(0)
    expect(shelve([done], NOW, 3, () => false, 'd').active.map((t) => t.id)).toEqual(['d'])
    expect(shelve([done], NOW, 3, () => false, 'other').settled.map((t) => t.id)).toEqual(['d'])
    expect(settledAt({ ...done, settledOverride: 'settled', settledAt: NOW }, NOW, 3, false, true)).toBe(NOW)
    // Opened from the Settled shelf, it isn't kept: it stays on the shelf.
    expect(keptOpenId('d', null)).toBe('d')
    expect(keptOpenId('d', 'd')).toBe(null)
    expect(keptOpenId(null, null)).toBe(null)
    // Not while it runs, pinned, snoozed, taken back by hand, or with auto-settle off.
    expect(settledAt(done, NOW, 3, true)).toBe(0)
    expect(offersSettle(done, 'active', true)).toBe(false)
    expect(settledAt({ ...done, pinned: true }, NOW, 3)).toBe(0)
    expect(offersSettle({ ...done, pinned: true }, 'active')).toBe(false)
    expect(settledAt({ ...done, snoozedUntil: NOW + HOUR_MS }, NOW, 3)).toBe(0)
    expect(settledAt({ ...done, settledOverride: 'active' }, NOW, 3)).toBe(0)
    expect(offersSettle({ ...done, settledOverride: 'active' }, 'active')).toBe(false)
    expect(settledAt(done, NOW, 0)).toBe(0)
    expect(offersSettle(done, 'active')).toBe(true)
    expect(offersSettle(done, 'settled')).toBe(false)
    expect(offersSettle(chat('plain'), 'active')).toBe(false)
  })

  it('settles a chat whose linked task was finished after he last wrote in it, as T3 does a merged pull request', () => {
    const asked = { id: 'm1', role: 'user' as const, content: 'fix the printer', createdAt: NOW - 2 * HOUR_MS }
    const linked = chat('t', { taskId: 'task-1', messages: [asked], createdAt: NOW - 3 * HOUR_MS, updatedAt: NOW - HOUR_MS })
    // The task is open: nothing happens.
    expect(settledAt(linked, NOW, 3)).toBe(0)
    // Done after his last message: settled once the reply is read, at the later of the two.
    const done = { ...linked, taskDoneAt: NOW - 30 * 60_000 }
    expect(taskDoneSince(done)).toBe(NOW - 30 * 60_000)
    expect(settledAt(done, NOW, 3)).toBe(NOW - 30 * 60_000)
    expect(shelve([done], NOW, 3).settled.map((t) => t.id)).toEqual(['t'])
    // Unread: still in play, with Settle on the row. On screen: it stays put.
    expect(settledAt({ ...done, needsReply: true }, NOW, 3)).toBe(0)
    expect(offersSettle({ ...done, needsReply: true }, 'active')).toBe(true)
    expect(settledAt(done, NOW, 3, false, true)).toBe(0)
    // He wrote in it after the task was done: he came back for something else.
    const again = { ...done, messages: [asked, { ...asked, id: 'm2', createdAt: NOW - 10 * 60_000 }] }
    expect(ownerAt(again)).toBe(NOW - 10 * 60_000)
    expect(taskDoneSince(again)).toBe(0)
    expect(settledAt(again, NOW, 3)).toBe(0)
    expect(offersSettle(again, 'active')).toBe(false)
    // Taken off the shelf by hand, pinned, running, or auto-settle off: it stays.
    expect(settledAt({ ...done, settledOverride: 'active', unsettledAt: NOW - 60_000 }, NOW, 3)).toBe(0)
    expect(settledAt({ ...done, pinned: true }, NOW, 3)).toBe(0)
    expect(settledAt(done, NOW, 3, true)).toBe(0)
    expect(settledAt(done, NOW, 0)).toBe(0)
    // A chat started after the task was done (linked to finished work) doesn't settle for it.
    expect(taskDoneSince({ ...done, messages: [], createdAt: NOW - 20 * 60_000 })).toBe(0)
    // A summary cut past his latest message still knows it, from the bridge's lastOwnerAt.
    expect(taskDoneSince({ ...done, messages: [], lastOwnerAt: NOW - 10 * 60_000 })).toBe(0)
    // Waiting on him (a question, say): in play on every list, unless he settled it himself.
    expect(shelfOf(done, NOW, 3, false, false, true)).toBe('active')
    expect(shelve([done], NOW, 3, () => false, null, () => true).active.map((t) => t.id)).toEqual(['t'])
    expect(shelfOf({ ...done, settledOverride: 'settled', settledAt: NOW }, NOW, 3, false, false, true)).toBe('settled')
    // A /compact the bridge ran is not him writing.
    expect(taskDoneSince({ ...done, messages: [asked, { ...asked, id: 'c', content: '/compact', command: 'compact', createdAt: NOW - 5 * 60_000 }] })).toBe(NOW - 30 * 60_000)
  })

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

describe('writing in a chat', () => {
  const written = (t: ChatThread) => ({ ...t, ...ownerMessageChange(t, NOW) })
  it('brings a settled chat back to the top', () => {
    const t = written(chat('s', { settledOverride: 'settled', settledAt: NOW - DAY_MS }))
    expect(t).toMatchObject({ settledOverride: undefined, settledAt: undefined, unsettledAt: NOW })
    expect(shelfOf(t, NOW, 3)).toBe('active')
  })
  it('wakes a snoozed chat, drops its timer and puts it at the top', () => {
    const t = written(chat('z', { snoozedUntil: NOW + DAY_MS, snoozedAt: NOW - HOUR_MS }))
    expect(t).toMatchObject({ snoozedUntil: undefined, snoozedAt: undefined, unsettledAt: NOW })
    expect(shelve([chat('x', { updatedAt: NOW - 60_000 }), t], NOW, 3).active.map((c) => c.id)).toEqual(['z', 'x'])
  })
  it('hands a chat taken off the shelf by hand back to auto-settle', () => {
    expect(written(chat('a', { settledOverride: 'active', unsettledAt: NOW - DAY_MS }))).toMatchObject({ settledOverride: undefined, unsettledAt: NOW - DAY_MS })
  })
  it('keeps a chat the agent marked done from settling as soon as it is read', () => {
    const t = written(chat('d', { doneAt: NOW - 60_000, updatedAt: NOW - 30_000 }))
    expect(t.doneAt).toBeUndefined()
    expect(shelfOf(t, NOW, 3)).toBe('active')
  })
  it('leaves a chat already in play where it is', () => {
    expect(ownerMessageChange(chat('p'), NOW)).not.toHaveProperty('unsettledAt')
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
