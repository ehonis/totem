// Run with: node --test notify/
//
// These collectors decide what Totem is allowed to say. A missed birthday and a
// nudge about a habit that was already logged are both failures of this file, and
// neither one throws, so they are tested against fixtures shaped like the real
// data/brain/people/people.md and data/habits.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { zonedToUtc } from '../jobs/schedule.mjs'
import { parsePeople, birthdayFacts, daysUntilAnniversary, goalFacts, habitFacts, metricFacts, streakBefore, weekProgress, taskFacts } from './signals.mjs'
import { CATEGORY_NAMES } from './categories.mjs'
import { TITLE_MAX } from './text.mjs'

const TZ = 'America/New_York'
const at = (s) => {
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/)
  return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, TZ)
}

const PEOPLE_MD = `
# People

## Family

- 2026-06-18 | Marion Keller | mother | Lives nearby. Accountant. Birthday 1961-09-11.
- 2026-06-18 | Glen Keller | father | Retired. Birthday 1958-08-30.

## Partner

- 2026-06-18 | Robin Ashby | partner | Life partner. Birthday 1999-11-21. Lives out of state.
- 2026-08-16 | Robin Ashby | partner | Birthday gift list for Nov 2026 started.

## Friends

- 2026-06-18 | Nolan Pierce (Nol) | close friend | Civil engineer. No birthday recorded.
`

test('people parse keeps one row per person and finds the birthday wherever it sits', () => {
  const people = parsePeople(PEOPLE_MD)
  const byName = Object.fromEntries(people.map((p) => [p.name, p]))
  assert.equal(people.length, 4)
  assert.deepEqual(byName['Marion Keller'].birthday, { year: 1961, month: 9, day: 11 })
  assert.deepEqual(byName['Robin Ashby'].birthday, { year: 1999, month: 11, day: 21 })
  // A person with no birthday is kept, with null, rather than dropped.
  assert.equal(byName['Nolan Pierce (Nol)'].birthday, null)
})

test('a second line for the same person does not erase the birthday from the first', () => {
  // Robin appears twice and only the first line carries the date. This is how the
  // real file grows, and the obvious last-write-wins parse loses her birthday.
  const people = parsePeople(PEOPLE_MD)
  assert.ok(people.find((p) => p.name === 'Robin Ashby').birthday)
})

test('a birthday today is a pinned, maximum-salience fact', () => {
  const facts = birthdayFacts({ people: parsePeople(PEOPLE_MD), now: at('2026-09-11 07:15'), tz: TZ })
  const today = facts.filter((f) => f.kind === 'birthday.today')
  assert.equal(today.length, 1)
  assert.equal(today[0].subject, 'Marion Keller')
  assert.equal(today[0].salience, 100)
  assert.equal(today[0].category, 'person.birthday')
  assert.equal(today[0].slot, 'morning')
  assert.equal(today[0].title, 'Marion turns 65 today')
  assert.match(today[0].body, /Your mom, Marion, turns 65 today/)
})

test('a birthday a week out gets a lead-time fact, and six days out gets nothing', () => {
  const people = parsePeople(PEOPLE_MD)
  const week = birthdayFacts({ people, now: at('2026-11-14 07:15'), tz: TZ })
  assert.equal(week.filter((f) => f.kind === 'birthday.upcoming' && f.subject === 'Robin Ashby').length, 1)
  const six = birthdayFacts({ people, now: at('2026-11-15 07:15'), tz: TZ })
  assert.equal(six.length, 0)
})

test('the day rolls over in the local zone, not UTC', () => {
  // 23:30 on the 10th in New York is already the 11th in UTC. A birthday must not
  // fire the evening before.
  const people = parsePeople(PEOPLE_MD)
  assert.equal(birthdayFacts({ people, now: at('2026-09-10 23:30'), tz: TZ }).length, 0)
})

test('anniversary maths wraps the year and survives Feb 29', () => {
  assert.equal(daysUntilAnniversary({ year: 1961, month: 9, day: 11 }, { year: 2026, month: 9, day: 11 }), 0)
  assert.equal(daysUntilAnniversary({ year: 1961, month: 9, day: 11 }, { year: 2026, month: 9, day: 12 }), 364)
  assert.equal(daysUntilAnniversary({ year: 1958, month: 8, day: 30 }, { year: 2026, month: 8, day: 23 }), 7)
  // 2026 is not a leap year: a Feb 29 birthday falls back to Mar 1 rather than
  // never occurring.
  assert.equal(daysUntilAnniversary({ year: 2000, month: 2, day: 29 }, { year: 2026, month: 2, day: 28 }), 1)
})

const HABITS = [
  { id: 'journal', name: '3 Year Journal', cadence: 'daily', target: 1 },
  { id: 'move', name: 'Move Every Day', cadence: 'daily', target: 1 },
  { id: 'business', name: 'Help the Business', cadence: 'weekly', target: 4 },
  { id: 'sleep', name: 'Sleep', cadence: 'daily', target: 1, metric: { goal: 85, direction: 'higher', unit: '%' } },
]

// Week of Sunday 2026-09-06. "Now" in the tests below is Friday 2026-09-11.
const ENTRIES = {
  '2026-09-06': { journal: { count: 1 }, move: { count: 2 }, sleep: { count: 1, value: 80 } },
  '2026-09-07': { journal: { count: 1 }, move: { count: 0 }, sleep: { count: 1, value: 84 } },
  '2026-09-08': { journal: { count: 1 }, move: { count: 2 }, business: { count: 1 }, sleep: { count: 1, value: 78 } },
  '2026-09-09': { journal: { count: 1 }, move: { count: 2 }, business: { count: 1 }, sleep: { count: 1, value: 65 } },
  '2026-09-10': { journal: { count: 1 }, move: { count: 1 }, business: { count: 1 }, sleep: { count: 1, value: 64 } },
  '2026-09-11': { sleep: { count: 1, value: 75 } },
}

test('streaks count back from today and stop at the first miss', () => {
  const friday = Date.UTC(2026, 8, 11)
  assert.equal(streakBefore(ENTRIES, 'journal', 1, friday), 5)
  // Move was missed on the 7th, so the streak back from Friday is three days.
  assert.equal(streakBefore(ENTRIES, 'move', 1, friday), 3)
})

test('a daily habit not yet logged today warns that the streak ends tonight', () => {
  const facts = habitFacts({ habits: HABITS, entries: ENTRIES, now: at('2026-09-11 18:00'), tz: TZ })
  const journal = facts.find((f) => f.subject === 'journal')
  assert.equal(journal.kind, 'habit.streak-ending')
  assert.equal(journal.category, 'habit.slipping')
  assert.equal(journal.slot, 'evening')
  // 'Streak ends tonight: 3 Year Journal' is 35 characters, past what a phone
  // shows, so the habit name drops to the body rather than being truncated.
  assert.equal(journal.title, 'Streak ends tonight')
  assert.match(journal.body, /5 days running/)
  // The other copy, for when it gets logged before the nudge fires.
  assert.match(journal.resolvedTitle, /Streak intact/)
})

test('a habit already logged today produces no fact at all', () => {
  const entries = { ...ENTRIES, '2026-09-11': { ...ENTRIES['2026-09-11'], journal: { count: 1 } } }
  const facts = habitFacts({ habits: HABITS, entries, now: at('2026-09-11 18:00'), tz: TZ })
  assert.equal(facts.find((f) => f.subject === 'journal'), undefined)
})

test('a one-day streak is not worth a notification', () => {
  const entries = { '2026-09-10': { journal: { count: 1 } } }
  const facts = habitFacts({ habits: HABITS, entries, now: at('2026-09-11 18:00'), tz: TZ })
  assert.equal(facts.find((f) => f.subject === 'journal'), undefined)
})

test('a weekly target within reach is a nudge toward finishing, not a complaint', () => {
  // Help the Business: 3 of 4, Friday, three days left including today — the week
  // runs to Sunday.
  const progress = weekProgress(ENTRIES, 'business', 4, at('2026-09-11 18:00'), TZ)
  assert.deepEqual({ count: progress.count, daysLeft: progress.daysLeft, weekStart: progress.weekStart }, { count: 3, daysLeft: 3, weekStart: '2026-09-07' })

  const facts = habitFacts({ habits: HABITS, entries: ENTRIES, now: at('2026-09-11 18:00'), tz: TZ })
  const business = facts.find((f) => f.subject === 'business')
  assert.equal(business.category, 'goal.nearcomplete')
  assert.equal(business.title, 'One more to finish')
  assert.match(business.body, /Help the Business — 3 of 4 so far, 3 days left/)
  assert.match(business.resolvedTitle, /Done for the week/)
})

test('the near-target nudge gets more urgent on the last day', () => {
  const friday = habitFacts({ habits: HABITS, entries: ENTRIES, now: at('2026-09-11 18:00'), tz: TZ })
    .find((f) => f.subject === 'business')
  const sunday = habitFacts({ habits: HABITS, entries: ENTRIES, now: at('2026-09-13 18:00'), tz: TZ })
    .find((f) => f.subject === 'business')
  assert.ok(sunday.salience > friday.salience)
  assert.match(sunday.body, /1 day left/)
})

test('a weekly target already met says nothing', () => {
  const entries = { ...ENTRIES, '2026-09-11': { ...ENTRIES['2026-09-11'], business: { count: 1 } } }
  const facts = habitFacts({ habits: HABITS, entries, now: at('2026-09-11 18:00'), tz: TZ })
  assert.equal(facts.find((f) => f.subject === 'business'), undefined)
})

test('a weekly target that can no longer be hit is reported once, without pretending', () => {
  // Saturday, 1 of 4, one day left: three more is not happening.
  const entries = { '2026-09-08': { business: { count: 1 } } }
  const facts = habitFacts({ habits: HABITS, entries, now: at('2026-09-12 20:30'), tz: TZ })
  const business = facts.find((f) => f.subject === 'business')
  assert.equal(business.kind, 'habit.behind-pace')
  assert.equal(business.category, 'habit.slipping')
})

test('a metric under goal for several days is a trend; one bad night is not', () => {
  const facts = metricFacts({ habits: HABITS, entries: ENTRIES, now: at('2026-09-11 20:30'), tz: TZ })
  const sleep = facts.find((f) => f.subject === 'sleep')
  assert.equal(sleep.category, 'goal.slipping')
  assert.match(sleep.body, /6 of the last 6 days below 85%/)

  const oneBad = {
    '2026-09-11': { sleep: { count: 1, value: 60 } },
    '2026-09-10': { sleep: { count: 1, value: 90 } },
    '2026-09-09': { sleep: { count: 1, value: 91 } },
    '2026-09-08': { sleep: { count: 1, value: 88 } },
    '2026-09-07': { sleep: { count: 1, value: 92 } },
  }
  assert.equal(metricFacts({ habits: HABITS, entries: oneBad, now: at('2026-09-11 20:30'), tz: TZ }).length, 0)
})

test('a metric with too little data says nothing rather than guessing', () => {
  const sparse = { '2026-09-11': { sleep: { count: 1, value: 60 } } }
  assert.equal(metricFacts({ habits: HABITS, entries: sparse, now: at('2026-09-11 20:30'), tz: TZ }).length, 0)
})

const NOW_TASKS = at('2026-09-15 07:15')
const task = (over) => ({
  id: 't1', title: 'a task', status: 'todo', area: 'Personal', ventureTag: null,
  dueDate: null, snoozedUntil: null, completedAt: null, archivedAt: null, deletedAt: null,
  ...over,
})

test('no task list at all is silence, not an empty-board announcement', () => {
  assert.deepEqual(taskFacts({ now: NOW_TASKS, tz: TZ }), [])
  assert.deepEqual(taskFacts({ tasks: [], now: NOW_TASKS, tz: TZ }), [])
})

test('tasks due today are one fact, not one notification each', () => {
  const facts = taskFacts({
    tasks: [
      task({ id: 'a', title: 'Call the dentist', dueDate: '2026-09-15' }),
      task({ id: 'b', title: 'Renew domain', dueDate: '2026-09-15' }),
      task({ id: 'c', title: 'Email Nolan', dueDate: '2026-09-15' }),
      task({ id: 'd', title: 'Book flights', dueDate: '2026-09-15' }),
    ],
    now: NOW_TASKS, tz: TZ,
  })
  const due = facts.filter((f) => f.kind === 'task.due-today')
  assert.equal(due.length, 1)
  assert.equal(due[0].title, '4 tasks due today')
  assert.match(due[0].body, /Call the dentist, Renew domain, Email Nolan, \+1 more/)
})

test('a single task due today is named outright', () => {
  const [fact] = taskFacts({
    tasks: [task({ title: 'Call the dentist', dueDate: '2026-09-15', area: 'Ventures', ventureTag: 'Acme' })],
    now: NOW_TASKS, tz: TZ,
  })
  assert.equal(fact.title, 'Due today: Call the dentist')
  assert.equal(fact.body, 'Call the dentist · Acme')
})

test('done, archived and deleted tasks are not due today', () => {
  const facts = taskFacts({
    tasks: [
      task({ id: 'a', status: 'done', dueDate: '2026-09-15' }),
      task({ id: 'b', dueDate: '2026-09-15', completedAt: '2026-09-15T10:00:00Z' }),
      task({ id: 'c', dueDate: '2026-09-15', archivedAt: '2026-09-14T10:00:00Z' }),
      task({ id: 'd', dueDate: '2026-09-15', deletedAt: '2026-09-14T10:00:00Z' }),
    ],
    now: NOW_TASKS, tz: TZ,
  })
  assert.deepEqual(facts, [])
})

test('a snoozed task is not nudged about — he already said not now', () => {
  const snoozed = taskFacts({
    tasks: [task({ dueDate: '2026-09-15', snoozedUntil: '2026-09-20T09:00:00Z' })],
    now: NOW_TASKS, tz: TZ,
  })
  assert.deepEqual(snoozed, [])
  // Once the snooze has run out it counts again.
  const woken = taskFacts({
    tasks: [task({ dueDate: '2026-09-15', snoozedUntil: '2026-09-14T09:00:00Z' })],
    now: NOW_TASKS, tz: TZ,
  })
  assert.equal(woken.length, 1)
})

test('one day late is ordinary life; two days is overdue', () => {
  const oneDay = taskFacts({
    tasks: [task({ dueDate: '2026-09-14' })], now: NOW_TASKS, tz: TZ,
  })
  assert.equal(oneDay.find((f) => f.kind === 'task.overdue'), undefined)

  const [overdue] = taskFacts({
    tasks: [task({ title: 'Renew domain', dueDate: '2026-09-13' })], now: NOW_TASKS, tz: TZ,
  }).filter((f) => f.kind === 'task.overdue')
  assert.equal(overdue.title, 'Overdue: Renew domain')
  assert.match(overdue.body, /2 days past due/)
  assert.equal(overdue.category, 'task.overdue')
})

test('overdue reports the oldest, and due-today stays a separate fact', () => {
  const facts = taskFacts({
    tasks: [
      task({ id: 'a', title: 'Ancient', dueDate: '2026-08-30' }),
      task({ id: 'b', title: 'Stale', dueDate: '2026-09-10' }),
      task({ id: 'c', title: 'Today', dueDate: '2026-09-15' }),
    ],
    now: NOW_TASKS, tz: TZ,
  })
  assert.deepEqual(facts.map((f) => f.kind).sort(), ['task.due-today', 'task.overdue'])
  assert.match(facts.find((f) => f.kind === 'task.overdue').body, /16 days past due/)
})

test('task facts expire tonight, because tomorrow they are a different fact', () => {
  const [fact] = taskFacts({ tasks: [task({ dueDate: '2026-09-15' })], now: NOW_TASKS, tz: TZ })
  assert.ok(fact.expiresAt > NOW_TASKS)
  assert.ok(fact.expiresAt < at('2026-09-16 00:00'))
})

test('collectors survive empty and malformed input without throwing', () => {
  assert.deepEqual(parsePeople(''), [])
  assert.deepEqual(parsePeople(null), [])
  assert.deepEqual(birthdayFacts({ people: [], now: at('2026-09-11 07:15'), tz: TZ }), [])
  assert.deepEqual(habitFacts({ now: at('2026-09-11 07:15'), tz: TZ }), [])
  assert.deepEqual(metricFacts({ now: at('2026-09-11 07:15'), tz: TZ }), [])
})

test('facts carry an expiry that matches what they are about', () => {
  const now = at('2026-09-11 18:00')
  const habits = habitFacts({ habits: HABITS, entries: ENTRIES, now, tz: TZ })
  // A streak nudge is worthless after midnight tonight.
  const journal = habits.find((f) => f.subject === 'journal')
  assert.equal(new Date(journal.expiresAt).toISOString() > new Date(now).toISOString(), true)
  assert.ok(journal.expiresAt < at('2026-09-12 00:00'))
  // A weekly target is still worth saying tomorrow and the day after — the week runs
  // to Sunday.
  const business = habits.find((f) => f.subject === 'business')
  assert.ok(business.expiresAt > at('2026-09-13 00:00'))
  assert.ok(business.expiresAt < at('2026-09-14 00:00'))
})

test('a birthday fact expires with the day it is about', () => {
  const now = at('2026-09-11 07:15')
  const [birthday] = birthdayFacts({ people: parsePeople(PEOPLE_MD), now, tz: TZ })
  assert.ok(birthday.expiresAt > now)
  assert.ok(birthday.expiresAt < at('2026-09-12 00:00'))
})

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

const goal = (over = {}) => ({
  id: 'g1',
  title: 'Ride 150 miles',
  complete: false,
  periodState: 'active',
  daysLeft: 3,
  postponedCount: 0,
  period: { type: 'week', key: '2026-09-13', label: 'Sep 13 – 19, 2026', start: '2026-09-13', end: '2026-09-19' },
  progress: { fraction: 0.4, percent: 40, subGoalsDone: 0, subGoalsTotal: 0, complete: false },
  ...over,
})

const GOAL_NOW = Date.parse('2026-09-17T22:00:00Z')
const GOAL_TZ = 'America/New_York'

test('goals raise nothing until there is something to say', () => {
  assert.deepEqual(goalFacts({ goals: null, now: GOAL_NOW, tz: GOAL_TZ }), [], 'unread is silent')
  assert.deepEqual(goalFacts({ goals: [], now: GOAL_NOW, tz: GOAL_TZ }), [])
  assert.deepEqual(goalFacts({ goals: [goal({ complete: true })], now: GOAL_NOW, tz: GOAL_TZ }), [])
  // Mid-week and mid-progress is just a normal Tuesday.
  assert.deepEqual(goalFacts({ goals: [goal({ daysLeft: 5, progress: { fraction: 0.4, percent: 40 } })], now: GOAL_NOW, tz: GOAL_TZ }), [])
})

test('an unreadable connector is unknown progress, never a nudge', () => {
  // A metric nobody could read must not become "you are at 0% with a day left".
  const facts = goalFacts({
    goals: [goal({ daysLeft: 1, progress: { fraction: null, percent: null } })],
    now: GOAL_NOW, tz: GOAL_TZ,
  })
  assert.deepEqual(facts, [])
})

test('nearly there with time left is the nudge that finishes something', () => {
  const [fact] = goalFacts({ goals: [goal({ daysLeft: 2, progress: { fraction: 0.86, percent: 86 } })], now: GOAL_NOW, tz: GOAL_TZ })
  assert.equal(fact.kind, 'goal.near-complete')
  assert.equal(fact.category, 'goal.nearcomplete')
  assert.equal(fact.slot, 'evening')
  assert.match(fact.title, /86%/)
  assert.ok(fact.expiresAt, 'worthless tomorrow, so it expires tonight')
  assert.ok(fact.resolvedTitle)
  assert.equal(fact.url, '/productivity/goals')
})

test('the last day of a goal that is not close still gets said', () => {
  const [fact] = goalFacts({ goals: [goal({ daysLeft: 1, progress: { fraction: 0.2, percent: 20 } })], now: GOAL_NOW, tz: GOAL_TZ })
  assert.equal(fact.kind, 'goal.last-day')
  assert.equal(fact.category, 'goal.slipping')
  assert.ok(fact.expiresAt)
})

test('an expired goal says plainly that nothing will move it', () => {
  const [fact] = goalFacts({ goals: [goal({ periodState: 'expired', daysLeft: 0 })], now: GOAL_NOW, tz: GOAL_TZ })
  assert.equal(fact.kind, 'goal.expired')
  assert.equal(fact.category, 'goal.slipping')
  assert.match(fact.body, /Nothing moves it for you/)
  assert.ok(!fact.expiresAt, 'it stays true until he acts on it')
})

test('a goal moved three times becomes a question, and outranks everything else about it', () => {
  const facts = goalFacts({
    goals: [goal({ postponedCount: 4, periodState: 'expired', daysLeft: 0 })],
    now: GOAL_NOW, tz: GOAL_TZ,
  })
  assert.equal(facts.length, 1, 'one goal never produces two nudges')
  assert.equal(facts[0].kind, 'goal.repeatedly-postponed')
  assert.match(facts[0].body, /Is it still a goal\?/)
  // Salience climbs with each move, because the question gets more overdue.
  const harder = goalFacts({ goals: [goal({ postponedCount: 6 })], now: GOAL_NOW, tz: GOAL_TZ })
  assert.ok(harder[0].salience > facts[0].salience)
  assert.ok(harder[0].salience <= 90)
})

test('every goal fact carries what the planner needs', () => {
  const facts = goalFacts({
    goals: [
      goal({ id: 'a', postponedCount: 3 }),
      goal({ id: 'b', periodState: 'expired', daysLeft: 0 }),
      goal({ id: 'c', daysLeft: 1, progress: { fraction: 0.9, percent: 90 } }),
    ],
    now: GOAL_NOW, tz: GOAL_TZ,
  })
  assert.equal(facts.length, 3)
  for (const fact of facts) {
    assert.ok(fact.kind && fact.category && fact.slot && fact.subject && fact.title && fact.body)
    assert.equal(typeof fact.salience, 'number')
    assert.ok(fact.revalidate?.collector === 'goals' && fact.revalidate.factKey)
    assert.ok(CATEGORY_NAMES.includes(fact.category), `${fact.category} must be a real category`)
  }
})

test('every fact a collector can produce fits on a lock screen', () => {
  // The bug this pins: iOS shows ~34 characters of the title and cuts the end,
  // so "One more and Help the Business is done for the week" arrived as "One
  // more and Help the Bus…" with the number nowhere in sight.
  const now = at('2026-09-11 18:00')
  const longHabits = [
    { id: 'j', name: 'Journal every single day without fail', cadence: 'daily', target: 1 },
    { id: 'b', name: 'Help the Business and the side ventures', cadence: 'weekly', target: 4 },
    { id: 's', name: 'Sleep performance overnight', cadence: 'daily', target: 1, metric: { goal: 85, direction: 'higher', unit: '%' } },
  ]
  const days = {}
  for (let i = 1; i <= 8; i++) {
    const d = new Date(Date.UTC(2026, 8, 11) - i * 86_400_000).toISOString().slice(0, 10)
    days[d] = { j: { count: 1 }, b: { count: 1 }, s: { count: 1, value: 60 } }
  }

  const facts = [
    ...habitFacts({ habits: longHabits, entries: days, now, tz: TZ }),
    ...metricFacts({ habits: longHabits, entries: days, now, tz: TZ }),
    ...birthdayFacts({ people: parsePeople(PEOPLE_MD), now: at('2026-09-11 07:15'), tz: TZ }),
    ...taskFacts({
      tasks: [{ id: 'a', title: 'Renew the domain before it lapses on Friday', status: 'todo', dueDate: '2026-09-11' }],
      now, tz: TZ,
    }),
  ]

  assert.ok(facts.length >= 4, 'expected the fixture to produce facts')
  for (const f of facts) {
    assert.ok(f.title.length <= TITLE_MAX, `title too long (${f.title.length}): ${f.title}`)
    if (f.resolvedTitle) {
      assert.ok(f.resolvedTitle.length <= TITLE_MAX, `resolvedTitle too long: ${f.resolvedTitle}`)
    }
    // The content has to be somewhere, and if it is not in the title it must be
    // in the body.
    assert.ok(f.body && f.body.length > 0, `no body to carry the detail: ${f.title}`)
  }
})
