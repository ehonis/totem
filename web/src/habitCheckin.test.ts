import { describe, expect, it } from 'vitest'
import { checkinItems, periodNote, shouldOpenCheckin } from './habitCheckin'

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
    expect(got).toEqual(['yesterday:gracie', 'yesterday:business', 'yesterday:gym', 'today:journal'])
  })

  it('counts a "no" as answered', () => {
    const p = { ...base, entries: { '2026-10-09': { read: { count: 1 }, gracie: { count: 0, skipped: true } } } }
    expect(checkinItems(p).items.map((i) => i.habit.id)).toEqual(['business', 'gym', 'journal'])
  })

  it('stops asking about a weekly habit once its week is met, but keeps the row it just ticked', () => {
    // 2026-10-09 is a Friday; its week runs Monday 10-05 to Sunday 10-11.
    const met = { ...base, entries: { ...base.entries, '2026-10-05': { business: { count: 2 } }, '2026-10-07': { business: { count: 2 } } } }
    expect(checkinItems(met).items.map((i) => i.habit.id)).not.toContain('business')
    // Last week's count is not this week's.
    const lastWeek = { ...base, entries: { ...base.entries, '2026-10-04': { business: { count: 4 } } } }
    expect(checkinItems(lastWeek).items.map((i) => i.habit.id)).toContain('business')
    // Ticking yesterday itself to the quota leaves it in the open sheet.
    const justTicked = { ...base, entries: { '2026-10-05': { business: { count: 3 } }, '2026-10-09': { business: { count: 1 } } } }
    expect(checkinItems(justTicked, true).items.map((i) => i.habit.id)).toContain('business')
    expect(checkinItems(justTicked).items.map((i) => i.habit.id)).not.toContain('business')
  })

  it('shows a weekly row its progress for the week, the answered day included', () => {
    const p = { ...base, entries: { '2026-10-05': { business: { count: 1 } }, '2026-10-09': { business: { count: 1 } } } }
    const item = checkinItems(p, true).items.find((i) => i.habit.id === 'business')!
    expect(periodNote(item, p.entries)).toBe('2/4 this week')
    expect(periodNote(checkinItems(p).items.find((i) => i.habit.id === 'gracie')!, p.entries)).toBe('')
    // On a Monday, Sunday's row counts the week that just ended.
    const monday = { ...p, today: '2026-10-12', entries: { '2026-10-11': { business: { count: 1 } } } }
    expect(periodNote(checkinItems(monday, true).items.find((i) => i.habit.id === 'business')!, monday.entries)).toBe('1/4 last week')
  })

  it('counts a monthly habit over its calendar month', () => {
    const p = { ...base, habits: [habit('rent', { cadence: 'monthly', target: 2 })] }
    expect(checkinItems(p).items.map((i) => i.habit.id)).toEqual(['rent'])
    const met = { ...p, entries: { '2026-10-01': { rent: { count: 2 } } } }
    expect(checkinItems(met).items).toEqual([])
    const lastMonth = { ...p, entries: { '2026-09-30': { rent: { count: 2 } } } }
    expect(checkinItems(lastMonth).items.map((i) => i.habit.id)).toEqual(['rent'])
  })

  it('opens once a day, after 4am, only with something to ask', () => {
    expect(shouldOpenCheckin(base, at(7))).toBe(true)
    expect(shouldOpenCheckin(base, at(2))).toBe(false)
    expect(shouldOpenCheckin({ ...base, checkin: { lastShown: '2026-10-10' } }, at(7))).toBe(false)
    expect(shouldOpenCheckin({ ...base, habits: [habit('krakatoa', { linkedApp: 'krakatoa' })] }, at(7))).toBe(false)
  })
})

describe('morning check-in with sub-habits', () => {
  it('asks a group’s sub-habits, named with their group, never the group itself', () => {
    const p = {
      today: '2026-10-10',
      checkin: { lastShown: null },
      habits: [
        habit('night', { name: 'Nightly routine', when: 'night' }),
        habit('stretch', { name: 'Stretch', when: 'night', parentId: 'night' }),
        habit('screens', { name: 'No screens', when: 'night', parentId: 'night' }),
        habit('read'),
      ],
      entries: { '2026-10-09': { screens: { count: 1 } } },
    }
    const got = checkinItems(p).items.map((i) => [i.habit.id, i.group ?? null])
    expect(got).toEqual([['stretch', 'Nightly routine'], ['read', null]])
  })
})
