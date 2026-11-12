import { afterEach, describe, expect, it } from 'vitest'

import { addDays, dateKey, dateLabel, dueDateChoices, dueText, dueTone, isDayKey, snoozeTimes } from './format'

// Monday 14 September 2026, 15:06 local: the moment the card's own snooze tests use.
const NOW = new Date(2026, 8, 14, 15, 6)
const parts = (value: Date) => [value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes()]
const option = (now: Date, label: string, dueDate: string | null = null) => {
  const found = snoozeTimes(now, dueDate).find((item) => item.label === label)
  if (!found) throw new Error(`no "${label}" snooze`)
  return found
}

const ORIGINAL_TZ = process.env.TZ
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})
/** New York, checked: its clocks spring forward on 8 March 2026 and fall back on 1 November. */
function inNewYork() {
  process.env.TZ = 'America/New_York'
  const offsets = [new Date(2026, 0, 15, 12).getTimezoneOffset(), new Date(2026, 6, 15, 12).getTimezoneOffset()]
  expect(offsets, 'the runtime must honour TZ for these tests to mean anything').toEqual([300, 240])
}

describe('day keys', () => {
  it('addDays steps calendar days, across months, years and both clock changes', () => {
    inNewYork()
    expect(addDays('2026-11-04', 1)).toBe('2026-11-05')
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(addDays('2026-10-25', 14)).toBe('2026-11-08')
    expect(() => addDays('11/04/2026', 1)).toThrow(RangeError)
  })

  it('isDayKey accepts only real days', () => {
    expect(isDayKey('2026-11-04')).toBe(true)
    expect(isDayKey('2028-02-29')).toBe(true)
    expect(isDayKey('2026-02-29')).toBe(false)
    expect(isDayKey('2026-13-01')).toBe(false)
    expect(isDayKey('11/23/2026')).toBe(false)
    expect(isDayKey('')).toBe(false)
    expect(isDayKey(null)).toBe(false)
  })

  it('dateKey and dateLabel read the local calendar', () => {
    expect(dateKey(new Date(2026, 8, 14, 23, 59))).toBe('2026-09-14')
    expect(dateLabel('2026-09-14')).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(2026, 8, 14)))
  })
})

describe('dueText', () => {
  it('says Today, Tomorrow, the overdue date, or the date', () => {
    expect(dueText('2026-09-14', NOW)).toBe('Today')
    expect(dueText('2026-09-15', NOW)).toBe('Tomorrow')
    expect(dueText('2026-09-10', NOW)).toBe(`Overdue · ${dateLabel('2026-09-10')}`)
    expect(dueText('2026-09-20', NOW)).toBe(dateLabel('2026-09-20'))
  })

  it('gives a finished task only its date', () => {
    expect(dueText('2026-09-10', NOW, 'done')).toBe(dateLabel('2026-09-10'))
    expect(dueText('2026-09-14', NOW, 'done')).toBe(dateLabel('2026-09-14'))
    expect(dueText('2026-09-15', NOW, 'done')).toBe(dateLabel('2026-09-15'))
  })

  it('treats a "doing" task as open', () => {
    expect(dueText('2026-09-14', NOW, 'doing')).toBe('Today')
  })

  it('finds tomorrow by calendar day on the nights the clocks change', () => {
    inNewYork()
    // 23:30 before the 23-hour day: 24 hours on is already the day after tomorrow.
    expect(dueText('2026-03-08', new Date(2026, 2, 7, 23, 30))).toBe('Tomorrow')
    // 00:30 on the 25-hour day: 24 hours on is still today.
    expect(dueText('2026-11-02', new Date(2026, 10, 1, 0, 30))).toBe('Tomorrow')
  })

  it('dueTone has nothing to say about a finished task', () => {
    expect(dueTone('2026-09-10', NOW, 'done')).toBe('')
    expect(dueTone(null, NOW, 'todo')).toBe('')
    expect(dueTone('2026-09-10', NOW, 'todo')).toBe('overdue')
  })
})

describe('snoozeTimes', () => {
  it('offers the quick presets, the short ones exactly 20 and 60 minutes on', () => {
    const now = new Date('2026-09-14T19:06:00.000Z')
    const options = snoozeTimes(now)
    expect(options.map((item) => item.label)).toEqual(['In 20 minutes', 'In 1 hour', 'This evening', 'Tomorrow', 'Next Monday'])
    expect(options[0].value.toISOString()).toBe('2026-09-14T19:26:00.000Z')
    expect(options[1].value.toISOString()).toBe('2026-09-14T20:06:00.000Z')
  })

  it.each([
    ['This evening', [2026, 8, 14, 18, 0]],
    ['Tomorrow', [2026, 8, 15, 9, 0]],
    ['Next Monday', [2026, 8, 21, 9, 0]],
  ] as const)('anchors %s to its local calendar time', (label, expected) => {
    expect(parts(option(NOW, label).value)).toEqual(expected)
  })

  it('moves This evening to tomorrow once six has passed', () => {
    expect(parts(option(new Date(2026, 8, 14, 18, 30), 'This evening').value)).toEqual([2026, 8, 15, 18, 0])
  })

  it.each([
    ['2026-10-05', 'A week before it’s due', [2026, 8, 28]],
    ['2026-09-19', 'Two days before it’s due', [2026, 8, 17]],
    ['2026-09-17', 'The day before it’s due', [2026, 8, 16]],
  ] as const)('offers a run-up sized to the time left before %s', (dueDate, label, [year, month, day]) => {
    expect(parts(option(NOW, label, dueDate).value)).toEqual([year, month, day, 9, 0])
  })

  it('snoozes to the morning of the due date', () => {
    expect(option(NOW, 'The day it’s due', '2026-09-19').value.toISOString()).toBe(new Date(2026, 8, 19, 9, 0).toISOString())
  })

  it.each([
    ['tomorrow', '2026-09-15', ['The day it’s due']],
    ['today', '2026-09-14', []],
    ['in the past', '2026-09-10', []],
  ] as const)('drops the run-up when the task is due %s', (_when, dueDate, extra) => {
    expect(snoozeTimes(NOW, dueDate).slice(5).map((item) => item.label)).toEqual(extra)
  })

  it('offers no due-date snooze without a due date', () => {
    expect(snoozeTimes(NOW, null)).toHaveLength(5)
  })

  it('steps Tomorrow and Next Monday by calendar day on the nights the clocks change', () => {
    inNewYork()
    // Saturday 7 March, 23:30: the night before the 23-hour day.
    const spring = new Date(2026, 2, 7, 23, 30)
    expect(parts(option(spring, 'Tomorrow').value)).toEqual([2026, 2, 8, 9, 0])
    expect(parts(option(spring, 'Next Monday').value)).toEqual([2026, 2, 9, 9, 0])
    // Sunday 1 November, 00:30: the start of the 25-hour day.
    const fall = new Date(2026, 10, 1, 0, 30)
    expect(parts(option(fall, 'Tomorrow').value)).toEqual([2026, 10, 2, 9, 0])
    expect(parts(option(fall, 'The day before it’s due', '2026-11-03').value)).toEqual([2026, 10, 2, 9, 0])
  })
})

describe('dueDateChoices', () => {
  it('offers Today, Tomorrow and next Monday as day keys', () => {
    expect(dueDateChoices(NOW).map(({ label, key }) => [label, key])).toEqual([
      ['Today', '2026-09-14'], ['Tomorrow', '2026-09-15'], ['Next week', '2026-09-21'],
    ])
    expect(dueDateChoices(NOW)[1].detail).toBe(dateLabel('2026-09-15'))
  })

  it('counts by calendar day on the nights the clocks change', () => {
    inNewYork()
    expect(dueDateChoices(new Date(2026, 2, 7, 23, 30)).map((item) => item.key)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09'])
    expect(dueDateChoices(new Date(2026, 10, 1, 0, 30)).map((item) => item.key)).toEqual(['2026-11-01', '2026-11-02', '2026-11-02'])
  })
})
